# boxsh-py

Python SDK for [boxsh](../../README.md) - a sandboxed POSIX shell with OS-native isolation and copy-on-write overlay filesystem.

`boxsh-py` lets you drive a long-lived `boxsh` RPC process from Python: execute shell commands, read and write files, perform search-and-replace edits, and manage persistent terminal sessions.

`client.exec(...)` returns an `ExecResult` with `exit_code`, `stdout`, `stderr`,
`timed_out` and `truncated`: a command killed by its timeout comes back with
`exit_code == -1` and `timed_out == True` (the MCP result underneath is
`isError: true`) and keeps whatever it had already printed, with `timeout`
appended to stderr.

The API is intentionally Python-first: it accepts `pathlib.Path` anywhere a path is expected, uses snake_case names, and returns small dataclasses rather than raw dictionaries.

Requirements: Python >= 3.9, Linux or macOS, and a `boxsh` binary on `PATH` or in the `BOXSH` environment variable.

The Python and Node.js SDKs are released together from this repository and share one version number (`boxsh-py` 4.0.0 == `boxsh.js` 4.0.0, both speaking the protocol of boxsh 5.6.0).

## Install

```sh
pip install boxsh-py
```

## Quick start

```python
from pathlib import Path

from boxsh_py import BoxshClient

with BoxshClient() as client:
    workspace = Path("/workspace")
    result = client.exec("echo hello", cwd=workspace)
    print(result.stdout)
```

## Shell commands

```python
from boxsh_py import BoxshClient

with BoxshClient(workers=4) as client:
    result = client.exec("ls -la", cwd="/workspace")
    print(result.exit_code)
    print(result.stdout)
```

## File operations

```python
from pathlib import Path

from boxsh_py import BoxshClient, BoxshClientError

with BoxshClient() as client:
    output = Path("/workspace/output.txt")
    text = client.read(Path("/workspace/src/main.cpp"))
    print(text.content)

    # Images go through view_image: base64 payload + metadata
    image = client.view_image(Path("/workspace/chart.png"))
    print(image.mime_type, image.width, image.height, image.was_resized)

    # Binary files are rejected with a stable error code
    try:
        client.read(Path("/workspace/archive.zip"))
    except BoxshClientError as err:
        print(err.code, err.detail)   # E_NOT_TEXT {'mime': 'application/zip', ...}

    client.write(output, "hello\n")

    client.edit(output, [("hello", "world")])
```

## Terminal sessions

```python
from boxsh_py import BoxshClient, RunInTerminalOptions, TerminalReadOptions

with BoxshClient() as client:
    session = client.run_in_terminal("bash")
    print(session.id)

    output = client.send_to_terminal(session.id, "echo hello\n")
    print(output.output)

    # Run a command line and get its exit code (persistent shell session)
    build = client.send_to_terminal(session.id, "make -j8\n", capture_status=True, opts=None)
    print(build.command_exit_code)

    # Stop what it is running, and the rest of that command line
    client.send_to_terminal(session.id, signal="INT")

    # Collect output that scrolled off the screen: cursor reads return deltas
    cursor = 0
    while True:
        chunk = client.get_terminal_output(session.id, TerminalReadOptions(cursor=cursor, wait_ms=1000))
        print(chunk.stream or "", end="")
        cursor = chunk.next_cursor
        if chunk.exited:
            break

    # One-shot command: one call, complete output, exit code
    one = client.run_in_terminal("seq 1 100", RunInTerminalOptions(wait_for="exit", wait_ms=20000))
    print(one.exited, one.exit_code, one.stream)
    # Exited sessions are hidden from list_terminals unless asked for
    sessions = client.list_terminals(include_exited=True)

    client.kill_terminal(session.id)
```

## Sandbox binds

```python
from pathlib import Path

from boxsh_py import BoxshClient, CowBind, ReadOnlyBind

base = Path("/repo")
upper = Path("/tmp/boxsh-overlay")

with BoxshClient(
    sandbox=True,
    binds=[
        CowBind(src=base, dst=upper),
        ReadOnlyBind(path=Path("/usr/share/zoneinfo")),
    ],
) as client:
    client.exec("git status", cwd=upper)
```

## Inspecting changes

```python
from boxsh_py import format_changes, get_changes

changes = get_changes(upper="/tmp/sandbox/dst", base="/home/user/myproject")
print(format_changes(changes))
```

## API

Public exports:

- `BoxshClient`
- `BoxshClientError`
- `BoxshClientOptions`
- `CowBind`
- `ReadOnlyBind`
- `ReadWriteBind`
- `EditOperation`
- `shell_quote`
- `get_changes`
- `format_changes`
- `create_bash_operations`