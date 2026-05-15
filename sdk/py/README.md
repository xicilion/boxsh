# boxsh-py

Python SDK for [boxsh](../../README.md) - a sandboxed POSIX shell with OS-native isolation and copy-on-write overlay filesystem.

`boxsh-py` lets you drive a long-lived `boxsh` RPC process from Python: execute shell commands, read and write files, perform search-and-replace edits, and manage persistent terminal sessions.

The API is intentionally Python-first: it accepts `pathlib.Path` anywhere a path is expected, uses snake_case names, and returns small dataclasses rather than raw dictionaries.

Requirements: Python >= 3.9, Linux or macOS, and a `boxsh` binary on `PATH` or in the `BOXSH` environment variable.

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

from boxsh_py import BoxshClient

with BoxshClient() as client:
    output = Path("/workspace/output.txt")
    text = client.read(Path("/workspace/src/main.cpp"))
    print(text.content)

    client.write(output, "hello\n")

    diff = client.edit(output, [("hello", "world")])
    print(diff.diff)
```

## Terminal sessions

```python
from boxsh_py import BoxshClient

with BoxshClient() as client:
    session = client.run_in_terminal("bash")
    print(session.id)

    output = client.send_to_terminal(session.id, "echo hello\n")
    print(output.output)

    for update in client.iter_terminal_output(session.id):
        print(update.output, end="")
        if update.exited:
            print("exit:", update.exit_code)

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