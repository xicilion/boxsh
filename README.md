# boxsh

A sandboxed POSIX shell with a concurrent JSON-line RPC mode, built on [dash 0.5.12](http://gondor.apana.org.au/~herbert/dash/).

boxsh is designed as a **programmable execution substrate** — a backend that an AI agent, build system, or orchestration layer can drive over a simple JSON protocol, with Linux namespace isolation baked in. The core use cases it is built for:

- **AI agent command sandbox** — give an agent a worker that can run arbitrary shell commands while constraining exactly what it can see and modify: mount only the directories it needs, block outbound network, isolate its PID tree.
- **Zero-cost directory forking** — overlay any directory as a copy-on-write workspace. The agent reads and writes freely; at the end of a session you inspect the diff in the upper layer and decide whether to commit or discard — no git index required, works on any directory.
- **Session checkpointing and branching** — freeze the current session's upper layer, stack new overlays on top to branch in two directions from the same point, and compare the results. You can also archive the upper layer for long-term storage.
- **Parallel isolated workers** — share one large read-only base (a node_modules tree, a Python venv, a compiled sysroot) across many workers, each with its own writable upper layer, all running concurrently without interfering.
- **Deployment / migration dry-runs** — run `make install`, a database migration, or a package upgrade on an overlay, inspect exactly which files changed in the upper layer, then decide whether to apply the change for real.

For a scenario-driven walkthrough with examples, see the **[Usage Guide](docs/usage.md)**.

---

## Features

| Feature | Details |
|---|---|
| **Linux namespace sandbox** | User, mount, network, and PID namespaces via direct syscalls — no external tools (`bwrap`, `newuidmap`) required |
| **Overlay filesystem** | Copy-on-write workspace over any read-only base; writes accumulate in a caller-managed upper layer and persist between commands |
| **Built-in file tools** | `read` (with offset/limit), `write`, and `edit` (multi-replacement matched against the original file, producing a unified diff) run on background threads — the event loop is never blocked |
| **JSON-line RPC** | Line-delimited JSON over stdin/stdout; responses stream back out of order as workers finish |
| **Pre-forked worker pool** | Configurable number of workers (`--workers N`); each worker is forked once and reused across requests |
| **Crash recovery** | If a worker is killed (timeout, segfault, OOM), the coordinator detects `POLLHUP`, returns an error response, and immediately respawns a replacement |
| **Per-request timeout** | `"timeout"` field in the request; enforced via `alarm(2)` inside the worker |
| **Bind mounts** | Selectively expose host paths (read-write or read-only) inside the sandbox |
| **Drop-in `/bin/sh`** | Shell mode delegates to embedded dash 0.5.12 — any script or flag that works with POSIX sh works here |
| **Single static binary** | dash, nlohmann/json, and libedit are vendored; the only runtime dependency is the Linux kernel |

---

## Overview

boxsh has two modes, plus a one-command sandbox shortcut:

| Mode | How to start | What it does |
|---|---|---|
| **Quick-try shell** | `boxsh --try` | Drop into a sandboxed root shell on your CWD; writes go to a temp upper layer — original directory untouched |
| **Shell mode** | `boxsh` (default) | Drop-in `dash` replacement — interactive shell, `-c`, script files |
| **RPC mode** | `boxsh --rpc` | Reads JSON requests from stdin, executes shell commands concurrently via a pre-forked worker pool, writes JSON responses to stdout |

In either mode, an optional Linux namespace sandbox can be enabled with `--sandbox`.

---

## Building

**Requirements:** CMake ≥ 3.16, GCC or Clang (C11 / C++17), Linux kernel ≥ 3.8.

```sh
cmake -B build
cmake --build build
# binary: build/boxsh
```

---

## Quick try

The fastest way to get started:

```sh
cd my-project
boxsh --try
```

This drops you into a **root shell inside a copy-on-write sandbox** over your current directory. Writes go to a temporary upper layer; your real directory is never modified.

```
$ boxsh --try
boxsh: changes will be saved in /tmp/boxsh-try-abc123/upper
# <sandboxed root shell — experiment freely>
$ rm important-file.txt
$ exit
$ ls important-file.txt   # still here on the host
important-file.txt
$ ls /tmp/boxsh-try-abc123/upper/
.wh.important-file.txt   # the whiteout lives here, not in your directory
```

The temp directory persists after exit so you can inspect or archive exactly what changed. `--try` is shorthand for `--sandbox --overlay CWD:upper:work:CWD` with auto-managed directories. See [Quick-try Mode](docs/usage.md#quick-try-mode) for the full reference.

---

## Shell mode

Delegates to the embedded dash interpreter. Any flag or script that works with `/bin/sh` works here.

```sh
boxsh                        # interactive shell (with line editing via libedit)
boxsh -c 'echo hello'        # run a command string
boxsh script.sh arg1 arg2    # run a script
```

Sandbox flags apply immediately before the shell starts:

```sh
boxsh --sandbox --new-net-ns -c 'curl example.com'  # network isolated
```

---

## RPC mode

```sh
boxsh --rpc [--workers N] [--shell PATH] [sandbox flags...]
```

boxsh pre-forks `N` worker processes (default 4), then reads newline-delimited JSON from stdin. Each request is dispatched to a free worker; responses are written to stdout as they complete — **not** in submission order.

### Shell command request

```json
{"id": "req1", "cmd": "echo hello", "timeout": 10}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | no | Arbitrary identifier, echoed back verbatim |
| `cmd` | string | **yes** | Shell command string (parsed by the embedded dash) |
| `timeout` | number | no | Kill the command after this many seconds (0 or absent = no limit) |
| `sandbox` | object | no | Per-request sandbox override (reserved; not yet implemented) |

### Shell command response

```json
{"id": "req1", "exit_code": 0, "stdout": "hello\n", "stderr": "", "duration_ms": 4}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Echoed from the request |
| `exit_code` | number | Exit status of the command |
| `stdout` | string | Captured standard output |
| `stderr` | string | Captured standard error |
| `duration_ms` | number | Wall-clock time in milliseconds |
| `error` | string | Present only on failure (parse error, worker crash); absent on success |

### Concurrency example

```sh
printf '%s\n' \
  '{"id":"slow","cmd":"sleep 0.5; echo slow"}' \
  '{"id":"fast","cmd":"echo fast"}' \
| boxsh --rpc --workers 2
# "fast" response arrives first, then "slow"
```

### Protocol notes

- Blank lines are silently ignored.
- Invalid JSON produces an error response with `"error"` set; boxsh continues reading.
- A request with neither `cmd` nor `tool` produces an error response.

---

## Built-in tools

In RPC mode, three file-operation tools execute directly in the coordinator process — no worker is needed. Use `"tool"` instead of `"cmd"`.

### Common fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | no | Identifier echoed back |
| `tool` | string | **yes** | `"read"`, `"write"`, or `"edit"` |
| `path` | string | **yes** | Path to the target file |

### Tool response shape

On success:

```json
{"id": "1", "content": [{"type": "text", "text": "..."}], "details": {...}}
```

On failure, only `"error"` is set:

```json
{"id": "1", "error": "read: cannot open file: /no/such: No such file or directory"}
```

---

### `read`

Read a file, optionally restricting output to a line range.

**Additional fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `offset` | number | 1 | 1-indexed first line to return |
| `limit` | number | unlimited | Maximum number of lines to return |

**Response `details`:**

```json
{"truncation": {"truncated": false, "line_count": 24}}
```

**Examples:**

```sh
# Read entire file
echo '{"id":"1","tool":"read","path":"/etc/os-release"}' | boxsh --rpc

# Read lines 20–29
echo '{"id":"2","tool":"read","path":"src/main.cpp","offset":20,"limit":10}' | boxsh --rpc
```

---

### `write`

Write (create or overwrite) a file with the given content.

**Additional fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | **yes** | Full content to write |

**Response:** `content[0].text` is `"written N bytes"`. No `details`.

**Example:**

```sh
echo '{"id":"1","tool":"write","path":"/tmp/hello.txt","content":"hello\n"}' | boxsh --rpc
# {"id":"1","content":[{"type":"text","text":"written 6 bytes"}]}
```

---

### `edit`

Apply one or more string replacements to a file in a single atomic operation.

**Additional fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `edits` | array | **yes** | Array of `{"oldText": "...", "newText": "..."}` objects |

**Constraints:**

- Each `oldText` must appear **exactly once** in the original file. A match count of 0 or ≥ 2 is rejected.
- Edits must not overlap.
- `oldText` must not be empty.
- All `oldText` values are matched against the **original** file — not against the partially-modified result.

**Response `details`:**

```json
{"diff": "--- a/file\n+++ b/file\n@@ -3,1 +3,1 @@\n-old line\n+new line\n", "firstChangedLine": 3}
```

`firstChangedLine` is the 1-indexed line number of the first changed line in the original file.

**Examples:**

```sh
# Single replacement
echo '{
  "id": "1", "tool": "edit", "path": "config.ini",
  "edits": [{"oldText": "debug = false", "newText": "debug = true"}]
}' | boxsh --rpc

# Multiple replacements in one request
echo '{
  "id": "2", "tool": "edit", "path": "server.js",
  "edits": [
    {"oldText": "const PORT = 3000", "newText": "const PORT = 8080"},
    {"oldText": "console.log(\"debug\")", "newText": ""}
  ]
}' | boxsh --rpc
```

---

## Options reference

```
Usage: boxsh [OPTIONS] [-- shell-args...]

Modes:
  (default)            Run as an ordinary POSIX shell (delegates to dash).
  --rpc                Read JSON-line requests from stdin, write responses to stdout.

RPC options:
  --workers N          Number of pre-forked worker processes (default: 4).
  --shell PATH         Shell binary used by workers (default: /bin/sh).

Sandbox options (applied in both shell mode and RPC mode):
  --sandbox            Enable the sandbox.
  --no-user-ns         Skip creating a new user namespace (requires root for other ns).
  --new-net-ns         Create a new network namespace (loopback only).
  --new-pid-ns         Create a new PID namespace.
  --rootfs DIR         pivot_root into DIR as the new root filesystem.
  --bind SRC:DST[:ro]  Bind-mount SRC at DST inside the sandbox.
                       Append :ro for a read-only bind.
  --overlay LOWER:UPPER:WORK:DST
                       Mount an overlayfs at DST. LOWER is the read-only base
                       layer; UPPER/WORK are caller-managed host directories.
                       Writes land in UPPER and persist across commands.
  --proc DST           Mount procfs at DST inside the sandbox.
  --tmpfs DST[:OPTS]   Mount a fresh empty tmpfs at DST (e.g. size=128m).
  --ro-root            Remount / read-only after pivot_root.
```

---

## Sandbox

Pass `--sandbox` to enable Linux namespace isolation. The sandbox is applied once per worker at fork time (RPC mode) or immediately before the shell starts (shell mode).

```sh
# RPC mode — all workers share the same isolated environment
boxsh --rpc --workers 4 --sandbox --new-net-ns

# Shell mode — sandbox applied before dash starts
boxsh --sandbox --rootfs /path/to/sysroot --bind /proc:/proc --proc /proc -c 'ls /'
```

**What each flag does:**

| Flag | Kernel mechanism | Effect |
|---|---|---|
| `--sandbox` | `CLONE_NEWUSER` + `CLONE_NEWNS` | User/mount namespace; current UID mapped as root inside |
| `--new-net-ns` | `CLONE_NEWNET` | Loopback-only; outbound network blocked |
| `--new-pid-ns` | `CLONE_NEWPID` | Isolated PID tree; host processes not visible |
| `--rootfs DIR` | `pivot_root(2)` | Change root to DIR |
| `--bind SRC:DST[:ro]` | `MS_BIND` | Bind-mount a host path into the sandbox |
| `--overlay LOWER:UPPER:WORK:DST` | `overlayfs` | Writable overlay over a read-only lower layer |
| `--proc DST` | `proc` | Mount procfs at DST |
| `--tmpfs DST[:OPTS]` | `tmpfs` | Fresh empty tmpfs at DST |
| `--ro-root` | `MS_REMOUNT\|MS_RDONLY` | Make `/` read-only after pivot_root |

**Kernel requirements for `--overlay`:**

| Context | Requirement |
|---|---|
| Running as root (`--no-user-ns`) | `CONFIG_OVERLAY_FS=y/m` |
| Unprivileged user namespace (default) | `CONFIG_OVERLAY_FS_METACOPY=y` (Linux ≥ 5.11) |

The sandbox uses direct Linux syscalls (`unshare(2)`, `mount(2)`, `pivot_root(2)`) — no external tools such as `bwrap` or `newuidmap` are required.

---

## Worker pool

RPC-mode workers are forked at startup before the event loop begins:

1. Each worker optionally enters the sandbox via `unshare` / `pivot_root`.
2. Workers communicate with the coordinator over a `socketpair(AF_UNIX, SOCK_STREAM)` using a 4-byte length-prefixed JSON wire format.
3. To execute a shell command, the worker forks a grandchild with stdout/stderr pipes, waits, then sends the result back.
4. After returning a result the worker immediately accepts the next request.

The coordinator runs a `poll(2)` event loop — it reads requests from stdin and forwards them to free workers as they become available; responses are forwarded to stdout as they arrive.

**Crash recovery:** if a worker crashes (killed by signal or alarm), the coordinator detects `POLLHUP` on the socket, returns an error response for the in-flight request, and respawns a replacement worker.

---

## Timeout

```sh
echo '{"id":"t","cmd":"sleep 60","timeout":5}' | boxsh --rpc
```

When a request includes a `timeout` field, the worker kills the running command after the specified number of seconds and returns a normal response with `exit_code: -1` and `stderr: "timeout"`. The worker itself remains alive and immediately accepts the next request — no respawn is needed.

```json
{"id":"t","exit_code":-1,"stdout":"","stderr":"timeout","duration_ms":5001}
```

---

## Testing

Requires Node.js ≥ 18.

```sh
node --test tests/index.test.mjs
```

| File | What it covers |
|---|---|
| `shell-mode.test.mjs` | Interactive/script shell mode, built-ins, shell features, shell-mode sandbox |
| `rpc-basics.test.mjs` | Response shape, field types, protocol robustness, parse error handling |
| `rpc-shell-features.test.mjs` | Pipelines, variables, arithmetic, heredocs, sed, grep, awk |
| `worker-pool.test.mjs` | Pool sizing, crash recovery, sequential and batch dispatch |
| `timeout.test.mjs` | Timeout triggering, post-timeout worker recovery and reuse |
| `concurrent.test.mjs` | Concurrent correctness, out-of-order responses, isolation, stress |
| `overlay.test.mjs` | Overlay copy-on-write, delete/whiteout, tmpfs mounts |
| `tools.test.mjs` | Built-in tools: read (offset/limit), write, edit (diff, uniqueness checks) |

---

## Architecture

```
boxsh/
├── src/
│   ├── main.cpp              CLI parsing, mode dispatch
│   ├── rpc.h / rpc.cpp       JSON-line protocol, built-in tools, poll(2) event loop
│   ├── worker_pool.h / .cpp  Worker lifecycle, IPC, shell command execution
│   └── sandbox.h / .cpp      Linux namespace sandbox (unshare/mount/pivot_root)
└── third_party/
    ├── dash-0.5.12/          Vendored dash (compiled as a static library;
    │                         dash_main() called directly in shell mode)
    ├── nlohmann/json.hpp     nlohmann/json v3.11.3 (header-only, MIT)
    └── libedit/              libedit headers + .so symlink (line editing)
```

---

## License

boxsh is released under the MIT License.

- [dash](http://gondor.apana.org.au/~herbert/dash/) — BSD license
- [nlohmann/json](https://github.com/nlohmann/json) — MIT license
- [libedit](https://www.thrysoee.dk/editline/) — BSD license

