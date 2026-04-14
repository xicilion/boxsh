# boxsh

A sandboxed POSIX shell and MCP server, built on [dash 0.5.12](http://gondor.apana.org.au/~herbert/dash/).

boxsh works as a **command-line shell** and as an **MCP (Model Context Protocol) server** for AI agents. OS-native sandbox isolation is baked in — give an AI agent, build system, or orchestration layer a shell that can execute arbitrary commands while constraining exactly what it can see and modify.

**Core capabilities:**

- **AI agent sandbox** — MCP-compatible server that AI clients (VS Code, Claude Desktop, Cursor, etc.) connect to directly. The agent gets `bash`, `read`, `write`, and `edit` tools inside an isolated environment.
- **Copy-on-write workspace** — overlay any directory as a COW workspace. The agent reads and writes freely; all modifications land in a separate destination directory. The original is never touched.
- **Interactive sandboxed shell** — `boxsh --try` drops you into a root shell over your current directory with COW. Experiment freely; discard everything on exit.
- **Parallel isolated workers** — pre-forked worker pool with configurable concurrency. Crash recovery, per-request timeout, out-of-order response streaming.

For a scenario-driven walkthrough with examples, see the **[Usage Guide](docs/usage.md)**.

---

## Features

| Feature | Details |
|---|---|
| **MCP server** | Implements MCP (Model Context Protocol) over stdio with Content-Length framing or newline-delimited JSON. Nine tools: `bash`, `read`, `write`, `edit`, `run_in_terminal`, `send_to_terminal`, `get_terminal_output`, `kill_terminal`, `list_terminals` — each with `inputSchema` and `annotations`. |
| **OS-native sandbox** | Linux: user/mount/PID/network namespaces via direct syscalls + seccomp syscall filtering; macOS: Seatbelt (sandbox_init) + SBPL profiles — no external tools required |
| **Overlay filesystem** | Copy-on-write workspace over any read-only base; writes accumulate in a caller-managed destination directory and persist between commands |
| **Built-in file tools** | `read` (text with offset/limit, binary as base64 with MIME detection), `write` (create or overwrite, auto-creates parent dirs), and `edit` (multi-replacement with unified diff) run on background threads — the event loop is never blocked |
| **JSON-RPC 2.0** | Dual transport: Content-Length framed (LSP-style) or newline-delimited JSON over stdin/stdout |
| **Pre-forked worker pool** | Configurable number of workers (`--workers N`); each worker is forked once and reused across requests |
| **Crash recovery** | If a worker is killed (timeout, segfault, OOM), the coordinator detects `POLLHUP`, returns an error response, and immediately respawns a replacement |
| **Per-request timeout** | `timeout` argument on the `bash` tool; enforced via `alarm(2)` inside the worker |
| **Bind mounts** | Selectively expose host paths (read-write or read-only) inside the sandbox |
| **Drop-in `/bin/sh`** | Shell mode delegates to embedded dash 0.5.12 — any script or flag that works with POSIX sh works here |
| **Single static binary** | dash, nlohmann/json, and libedit are vendored; no runtime dependencies beyond the OS kernel |

---

## Overview

boxsh has three modes:

| Mode | How to start | What it does |
|---|---|---|
| **Shell mode** | `boxsh` (default) | Drop-in `dash` replacement — interactive shell, `-c`, script files |
| **MCP / RPC mode** | `boxsh --rpc` | MCP server over stdio. Reads JSON-RPC 2.0 requests, executes tools via a pre-forked worker pool, writes JSON-RPC 2.0 responses. |
| **Quick-try** | `boxsh --try` | Drop into a sandboxed root shell on your CWD; writes go to a temp directory — original directory untouched |

In any mode, an optional OS-native sandbox can be enabled with `--sandbox`.

---

## Installation

### One-line install (Linux / macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/xicilion/boxsh/master/install.sh | sh
```

This auto-detects your OS and architecture, downloads the latest release binary, and installs it to `/usr/local/bin`.

Options via environment variables:

```sh
# Install a specific version
BOXSH_VERSION=v1.0.0 curl -fsSL https://raw.githubusercontent.com/xicilion/boxsh/master/install.sh | sh

# Install to a custom directory
BOXSH_INSTALL=~/.local/bin curl -fsSL https://raw.githubusercontent.com/xicilion/boxsh/master/install.sh | sh
```

Supported platforms: Linux (x64, ia32, arm64, arm, mips64, ppc64, riscv64, loong64) and macOS (arm64, x86_64).

### Build from source

**Requirements:** CMake ≥ 3.16, GCC or Clang (C11 / C++17). Supported platforms: Linux (kernel ≥ 3.8) and macOS (≥ 10.12).

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

This drops you into a **root shell inside a copy-on-write sandbox** over your current directory. Writes go to a temporary directory; your real directory is never modified.

```
$ boxsh --try
boxsh: changes will be saved in /tmp/boxsh-try-abc123/work
# <sandboxed root shell — experiment freely>
$ rm important-file.txt
$ exit
$ ls important-file.txt   # still here on the host
important-file.txt
$ ls /tmp/boxsh-try-abc123/work/
.wh.important-file.txt   # the whiteout lives here, not in your directory
```

The temp directory persists after exit so you can inspect or archive exactly what changed. `--try` is shorthand for `--sandbox --bind cow:CWD:<tmpdir>/work` with auto-managed directories. See [Quick-try Mode](docs/usage.md#quick-try-mode) for the full reference.

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

## MCP server

boxsh implements [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) over stdio. Any MCP-compatible client can connect to it directly as a sandboxed code execution server.

```sh
boxsh --rpc [--workers N] [--shell PATH] [sandbox flags...]
```

### Transport

boxsh supports two JSON-RPC 2.0 transports, auto-detected from the first bytes:

| Transport | Format | Used by |
|---|---|---|
| **Content-Length framed** | `Content-Length: N\r\n\r\nJSON` | VS Code, most MCP clients |
| **Newline-delimited** | One JSON object per line | CLI testing, piped input |

### MCP methods

| Method | Description |
|---|---|
| `initialize` | Returns server capabilities and protocol version |
| `notifications/initialized` | Acknowledged silently (no response) |
| `tools/list` | Returns all nine tools with `inputSchema` and `annotations` |
| `tools/call` | Dispatches to a named tool: `bash`, `read`, `write`, `edit` |

### Tools

#### `bash` — Execute a shell command

```json
{"jsonrpc":"2.0", "id":"1", "method":"tools/call",
 "params":{"name":"bash", "arguments":{"command":"echo hello", "timeout":10}}}
```

Response (MCP `CallToolResult` format):

```json
{"jsonrpc":"2.0", "id":"1", "result":{
  "content":[{"type":"text", "text":"hello\n"}],
  "structuredContent":{"exit_code":0, "stdout":"hello\n", "stderr":"", "duration_ms":3}
}}
```

- `content` — text representation for the LLM
- `structuredContent` — typed fields (`exit_code`, `stdout`, `stderr`, `duration_ms`)
- `isError: true` — set when `exit_code != 0` or the command fails

#### `read` — Read a file

```json
{"jsonrpc":"2.0", "id":"2", "method":"tools/call",
 "params":{"name":"read", "arguments":{"path":"/etc/hostname", "offset":1, "limit":10}}}
```

`offset` (1-indexed start line) and `limit` (max lines) are optional for text files. Binary files are automatically detected and returned as base64 with `encoding: "base64"` and a `mime_type` field. `structuredContent` includes `truncated` and `line_count` (text) or `size` (binary).

#### `write` — Create or overwrite a file

```json
{"jsonrpc":"2.0", "id":"3", "method":"tools/call",
 "params":{"name":"write", "arguments":{"path":"/tmp/hello.txt", "content":"hello\n"}}}
```

Creates or overwrites the file. Parent directories are created automatically if needed.

#### `edit` — Search-and-replace edit

```json
{"jsonrpc":"2.0", "id":"4", "method":"tools/call",
 "params":{"name":"edit", "arguments":{"path":"config.ini",
   "edits":[{"oldText":"debug = false", "newText":"debug = true"}]}}}
```

Each `oldText` must appear exactly once in the original file. Edits must not overlap. `structuredContent` includes `diff` (unified diff) and `firstChangedLine`.

#### `run_in_terminal` — Start a persistent PTY session

```json
{"jsonrpc":"2.0", "id":"5", "method":"tools/call",
 "params":{"name":"run_in_terminal", "arguments":{"command":"bash"}}}
```

Starts a PTY session running the given command. Returns `{ id, output, exited, exit_code }` — `id` is used by the other terminal tools.

#### `send_to_terminal` — Send input to a PTY session

```json
{"jsonrpc":"2.0", "id":"6", "method":"tools/call",
 "params":{"name":"send_to_terminal", "arguments":{"id":"<session-id>", "command":"ls -la\n"}}}
```

Writes text to the session's stdin, waits up to 500 ms, and returns the updated screen snapshot with `{ output, exited, exit_code }`.

#### `get_terminal_output` — Poll for new output

```json
{"jsonrpc":"2.0", "id":"7", "method":"tools/call",
 "params":{"name":"get_terminal_output", "arguments":{"id":"<session-id>"}}}
```

Waits up to 500 ms for new output, then returns the current screen snapshot. Use this to poll long-running commands until `exited` is `true`.

#### `kill_terminal` — Terminate a PTY session

```json
{"jsonrpc":"2.0", "id":"8", "method":"tools/call",
 "params":{"name":"kill_terminal", "arguments":{"id":"<session-id>"}}}
```

Sends SIGHUP, drains output, and frees resources. Returns the final screen snapshot.

#### `list_terminals` — List active sessions

```json
{"jsonrpc":"2.0", "id":"9", "method":"tools/call",
 "params":{"name":"list_terminals", "arguments":{}}}
```

Returns metadata for all live and recently-exited sessions.

### Error model

boxsh distinguishes two kinds of errors per the MCP spec:

| Error type | Serialization | Example |
|---|---|---|
| **Protocol error** | JSON-RPC `{"error": {"code": N, "message": "..."}}` | Invalid JSON, unknown method, unknown tool |
| **Tool execution error** | `{"result": {"content": [...], "isError": true}}` | Non-zero exit code, file not found |

### Client configuration

`--sandbox` enforces minimal privileges — only system directories are accessible. You must explicitly `--bind` any project directories the agent needs.

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "boxsh": {
      "command": "boxsh",
      "args": [
        "--rpc", "--workers", "4",
        "--sandbox", "--bind", "ro:${workspaceFolder}"
      ]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "boxsh": {
      "command": "boxsh",
      "args": [
        "--rpc", "--workers", "4",
        "--sandbox", "--bind", "cow:/path/to/project:/path/to/dst"
      ]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "boxsh": {
      "command": "boxsh",
      "args": [
        "--rpc", "--workers", "4",
        "--sandbox", "--bind", "cow:/path/to/project:/path/to/dst"
      ]
    }
  }
}
```

**Bind modes:** `cow:SRC:DST` (copy-on-write — project is read-only, writes go to DST), `ro:PATH` (read-only), `wr:PATH` (direct read-write). Add `--new-net-ns` to block network access.

### Sandboxing third-party MCP servers

boxsh can wrap **any** MCP server command to sandbox it — no changes to the server itself are required. Simply replace the original `command` with `boxsh` and prepend sandbox flags before `--`:

**Before** (unsandboxed):

```json
{
  "servers": {
    "some-mcp": {
      "command": "npx",
      "args": ["-y", "@anthropic/some-mcp-server"]
    }
  }
}
```

**After** (sandboxed via boxsh):

```json
{
  "servers": {
    "some-mcp": {
      "command": "boxsh",
      "args": [
        "--sandbox",
        "--bind", "ro:/path/to/project",
        "--new-net-ns",
        "--", "npx", "-y", "@anthropic/some-mcp-server"
      ]
    }
  }
}
```

boxsh launches the original MCP server inside an isolated namespace. The server still communicates over stdio as usual, but its filesystem and network access are restricted by the sandbox. This works with any MCP server that uses stdio transport.

### Handshake example

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":"2","method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":"3","method":"tools/call","params":{"name":"bash","arguments":{"command":"echo hello"}}}' \
| boxsh --rpc --workers 1
```

### Concurrency

Multiple requests sent at once are dispatched to different workers and execute in parallel. Responses arrive in completion order — fast commands don't wait for slow ones.

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":"slow","method":"tools/call","params":{"name":"bash","arguments":{"command":"sleep 0.5; echo slow"}}}' \
  '{"jsonrpc":"2.0","id":"fast","method":"tools/call","params":{"name":"bash","arguments":{"command":"echo fast"}}}' \
| boxsh --rpc --workers 2
# "fast" response arrives first, then "slow"
```

File tool requests (`read`, `write`, `edit`) and terminal tool requests run on background threads and do not occupy a worker slot.

---

## Options reference

```
Usage: boxsh [OPTIONS] [-- shell-args...]

Modes:
  (default)            Run as an ordinary POSIX shell (delegates to dash).
  --rpc                Read JSON-RPC 2.0 requests from stdin, write responses to stdout. MCP-compatible.

RPC options:
  --workers N          Number of pre-forked worker processes (default: 4).
  --shell PATH         Shell binary used by workers (default: /bin/sh).

Sandbox options (applied in both shell mode and RPC mode):
  --sandbox            Enable the sandbox.
  --new-net-ns         Create a new network namespace (loopback only).
  --bind ro:PATH       Expose PATH read-only inside the sandbox.
  --bind wr:PATH       Expose PATH read-write inside the sandbox.
  --bind cow:SRC:DST   Mount an overlayfs at DST with SRC as the read-only
                       base.  Writes go to DST (the upper layer); SRC is
                       never modified.  DST must exist before launch.

Quick-try mode:
  --try                Launch a sandboxed shell on the current directory.
                       Mounts the current directory as a copy-on-write overlay
                       so all writes are captured in a temporary directory.
```

---

## Sandbox

Pass `--sandbox` to enable OS-native sandbox isolation. The sandbox is applied once per worker at fork time (RPC mode) or immediately before the shell starts (shell mode).

```sh
# RPC mode — all workers share the same isolated environment
boxsh --rpc --workers 4 --sandbox --new-net-ns

# Shell mode — sandbox applied before dash starts
boxsh --sandbox --bind wr:/data -c 'ls /'
```

**What each flag does:**

| Flag | Effect |
|---|---|
| `--sandbox` | Isolated environment; only system directories accessible; all project access requires explicit `--bind`; current UID mapped as root inside (Linux) |
| `--new-net-ns` | Loopback-only; outbound network blocked |
| `--bind ro:PATH` | Expose a host path read-only inside the sandbox |
| `--bind wr:PATH` | Expose a host path read-write inside the sandbox |
| `--bind cow:SRC:DST` | Copy-on-write overlay — SRC is read-only, writes go to DST |

**Platform implementation details:**

| Platform | Sandbox mechanism | COW mechanism |
|---|---|---|
| Linux | User/mount/PID namespaces + seccomp syscall filter | overlayfs (kernel ≥ 5.11 for user-ns) |
| macOS | Seatbelt (`sandbox_init` + SBPL) | `clonefile(2)` on APFS |

No external tools such as `bwrap` or `newuidmap` are required on any platform.

---

## Worker pool

RPC-mode workers are forked at startup before the event loop begins:

1. Each worker optionally enters the sandbox via OS-native isolation.
2. Workers communicate with the coordinator over a `socketpair(AF_UNIX, SOCK_STREAM)` using a 4-byte length-prefixed JSON wire format.
3. To execute a shell command, the worker forks a grandchild with stdout/stderr pipes, waits, then sends the result back.
4. After returning a result the worker immediately accepts the next request.

The coordinator runs a `poll(2)` event loop — it reads requests from stdin and forwards them to free workers as they become available; responses are forwarded to stdout as they arrive.

**Crash recovery:** if a worker crashes (killed by signal or alarm), the coordinator detects `POLLHUP` on the socket, returns an error response for the in-flight request, and respawns a replacement worker.

---

## Timeout

```sh
echo '{"jsonrpc":"2.0","id":"t","method":"tools/call","params":{"name":"bash","arguments":{"command":"sleep 60","timeout":5}}}' | boxsh --rpc
```

When a request includes a `timeout` argument, the worker kills the running command after the specified number of seconds and returns a tool result with `exit_code: -1` and `stderr: "timeout"`. The worker itself remains alive and immediately accepts the next request — no respawn is needed.

```json
{"jsonrpc":"2.0","id":"t","result":{
  "content":[{"type":"text","text":"timeout"}],
  "structuredContent":{"exit_code":-1,"stdout":"","stderr":"timeout","duration_ms":5001},
  "isError":true
}}
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
| `overlay.test.mjs` | COW bind mounts, copy-on-write, delete/whiteout |
| `tools.test.mjs` | Built-in tools: read (offset/limit), write, edit (diff, uniqueness checks) |
| `mcp.test.mjs` | MCP protocol: initialize, tools/list, tools/call, notifications, handshake |
| `protocol-regression.test.mjs` | Content-Length transport, ID type preservation, initialize handshake, error distinction |

---

## Architecture

```
boxsh/
├── src/
│   ├── main.cpp              CLI parsing, mode dispatch
│   ├── rpc.h / rpc.cpp       JSON-RPC 2.0 protocol, MCP handlers, built-in tools, poll(2) event loop
│   ├── worker_pool.h / .cpp  Worker lifecycle, IPC, shell command execution
│   ├── sandbox.h              Platform-neutral sandbox interface
│   ├── sandbox.cpp            Linux implementation (namespaces/overlayfs/seccomp)
│   ├── sandbox_darwin.cpp     macOS implementation (Seatbelt/clonefile)
│   ├── terminal.h / .cpp     PTY session management (libvterm-backed)
│   ├── file_type.h / .cpp    Binary file type detection
│   └── image_resize.h / .cpp Image resizing for binary read responses
└── third_party/
    ├── dash-0.5.12/          Vendored dash (compiled as a static library;
    │                         dash_main() called directly in shell mode)
    ├── nlohmann/json.hpp     nlohmann/json v3.11.3 (header-only, MIT)
    ├── libedit/              libedit headers + .so symlink (line editing)
    ├── libvterm/             libvterm (PTY screen model for terminal tools)
    └── stb/                  stb_image / stb_image_resize (image processing)
```

---

## License

boxsh is released under the MIT License.

- [dash](http://gondor.apana.org.au/~herbert/dash/) — BSD license
- [nlohmann/json](https://github.com/nlohmann/json) — MIT license
- [libedit](https://www.thrysoee.dk/editline/) — BSD license

