from __future__ import annotations

from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import Any, Callable, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple, Union
import json
import os
import shutil
import subprocess


PathLike = Union[str, os.PathLike[str]]


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


class BoxshClientError(RuntimeError):
    pass


@dataclass(frozen=True)
class CowBind:
    src: PathLike
    dst: PathLike


@dataclass(frozen=True)
class ReadOnlyBind:
    path: PathLike


@dataclass(frozen=True)
class ReadWriteBind:
    path: PathLike


CowBindOption = CowBind
PathBindOption = Union[ReadOnlyBind, ReadWriteBind]
BoxshBindOption = Union[CowBind, ReadOnlyBind, ReadWriteBind, Mapping[str, Any]]


@dataclass(frozen=True)
class BoxshClientOptions:
    boxsh_path: Optional[PathLike] = None
    workers: int = 1
    sandbox: bool = False
    new_net_ns: bool = False
    binds: Optional[Sequence[BoxshBindOption]] = None


@dataclass(frozen=True)
class ExecResult:
    exit_code: Optional[int]
    stdout: str
    stderr: str


@dataclass(frozen=True)
class EditOperation:
    old_text: str
    new_text: str


EditInput = Union[EditOperation, Tuple[str, str], Mapping[str, str]]


@dataclass(frozen=True)
class EditResult:
    diff: str
    first_changed_line: int


@dataclass(frozen=True)
class ReadResult:
    content: str
    encoding: str
    mime_type: str
    line_count: Optional[int] = None
    truncated: Optional[bool] = None
    size: Optional[int] = None


@dataclass(frozen=True)
class RunInTerminalOptions:
    explanation: Optional[str] = None
    goal: Optional[str] = None
    cols: Optional[int] = None
    rows: Optional[int] = None


@dataclass(frozen=True)
class TerminalOutputResult:
    output: str
    exited: bool
    exit_code: Optional[int]


@dataclass(frozen=True)
class RunInTerminalResult(TerminalOutputResult):
    id: str


@dataclass(frozen=True)
class TerminalSession:
    id: str
    command: str
    alive: bool
    cols: int
    rows: int


@dataclass(frozen=True)
class BashExecOptions:
    on_data: Optional[Callable[[bytes], None]] = None
    signal: Any = None
    timeout: Optional[int] = None


class BashOperations(Protocol):
    def exec(self, command: str, cwd: PathLike, options: Optional[BashExecOptions] = None) -> ExecResult:
        ...


class _PendingResponse:
    def __init__(self) -> None:
        self.event = Event()
        self.result: Any = None
        self.error: Optional[BaseException] = None


