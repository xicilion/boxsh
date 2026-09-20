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
    """Raised for tool failures and protocol problems.

    Tool failures carry the stable error code from the server in `code`
    (one of E_INVALID_ARGUMENT, E_NOT_FOUND, E_NOT_TEXT, E_NOT_IMAGE,
    E_UNSUPPORTED_FORMAT, E_TOO_LARGE, E_TIMEOUT, E_SANDBOX, E_INTERNAL)
    plus the optional machine-readable `detail`.
    """

    def __init__(self, message: str, code: Optional[str] = None,
                 detail: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail


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
    #: The command was killed by a timeout (its stderr ends with ``timeout``
    #: and the MCP result carries ``isError: true``).
    timed_out: bool = False
    #: A stream lost bytes: the 10 MiB cap or the ``--max-result-bytes`` budget.
    truncated: bool = False


@dataclass(frozen=True)
class EditOperation:
    old_text: str
    new_text: str


EditInput = Union[EditOperation, Tuple[str, str], Mapping[str, str]]


@dataclass(frozen=True)
class ReadResult:
    """Result of the read tool (text files only).

    Images and other binary files are rejected by the server — use view_image
    for images.
    """

    content: str
    encoding: str
    mime_type: str
    line_count: Optional[int] = None
    truncated: Optional[bool] = None
    file_size: Optional[int] = None
    total_lines: Optional[int] = None
    next_offset: Optional[int] = None
    empty_reason: Optional[str] = None


@dataclass(frozen=True)
class ViewImageResult:
    """Result of the view_image tool (animated sources give their first frame).

    Formats outside the model-native set (jpeg/png/gif/webp) are converted to
    PNG/JPEG before being returned — ``converted`` is True in that case.
    """

    data: str          # base64-encoded image payload
    mime_type: str     # MIME type of the returned image
    width: int
    height: int
    original_width: int
    original_height: int
    was_resized: bool
    size: int          # size of the original file in bytes
    animated: bool     # source was animated; only the first frame is returned
    text: str          # model-facing text, e.g. "[Image: image/png, 200x133]"
    converted: bool = False  # re-encoded (e.g. BMP/TIFF -> PNG/JPEG); see text


@dataclass(frozen=True)
class TerminalReadOptions:
    """How a terminal call should wait and where it should read from."""

    #: Raw-log cursor from a previous result's ``next_cursor`` (0 = everything
    #: still retained).  Passing one switches the call to the lossless stream
    #: channel instead of the rendered screen.
    cursor: Optional[int] = None
    #: How long to wait before returning, in milliseconds.
    wait_ms: Optional[int] = None
    #: "output" (default) or "exit" (wait for the process to finish).
    wait_for: Optional[str] = None

    def apply(self, arguments: Dict[str, Any]) -> None:
        if self.cursor is not None:
            arguments["cursor"] = self.cursor
        if self.wait_ms is not None:
            arguments["wait_ms"] = self.wait_ms
        if self.wait_for is not None:
            arguments["wait_for"] = self.wait_for


@dataclass(frozen=True)
class RunInTerminalOptions(TerminalReadOptions):
    cols: Optional[int] = None
    rows: Optional[int] = None


@dataclass(frozen=True)
class TerminalOutputResult:
    output: str
    exited: bool
    exit_code: Optional[int]
    # Raw-stream channel (present when the call asked for it): bytes in
    # [first_cursor, next_cursor), with truncated_before/dropped_bytes telling
    # the caller when earlier output is no longer retained.
    total_bytes: Optional[int] = None
    stream: Optional[str] = None
    first_cursor: Optional[int] = None
    next_cursor: Optional[int] = None
    truncated_before: Optional[bool] = None
    dropped_bytes: Optional[int] = None
    # True when the session produced more lines than the screen can show.
    screen_partial: Optional[bool] = None
    # Exit code of the command just submitted (send_to_terminal with capture_status).
    command_exit_code: Optional[int] = None


@dataclass(frozen=True)
class RunInTerminalResult(TerminalOutputResult):
    #: Session id (the client always fills this in).
    id: str = ""


@dataclass(frozen=True)
class TerminalSession:
    id: str
    command: str
    alive: bool
    cols: int
    rows: int
    exited: bool = False
    exit_code: Optional[int] = None
    total_bytes: Optional[int] = None
    retained_bytes: Optional[int] = None
    truncated: Optional[bool] = None
    age_ms: Optional[int] = None
    idle_ms: Optional[int] = None


@dataclass(frozen=True)
class BashExecOptions:
    on_data: Optional[Callable[[bytes], None]] = None
    signal: Any = None
    timeout: Optional[int] = None


class BashOperations(Protocol):
    def exec(self, command: str, cwd: PathLike, options: Optional[BashExecOptions] = None) -> ExecResult:
        ...


def _terminal_result(structured: Mapping[str, Any]) -> Dict[str, Any]:
    """Map a terminal tool payload onto the TerminalOutputResult fields."""
    exit_code = structured.get("exit_code")
    mapped: Dict[str, Any] = {
        "output": str(structured.get("output", "")),
        "exited": bool(structured.get("exited", False)),
        "exit_code": exit_code if isinstance(exit_code, int) else None,
    }
    for wire, field in (
        ("total_bytes", "total_bytes"),
        ("stream", "stream"),
        ("first_cursor", "first_cursor"),
        ("next_cursor", "next_cursor"),
        ("truncated_before", "truncated_before"),
        ("dropped_bytes", "dropped_bytes"),
        ("screen_partial", "screen_partial"),
        ("command_exit_code", "command_exit_code"),
    ):
        if wire in structured:
            mapped[field] = structured[wire]
    return mapped


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
        structured = result.get("structuredContent")
        code = None
        detail = None
        message = ""
        if isinstance(structured, Mapping):
            code = structured.get("code") if isinstance(structured.get("code"), str) else None
            detail = structured.get("detail")
            message = str(structured.get("message", ""))
        if not message:
            content = result.get("content")
            if isinstance(content, list):
                text_chunks = []
                for chunk in content:
                    if isinstance(chunk, Mapping) and chunk.get("type") == "text":
                        text_chunks.append(str(chunk.get("text", "")))
                message = "\n".join(part for part in text_chunks if part)
        raise BoxshClientError(message or "tool error", code=code, detail=detail)

    @staticmethod
    def _text_of(result: Mapping[str, Any]) -> str:
        """Model-facing text: the concatenated text content blocks."""
        content = result.get("content")
        if not isinstance(content, list):
            return ""
        return "\n".join(
            str(chunk.get("text", ""))
            for chunk in content
            if isinstance(chunk, Mapping) and chunk.get("type") == "text"
        )

    @staticmethod
    def _images_of(result: Mapping[str, Any]) -> List[Mapping[str, Any]]:
        content = result.get("content")
        if not isinstance(content, list):
            return []
        return [c for c in content if isinstance(c, Mapping) and c.get("type") == "image"]

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
            timed_out=structured.get("timed_out") is True,
            truncated=(structured.get("stdout_truncated") is True
                       or structured.get("stderr_truncated") is True
                       or structured.get("result_truncated") is True),
        )

    def read(self, file_path: PathLike, offset: Optional[int] = None, limit: Optional[int] = None) -> ReadResult:
        arguments: Dict[str, Any] = {"path": _path_str(file_path)}
        if offset is not None:
            arguments["offset"] = offset
        if limit is not None:
            arguments["limit"] = limit

        result = self._send("tools/call", {"name": "read", "arguments": arguments})
        structured = self._tool_result(result)
        return ReadResult(
            content=self._text_of(result),
            encoding=str(structured.get("encoding", "text")),
            mime_type=str(structured.get("mime_type", "")),
            line_count=structured.get("line_count") if isinstance(structured.get("line_count"), int) else None,
            truncated=structured.get("truncated") if isinstance(structured.get("truncated"), bool) else None,
            file_size=structured.get("file_size") if isinstance(structured.get("file_size"), int) else None,
            total_lines=structured.get("total_lines") if isinstance(structured.get("total_lines"), int) else None,
            next_offset=structured.get("next_offset") if isinstance(structured.get("next_offset"), int) else None,
            empty_reason=structured.get("empty_reason") if isinstance(structured.get("empty_reason"), str) else None,
        )

    def view_image(self, file_path: PathLike, detail: Optional[str] = None) -> ViewImageResult:
        """View an image file (png, jpeg, gif, bmp, tiff, webp).

        detail="low" returns a 512px preview instead of the default 2000px.
        Animated GIF/APNG/WebP sources are re-encoded to their first frame.
        Formats outside the model-native set (jpeg/png/gif/webp) are converted
        to PNG/JPEG (``converted=True``), so the returned payload is always
        something multimodal models can ingest.  Other image formats
        (avif, heic, jxl, ...) raise BoxshClientError with code
        E_UNSUPPORTED_FORMAT.
        """
        arguments: Dict[str, Any] = {"path": _path_str(file_path)}
        if detail is not None:
            arguments["detail"] = detail

        result = self._send("tools/call", {"name": "view_image", "arguments": arguments})
        structured = self._tool_result(result)
        images = self._images_of(result)
        image = images[0] if images else {}
        return ViewImageResult(
            data=str(image.get("data", "")),
            mime_type=str(image.get("mimeType", structured.get("mime_type", ""))),
            width=int(structured.get("width", 0)),
            height=int(structured.get("height", 0)),
            original_width=int(structured.get("original_width", 0)),
            original_height=int(structured.get("original_height", 0)),
            was_resized=bool(structured.get("was_resized", False)),
            size=int(structured.get("size", 0)),
            animated=bool(structured.get("animated", False)),
            converted=bool(structured.get("converted", False)),
            text=self._text_of(result),
        )

    def write(self, file_path: PathLike, content: str) -> None:
        self._tool_result(
            self._send("tools/call", {"name": "write", "arguments": {"path": _path_str(file_path), "content": content}})
        )

    def edit(self, file_path: PathLike, edits: Sequence[EditInput]) -> None:
        serialized_edits = [_serialize_edit(edit) for edit in edits]
        self._tool_result(
            self._send(
                "tools/call",
                {"name": "edit", "arguments": {"path": _path_str(file_path), "edits": serialized_edits}},
            )
        )

    def run_in_terminal(self, command: str, opts: Optional[RunInTerminalOptions] = None) -> RunInTerminalResult:
        opts = opts or RunInTerminalOptions()
        arguments: Dict[str, Any] = {"command": command}
        if opts.cols is not None:
            arguments["cols"] = opts.cols
        if opts.rows is not None:
            arguments["rows"] = opts.rows
        opts.apply(arguments)

        structured = self._tool_result(
            self._send("tools/call", {"name": "run_in_terminal", "arguments": arguments})
        )
        return RunInTerminalResult(id=str(structured.get("id", "")), **_terminal_result(structured))

    def send_to_terminal(
        self,
        terminal_id: str,
        command: str = "",
        opts: Optional[TerminalReadOptions] = None,
        capture_status: bool = False,
        signal: Optional[str] = None,
    ) -> TerminalOutputResult:
        """Write to a session's stdin (and/or signal it) and read the result.

        With ``capture_status=True`` the text is submitted as a shell command
        line and the result carries ``command_exit_code`` — the exit code of
        that command (shell sessions only).

        ``signal`` is delivered to the session's foreground job and to the
        shell's own process group: ``"INT"`` aborts what is running, while a
        raw ETX byte (0x03) only reaches the foreground job, like a physical
        Ctrl-C.  ``"KILL"`` ends the session (an interactive shell ignores
        SIGTERM/SIGQUIT by POSIX).
        """
        arguments: Dict[str, Any] = {"id": terminal_id}
        if command:
            arguments["command"] = command
        if capture_status:
            arguments["capture_status"] = True
        if signal:
            arguments["signal"] = signal
        (opts or TerminalReadOptions()).apply(arguments)
        structured = self._tool_result(
            self._send("tools/call", {"name": "send_to_terminal", "arguments": arguments})
        )
        return TerminalOutputResult(**_terminal_result(structured))

    def get_terminal_output(
        self, terminal_id: str, opts: Optional[TerminalReadOptions] = None
    ) -> TerminalOutputResult:
        """Read from a session.

        Without a cursor this returns the rendered screen; with one it returns
        the raw byte delta from that position (``cursor=0`` = everything still
        retained), which is how output that scrolled off the screen is recovered.
        """
        arguments: Dict[str, Any] = {"id": terminal_id}
        (opts or TerminalReadOptions()).apply(arguments)
        structured = self._tool_result(
            self._send("tools/call", {"name": "get_terminal_output", "arguments": arguments})
        )
        return TerminalOutputResult(**_terminal_result(structured))

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

    def list_terminals(self, include_exited: bool = False) -> List[TerminalSession]:
        arguments: Dict[str, Any] = {}
        if include_exited:
            arguments["include_exited"] = True
        structured = self._tool_result(
            self._send("tools/call", {"name": "list_terminals", "arguments": arguments})
        )
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
                    exited=bool(session.get("exited", False)),
                    exit_code=session.get("exit_code"),
                    total_bytes=session.get("total_bytes"),
                    retained_bytes=session.get("retained_bytes"),
                    truncated=session.get("truncated"),
                    age_ms=session.get("age_ms"),
                    idle_ms=session.get("idle_ms"),
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