class BoxshClient:
    def __init__(self, options: Optional[BoxshClientOptions] = None, **kwargs: Any) -> None:
        if options is None:
            options = BoxshClientOptions(**kwargs)
        elif kwargs:
            raise TypeError("Pass either BoxshClientOptions or keyword arguments, not both")

        boxsh = _path_str(options.boxsh_path or os.environ.get("BOXSH") or "boxsh")
        args = [boxsh, "--rpc", "--workers", str(options.workers)]

        if options.sandbox:
            args.append("--sandbox")
        if options.new_net_ns:
            args.append("--new-net-ns")
        if options.binds:
            for bind in options.binds:
                args.extend(["--bind", self._format_bind(bind)])

        try:
            self._proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=None,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError as exc:
            raise BoxshClientError("boxsh binary not found") from exc

        assert self._proc.stdin is not None
        assert self._proc.stdout is not None

        self._stdin = self._proc.stdin
        self._stdout = self._proc.stdout
        self._closed = False
        self._id_counter = 0
        self._id_lock = Lock()
        self._write_lock = Lock()
        self._pending_lock = Lock()
        self._pending: Dict[str, _PendingResponse] = {}
        self._reader = Thread(target=self._read_loop, name="boxsh-py-reader", daemon=True)
        self._reader.start()

    def _format_bind(self, bind: BoxshBindOption) -> str:
        if isinstance(bind, CowBind):
            return f"cow:{_path_str(bind.src)}:{_path_str(bind.dst)}"
        if isinstance(bind, ReadOnlyBind):
            return f"ro:{_path_str(bind.path)}"
        if isinstance(bind, ReadWriteBind):
            return f"wr:{_path_str(bind.path)}"
        if isinstance(bind, Mapping):
            mode = bind.get("mode")
            if mode == "cow":
                return f"cow:{_path_str(bind['src'])}:{_path_str(bind['dst'])}"
            return f"{mode}:{_path_str(bind['path'])}"
        raise TypeError(f"Unsupported bind value: {bind!r}")

    def _next_id(self) -> str:
        with self._id_lock:
            self._id_counter += 1
            return str(self._id_counter)

    def _read_loop(self) -> None:
        try:
            for line in self._stdout:
                trimmed = line.strip()
                if not trimmed:
                    continue
                try:
                    response = json.loads(trimmed)
                except json.JSONDecodeError:
                    continue
                response_id = str(response.get("id", ""))
                with self._pending_lock:
                    pending = self._pending.pop(response_id, None)
                if pending is None:
                    continue
                if response.get("error"):
                    error = response["error"]
                    message = error.get("message") if isinstance(error, Mapping) else "unknown error"
                    pending.error = BoxshClientError(message or "unknown error")
                else:
                    pending.result = response.get("result")
                pending.event.set()
        except ValueError:
            pass
        finally:
            if not self._closed:
                self._fail_all(BoxshClientError("boxsh process exited unexpectedly"))

    def _fail_all(self, error: BaseException) -> None:
        with self._pending_lock:
            pending_items = list(self._pending.values())
            self._pending.clear()
        for pending in pending_items:
            pending.error = error
            pending.event.set()

    def _check_closed(self) -> None:
        if self._closed:
            raise BoxshClientError("BoxshClient is closed")

    def _send(self, method: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
        self._check_closed()
        request_id = self._next_id()
        pending = _PendingResponse()
        with self._pending_lock:
            self._pending[request_id] = pending

        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}
        try:
            with self._write_lock:
                self._stdin.write(json.dumps(payload) + "\n")
                self._stdin.flush()
        except Exception as exc:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise BoxshClientError("failed to send request to boxsh") from exc

        pending.event.wait()
        if pending.error is not None:
            raise pending.error
        result = pending.result
        if isinstance(result, Mapping):
            return result
        return {}

    @staticmethod
    def _check_tool_error(result: Mapping[str, Any]) -> None:
        if not result.get("isError"):
            return
        content = result.get("content")
        if isinstance(content, list):
            text_chunks = []
            for chunk in content:
                if isinstance(chunk, Mapping) and chunk.get("type") == "text":
                    text_chunks.append(str(chunk.get("text", "")))
            message = "\n".join(part for part in text_chunks if part)
        else:
            message = "tool error"
        raise BoxshClientError(message or "tool error")

    @staticmethod
    def _tool_result(result: Mapping[str, Any]) -> Mapping[str, Any]:
        BoxshClient._check_tool_error(result)
        structured = result.get("structuredContent")
        return structured if isinstance(structured, Mapping) else {}

    def exec(self, cmd: str, cwd: Optional[PathLike] = None, timeout: Optional[int] = None) -> ExecResult:
        command = f"(cd {shell_quote(_path_str(cwd))} && {cmd})" if cwd is not None else cmd
        arguments: Dict[str, Any] = {"command": command}
        if timeout is not None and timeout > 0:
            arguments["timeout"] = timeout

        result = self._send("tools/call", {"name": "bash", "arguments": arguments})
        structured = result.get("structuredContent") if isinstance(result, Mapping) else None
        if not isinstance(structured, Mapping):
            structured = {}
        exit_code = structured.get("exit_code")
        return ExecResult(
            exit_code=exit_code if isinstance(exit_code, int) else None,
            stdout=str(structured.get("stdout", "")),
            stderr=str(structured.get("stderr", "")),
        )

    def read(self, file_path: PathLike, offset: Optional[int] = None, limit: Optional[int] = None) -> ReadResult:
        arguments: Dict[str, Any] = {"path": _path_str(file_path)}
        if offset is not None:
            arguments["offset"] = offset
        if limit is not None:
            arguments["limit"] = limit

        structured = self._tool_result(self._send("tools/call", {"name": "read", "arguments": arguments}))
        return ReadResult(
            content=str(structured.get("content", "")),
            encoding=str(structured.get("encoding", "text")),
            mime_type=str(structured.get("mime_type", "")),
            line_count=structured.get("line_count") if isinstance(structured.get("line_count"), int) else None,
            truncated=structured.get("truncated") if isinstance(structured.get("truncated"), bool) else None,
            size=structured.get("size") if isinstance(structured.get("size"), int) else None,
        )

    def write(self, file_path: PathLike, content: str) -> None:
        self._tool_result(
            self._send("tools/call", {"name": "write", "arguments": {"path": _path_str(file_path), "content": content}})
        )

    def edit(self, file_path: PathLike, edits: Sequence[EditInput]) -> EditResult:
        serialized_edits = [_serialize_edit(edit) for edit in edits]
        structured = self._tool_result(
            self._send(
                "tools/call",
                {"name": "edit", "arguments": {"path": _path_str(file_path), "edits": serialized_edits}},
            )
        )
        first_changed_line = structured.get("firstChangedLine")
        return EditResult(
            diff=str(structured.get("diff", "")),
            first_changed_line=first_changed_line if isinstance(first_changed_line, int) else 0,
        )

    def run_in_terminal(self, command: str, opts: Optional[RunInTerminalOptions] = None) -> RunInTerminalResult:
        opts = opts or RunInTerminalOptions()
        arguments: Dict[str, Any] = {"command": command}
        if opts.explanation:
            arguments["explanation"] = opts.explanation
        if opts.goal:
            arguments["goal"] = opts.goal
        if opts.cols is not None:
            arguments["cols"] = opts.cols
        if opts.rows is not None:
            arguments["rows"] = opts.rows

        structured = self._tool_result(
            self._send("tools/call", {"name": "run_in_terminal", "arguments": arguments})
        )
        exit_code = structured.get("exit_code")
        return RunInTerminalResult(
            id=str(structured.get("id", "")),
            output=str(structured.get("output", "")),
            exited=bool(structured.get("exited", False)),
            exit_code=exit_code if isinstance(exit_code, int) else None,
        )

    def send_to_terminal(self, terminal_id: str, command: str) -> TerminalOutputResult:
        structured = self._tool_result(
            self._send(
                "tools/call",
                {"name": "send_to_terminal", "arguments": {"id": terminal_id, "command": command}},
            )
        )
        exit_code = structured.get("exit_code")
        return TerminalOutputResult(
            output=str(structured.get("output", "")),
            exited=bool(structured.get("exited", False)),
            exit_code=exit_code if isinstance(exit_code, int) else None,
        )

    def get_terminal_output(self, terminal_id: str) -> TerminalOutputResult:
        structured = self._tool_result(
            self._send("tools/call", {"name": "get_terminal_output", "arguments": {"id": terminal_id}})
        )
        exit_code = structured.get("exit_code")
        return TerminalOutputResult(
            output=str(structured.get("output", "")),
            exited=bool(structured.get("exited", False)),
            exit_code=exit_code if isinstance(exit_code, int) else None,
        )

    def iter_terminal_output(self, terminal_id: str):
        while True:
            result = self.get_terminal_output(terminal_id)
            yield result
            if result.exited:
                return

    def kill_terminal(self, terminal_id: str) -> str:
        structured = self._tool_result(
            self._send("tools/call", {"name": "kill_terminal", "arguments": {"id": terminal_id}})
        )
        return str(structured.get("output", ""))

    def list_terminals(self) -> List[TerminalSession]:
        structured = self._tool_result(self._send("tools/call", {"name": "list_terminals", "arguments": {}}))
        sessions = structured.get("sessions")
        if not isinstance(sessions, list):
            return []

        output: List[TerminalSession] = []
        for session in sessions:
            if not isinstance(session, Mapping):
                continue
            output.append(
                TerminalSession(
                    id=str(session.get("id", "")),
                    command=str(session.get("command", "")),
                    alive=bool(session.get("alive", False)),
                    cols=int(session.get("cols", 0)),
                    rows=int(session.get("rows", 0)),
                )
            )
        return output

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._stdin.close()
        except Exception:
            pass
        try:
            self._proc.wait()
        finally:
            try:
                self._stdout.close()
            except Exception:
                pass
            self._reader.join(timeout=1)
            self._fail_all(BoxshClientError("BoxshClient is closed"))

    def terminate(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._fail_all(BoxshClientError("BoxshClient terminated"))
        self._proc.terminate()
        try:
            self._stdout.close()
        except Exception:
            pass
        self._reader.join(timeout=1)

    def __enter__(self) -> "BoxshClient":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()


class _ClientBackedBashOperations:
    def __init__(self, client: BoxshClient) -> None:
        self._client = client

    def exec(self, command: str, cwd: PathLike, options: Optional[BashExecOptions] = None) -> ExecResult:
        options = options or BashExecOptions()
        signal = options.signal
        if getattr(signal, "aborted", False):
            raise BoxshClientError("aborted")

        result = self._client.exec(command, cwd, options.timeout)
        output = result.stdout + result.stderr
        if output and options.on_data:
            options.on_data(output.encode())
        return result


def create_bash_operations(
    *, sandbox: bool = True, fallback: Optional[BashOperations] = None, boxsh_path: Optional[PathLike] = None
) -> BashOperations:
    resolved_path = boxsh_path or os.environ.get("BOXSH") or shutil.which("boxsh")
    if not resolved_path:
        if fallback is not None:
            return fallback
        raise BoxshClientError("boxsh binary not found and no fallback provided")

    client = BoxshClient(boxsh_path=resolved_path, sandbox=sandbox)
    return _ClientBackedBashOperations(client)


def _path_str(value: PathLike) -> str:
    return os.fspath(value)


def _serialize_edit(edit: EditInput) -> Dict[str, str]:
    if isinstance(edit, EditOperation):
        return {"oldText": edit.old_text, "newText": edit.new_text}
    if isinstance(edit, Mapping):
        old_text = edit.get("old_text", edit.get("oldText"))
        new_text = edit.get("new_text", edit.get("newText"))
        if old_text is None or new_text is None:
            raise TypeError(f"Unsupported edit mapping: {edit!r}")
        return {"oldText": str(old_text), "newText": str(new_text)}
    if isinstance(edit, tuple) and len(edit) == 2:
        old_text, new_text = edit
        return {"oldText": old_text, "newText": new_text}
    raise TypeError(f"Unsupported edit value: {edit!r}")