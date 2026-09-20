# boxsh

A sandboxed POSIX shell and MCP server, built on [dash 0.5.12](http://gondor.apana.org.au/~herbert/dash/).

boxsh works as a **command-line shell** and as an **MCP (Model Context Protocol) server** for AI agents. OS-native sandbox isolation is baked in — give an AI agent, build system, or orchestration layer a shell that can execute arbitrary commands while constraining exactly what it can see and modify.

**Core capabilities:**

- **AI agent sandbox** — MCP-compatible server that AI clients (VS Code, Claude Desktop, Cursor, etc.) connect to directly. The agent gets `bash`, `read`, `view_image`, `write`, and `edit` tools inside an isolated environment.
- **Copy-on-write workspace** — overlay any directory as a COW workspace. The agent reads and writes freely; all modifications land in a separate destination directory. The original is never touched.
- **Interactive sandboxed shell** — `boxsh --try` drops you into a root shell over your current directory with COW. Experiment freely; discard everything on exit.
- **Parallel isolated workers** — pre-forked worker pool with configurable concurrency. Crash recovery, per-request timeout, a server-side default timeout, out-of-order response streaming.
- **Leave nothing behind** — when boxsh is stopped (or its client disappears), running commands and PTY sessions are killed together with their process groups instead of lingering as orphans.

For a scenario-driven walkthrough with examples, see the **[Usage Guide](docs/usage.md)**.

---

## Features

| Feature | Details |
|---|---|
| **MCP server** | Implements MCP (Model Context Protocol) over stdio with Content-Length framing or newline-delimited JSON. Ten tools: `bash`, `read`, `view_image`, `write`, `edit`, `run_in_terminal`, `send_to_terminal`, `get_terminal_output`, `kill_terminal`, `list_terminals` — each with `inputSchema`, `outputSchema` and `annotations`. |
| **OS-native sandbox** | Linux: user/mount/PID/network namespaces via direct syscalls + seccomp syscall filtering; macOS: Seatbelt (sandbox_init) + SBPL profiles — no external tools required |
| **Copy-on-write workspace** | Copy-on-write workspace over any read-only base; writes accumulate in a caller-managed destination directory, persist between commands, and can be resumed across sessions |
| **Built-in file tools** | `read` (text with offset/limit and `next_offset` paging), `view_image` (png/jpeg/gif/bmp/tiff/webp with automatic downscaling) and `write`/`edit` (create or overwrite, auto-creates parent dirs; unique-match multi-replacement) run on background threads — the event loop is never blocked |
| **JSON-RPC 2.0** | Dual transport: Content-Length framed (LSP-style) or newline-delimited JSON over stdin/stdout |
| **Pre-forked worker pool** | Configurable number of workers (`--workers N`); each worker is forked once and reused across requests |
| **Crash recovery** | If a worker is killed (timeout, segfault, OOM), the coordinator detects `POLLHUP`, returns an error response, and immediately respawns a replacement |
| **Per-request timeout** | `timeout` argument on the `bash` tool, enforced by the worker with a monotonic deadline |
| **Server-side default timeout** | `--command-timeout N` (default 60 s) applies to requests that carry no timeout of their own, so a command whose caller walked away does not run forever; `0` disables it |
| **Stateful PTY sessions** | Five terminal tools over real PTY sessions: interactive programs, persistent cwd/env, and an addressable raw output log (cursor-based, no loss above the visible screen). Bounded by `--max-sessions` (32), `--session-log-limit` (1 MiB) and `--session-ttl` (600 s) |
| **Shutdown cleanup** | On SIGTERM/SIGINT/SIGHUP (or a killed coordinator) every running command and PTY session is killed at its process group — no orphans |
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
# host-side representation is platform-specific; inspect with getChanges() for a portable diff
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
boxsh --rpc [--workers N] [--shell PATH] [--command-timeout N] \
           [--session-log-limit BYTES] [--max-sessions N] [--session-ttl SECONDS] \
           [sandbox flags...]
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
| `initialize` | Returns server capabilities and protocol version (`2025-06-18`; older revisions are echoed back) |
| `notifications/initialized` | Acknowledged silently (no response) |
| `tools/list` | Returns all ten tools with `inputSchema`, `outputSchema` and `annotations`. The tool set is static (`capabilities.tools.listChanged: false`) — restart the server to pick up new tool definitions |
| `tools/call` | Dispatches to a named tool: `bash`, `read`, `view_image`, `write`, `edit` |

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

- `content` — model-facing text: stdout, a `[stderr]` section when stderr is non-empty, and `[exit code: N]` for non-zero exits. Output past ~50 KiB keeps 24 KiB of head and tail with an explicit omission marker; the untouched streams stay in `structuredContent`.
- `structuredContent` — typed fields (`exit_code`, `stdout`, `stderr`, `duration_ms`, optional `stdout_truncated`/`stderr_truncated`/`timed_out`, plus `timeout_sec`/`timeout_source` when a timeout fired)
- `isError: true` — set when `exit_code != 0` or the command fails

#### `read` — Read a text file

```json
{"jsonrpc":"2.0", "id":"2", "method":"tools/call",
 "params":{"name":"read", "arguments":{"path":"/etc/hostname", "offset":1, "limit":10}}}
```

`offset` (1-indexed start line) and `limit` (max lines) are optional; the default cap is 2000 lines / 50 KiB per call. Text lives in `content[0].text` (the model representation); `structuredContent` carries metadata only — `{encoding:"text", mime_type, line_count, truncated, file_size, total_lines?, next_offset?, empty_reason?}`. `file_size` is always present; `next_offset` appears only when a further line really exists, and `empty_reason` (`empty_file` | `offset_beyond_eof`) explains an empty body. A single physical line is never buffered beyond 1 MiB, so machine-generated one-line files cannot blow up memory.

Binary files cannot be read as text: images fail with `E_NOT_IMAGE` (use `view_image`) and other binaries with `E_NOT_TEXT` (use `bash` with `file`, `xxd` or `strings`). Targets must be regular files or readable devices — FIFOs and sockets fail fast with `E_INVALID_ARGUMENT` and `detail.kind` (use `bash` for those).

#### `view_image` — View an image

```json
{"jsonrpc":"2.0", "id":"2b", "method":"tools/call",
 "params":{"name":"view_image", "arguments":{"path":"/tmp/chart.png", "detail":"auto"}}}
```

Returns the image as an MCP `image` content block plus `structuredContent` metadata `{encoding:"image", mime_type, width, height, original_width, original_height, was_resized, size, animated, converted}`. Images are downscaled to a 2000px longest edge (`detail:"low"` → 512px) and capped at 4.5 MB of base64; animated GIF/APNG/WebP sources report `animated: true` and are re-encoded so only their first frame is returned. Decodable formats are png, jpeg, gif, bmp, tiff and webp (vendored libwebp decoder) — other image formats (avif, heic, jxl, psd, …) fail with `E_UNSUPPORTED_FORMAT` and list the supported ones in `detail.supported`. Because multimodal models ingest jpeg/png/gif/webp natively, only those four may be returned byte-for-byte: bmp, tiff and any other decodable format are converted to PNG/JPEG (whichever is smaller) with `converted: true`, so the client model always receives an image it can actually see. A corrupt file of a decodable format carries the same code plus `detail.reason: "decode_failed"` (formats outside the decode set only carry `detail.supported`), and headers declaring more than 100 MP are rejected with `E_TOO_LARGE` before any pixel buffer is allocated.

#### `write` — Create or overwrite a file

```json
{"jsonrpc":"2.0", "id":"3", "method":"tools/call",
 "params":{"name":"write", "arguments":{"path":"/tmp/hello.txt", "content":"hello\n"}}}
```

Creates or overwrites the file. Parent directories are created automatically if needed. The write is in place (timestamps aside, the file's identity, mode bits, hard links and symlinks are preserved) and a failed call leaves nothing behind: directories created for it are removed again, a trailing slash on a path that is not an existing directory is refused up front, and a partially written file is rolled back on a best-effort basis (`detail.restored`). The result reports `created`, `bytes` and the model-facing text `write: PATH (created|overwrote existing, N bytes)`. A dangling symlink is followed (POSIX `open(2)` semantics, like `echo x > link`): the write creates the link's target and keeps the link.

#### `edit` — Search-and-replace edit

```json
{"jsonrpc":"2.0", "id":"4", "method":"tools/call",
 "params":{"name":"edit", "arguments":{"path":"config.ini",
   "edits":[{"oldText":"debug = false", "newText":"debug = true"}]}}}
```

Each `oldText` must appear exactly once in the original file. Edits must not overlap. The file is rewritten in place only when the bytes actually change — a no-op edit returns `edit: PATH (no changes)` and leaves mtime and inode untouched — and targets above 16 MiB are rejected with `E_TOO_LARGE`.

#### `run_in_terminal` — Start a persistent PTY session

```json
{"jsonrpc":"2.0", "id":"5", "method":"tools/call",
 "params":{"name":"run_in_terminal", "arguments":{"command":"bash", "rows":50, "cols":220}}}
```

Starts a PTY session running the given command (`/bin/sh -c`, `/bin/sh` by default on Linux/macOS) at the requested window size — the size is applied to the PTY itself, so `stty size`, `tput`, pagers and full-screen programs see it. Returns `{ id, output, exited, exit_code, total_bytes }`; `id` is used by the other terminal tools. `rows`/`cols` only bound the *screen* snapshot: the raw log keeps the full output regardless.

Optional wait arguments (shared by the read tools):

| Argument | Meaning |
|---|---|
| `wait_ms` | How long to wait before returning (default 500, up to 600000) |
| `wait_for` | `"output"` (default), `"exit"` (wait for the process to exit and return the complete raw stream), `"none"` (return at once) |

With `wait_for:"exit"` a one-shot command behaves like `bash` — one call returns the complete output, the exit code and the duration — while keeping PTY semantics. Prefer `bash` for plain non-interactive commands: it separates stdout/stderr.

#### `send_to_terminal` — Send input to a PTY session

```json
{"jsonrpc":"2.0", "id":"6", "method":"tools/call",
 "params":{"name":"send_to_terminal", "arguments":{"id":"<session-id>", "command":"ls -la\n",
   "capture_status":true, "wait_ms":10000}}}
```

Writes text to the session's stdin and returns the updated screen plus the raw byte delta. Text is written as-is: a trailing `\n` is what makes it a command line.

With `capture_status: true` the text is submitted as a shell command line and boxsh appends a self-erasing status probe, so the result also carries `command_exit_code` — the exit code of *that command* (a persistent shell session can then be driven like a command runner). The probe is input, so use it on shell sessions only, never on a REPL or a pager. Both the probe and its echoed command line are removed from the text and the raw stream that boxsh returns.

#### `get_terminal_output` — Read output without waiting for a command

```json
{"jsonrpc":"2.0", "id":"7", "method":"tools/call",
 "params":{"name":"get_terminal_output", "arguments":{"id":"<session-id>", "cursor":0}}}
```

Without `cursor` this returns the current screen (a view of the last `rows` lines). With `cursor` it returns the raw byte stream instead — only the bytes that arrived after that position, decoded from the lossless log, with `first_cursor`/`next_cursor`/`truncated_before` describing the window. Passing `cursor: 0` reads everything still retained, which is how to collect output that has scrolled off the screen; polling with the returned `next_cursor` returns zero bytes while nothing new arrives. `wait_for:"exit"` waits for the process to finish and returns the whole stream in one call.

The raw log keeps 1 MiB per session by default (`--session-log-limit`); when it wraps, the result says so through `truncated_before` and `dropped_bytes` — output is never dropped silently.

#### `kill_terminal` — Terminate a PTY session

```json
{"jsonrpc":"2.0", "id":"8", "method":"tools/call",
 "params":{"name":"kill_terminal", "arguments":{"id":"<session-id>"}}}
```

Signals the session's whole process group with SIGHUP and escalates to SIGKILL if something is still alive after a second (an interactive shell ignores SIGHUP and would otherwise keep the session — and the server — waiting), then frees resources and returns the final screen plus the complete raw output (`{ killed, exit_code, output, stream, next_cursor }`). `killed` is `false` when the process had already exited on its own.

#### `list_terminals` — List sessions

```json
{"jsonrpc":"2.0", "id":"9", "method":"tools/call",
 "params":{"name":"list_terminals", "arguments":{"include_exited":true}}}
```

Lists live sessions with `{ id, command, alive, cols, rows, total_bytes, age_ms, idle_ms }`. Sessions whose process has exited stay addressable (so their output can still be read) but are hidden unless `include_exited: true` is passed; they are reaped after `--session-ttl` (default 600 s), and at most `--max-sessions` (default 32) live sessions may exist at once — one more is rejected with `E_TOO_MANY_SESSIONS` rather than queued.

### Error model

boxsh distinguishes two kinds of errors per the MCP spec:

| Error type | Serialization | Example |
|---|---|---|
| **Protocol error** | JSON-RPC `{"error": {"code": N, "message": "..."}}` | Invalid JSON, unknown method, unknown tool, missing/invalid arguments |
| **Tool error** | `{"result": {"content": [{"type":"text","text":"E_...: ..."}], "structuredContent": {"code": "E_...", "message": "..."}, "isError": true}}` | File not found, not an image, unsupported format, bad base64 |
| **Command failure** | `isError: true` with the normal command `structuredContent` (no `code`) | Non-zero exit code, timeout (`timed_out: true`) |

Stable tool error codes: `E_INVALID_ARGUMENT`, `E_NOT_FOUND`, `E_NOT_TEXT`, `E_NOT_IMAGE`, `E_UNSUPPORTED_FORMAT`, `E_TOO_LARGE`, `E_TIMEOUT`, `E_SANDBOX`, `E_INTERNAL`, `E_TOO_MANY_SESSIONS`. Descriptions and examples are in the per-tool sections above; the contract is enforced by `tests/tool-contract.test.mjs` and `tests/file-tools-robustness.test.mjs`.

Every tool error sets `isError: true` and carries `structuredContent.{code, message, detail?}`; the readable `content[0].text` always starts with `"<CODE>: "` (e.g. `E_NOT_FOUND: read: ...`), so a client that only forwards text can still detect failures by that prefix. `detail` disambiguates the cases where the code alone is not enough:

| `detail` | Meaning |
|---|---|
| `sandbox` + `errno`/`errno_name` | on `E_SANDBOX`: a sandbox denial vs a file-permission denial |
| `reason: "decode_failed"` | on `E_UNSUPPORTED_FORMAT`: a corrupt file vs a format outside the decode set |
| `kind: "dangling_symlink"` + `target` | on `E_NOT_FOUND`: a broken symlink (with its target) vs a path that never existed |
| `kind: "fifo"` / `"socket"` | on `E_INVALID_ARGUMENT`: a blocking target the file tools refuse |
| `errno_name: "ELOOP"` | on `E_INVALID_ARGUMENT`: a symbolic link loop |
| `restored` | on `write`/`edit` failures: whether the previous content was restored |

### Client configuration

`--sandbox` enforces minimal privileges — reads stay inside system-maintained directories (`/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/Applications`, `/opt`, `/dev`, `/private` and the `/var`, `/tmp`, `/etc` symlink aliases), while writes are only possible through `--bind`. A path can therefore be readable but not writable; expose project data with `--bind` (`ro:`, `wr:`, `cow:`).

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
  --command-timeout N  Seconds a command may run before it is killed, applied to
                       requests that carry no positive "timeout" themselves
                       (default: 60; 0 disables the safety net).
  --session-log-limit N
                       Raw output bytes retained per terminal session (default:
                       1048576). Older bytes are dropped from the front, and the
                       result says so (truncated_before / dropped_bytes).
  --max-sessions N     Maximum number of live terminal sessions (default: 32).
                       Starting one more fails with E_TOO_MANY_SESSIONS.
  --session-ttl N      Seconds an exited terminal session stays addressable
                       before its resources are reaped (default: 600; 0 keeps them).

Sandbox options (applied in both shell mode and RPC mode):
  --sandbox            Enable the sandbox.
  --new-net-ns         Create a new network namespace (loopback only).
  --bind ro:PATH       Expose PATH read-only inside the sandbox.
  --bind wr:PATH       Expose PATH read-write inside the sandbox.
  --bind cow:SRC:DST   Create a copy-on-write workspace at DST with SRC as the
                       read-only base. Writes go to DST; SRC is never modified.
                       Existing DST contents are reused.

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
| `--sandbox` | Isolated environment; reads are limited to system-maintained directories (`/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/Applications`, `/opt`, `/dev`, `/private` and its `/var`, `/tmp`, `/etc` aliases) while **writes are only possible through `--bind`**; current UID mapped as root inside (Linux) |
| `--new-net-ns` | Loopback-only; outbound network blocked |
| `--bind ro:PATH` | Expose a host path read-only inside the sandbox |
| `--bind wr:PATH` | Expose a host path read-write inside the sandbox |
| `--bind cow:SRC:DST` | Copy-on-write overlay — SRC is read-only, writes go to DST |

**Platform implementation details:**

| Platform | Sandbox mechanism | COW mechanism |
|---|---|---|
| Linux | User/mount/PID namespaces + seccomp syscall filter | overlayfs (kernel ≥ 5.11 for user-ns) |
| macOS | Seatbelt (`sandbox_init` + SBPL) | `clonefile(2)` on APFS |
| Linux (Docker) | Same as Linux (requires `--user`) | fuse-overlayfs |

No external tools such as `bwrap` or `newuidmap` are required on any platform.

### Docker support

boxsh automatically detects Docker/containerd/K8s containers and runs the same unprivileged userns engine as on the host — but the container **must start as a non-root user**:

- **`--user` container (required)** — boxsh runs natively unprivileged; identical userns engine, no drop involved.
- **Root container (rejected)** — a root sandbox would have no isolation: in rootful Docker the container's real root is the host's root, so system files would be writable and RW bind mounts would accept root-owned setuid binaries that persist on the host. boxsh refuses every sandbox request with an actionable error; plain (non-sandbox) shells keep working.

```sh
docker run --user "$(id -u):$(id -g)" \
  --security-opt seccomp=unconfined \     # allow unshare/mount syscalls
  --security-opt apparmor=unconfined \    # allow mount --make-rslave /
  --device /dev/fuse                      # fuse-overlayfs COW
```

No `--cap-add SYS_ADMIN` is required: the user namespace provides the mount capability inside the sandbox. Directories you bind-mount and want the sandbox to write must be writable by the `--user` uid — if a previous root run left root-owned files, chown them once from a root shell (`chown -R "$(id -u):$(id -g)" <dir>`). Root-owned mapped directories are the one case boxsh cannot paper over: it refuses rather than run an isolated-by-nothing root sandbox.

If a flag is missing, boxsh reports an actionable error:
- Running as root → `boxsh inside Docker must run as a non-root user: a root sandbox would have no isolation ... Restart the container with --user "$(id -u):$(id -g)" ...`
- Unprivileged userns blocked → `unshare (container userns engine): ...; boxsh inside Docker needs unprivileged user namespaces ...`
- Missing `apparmor=unconfined` → `mount --make-rslave /: ...; container must be started with --security-opt apparmor=unconfined`
- Missing `/dev/fuse` → `...container is missing /dev/fuse — start Docker with --device /dev/fuse`

The sandbox always preserves full namespace isolation: mount/PID namespaces, pivot_root to a clean tmpfs, seccomp syscall filtering, and RO/WR/COW bind mounts. Inside a container, `/proc` is a read-only bind of the container's `/proc` (fresh procfs mounts are refused in a nested user namespace) — sibling processes in the same container are visible, host processes never are. See [Docker Usage](docs/usage.md#docker-usage) for end-to-end examples.

---

## Worker pool

RPC-mode workers are forked at startup before the event loop begins:

1. Each worker optionally enters the sandbox via OS-native isolation.
2. Workers communicate with the coordinator over a `socketpair(AF_UNIX, SOCK_STREAM)` using a 4-byte length-prefixed JSON wire format.
3. To execute a shell command, the worker forks a grandchild with stdout/stderr pipes, waits, then sends the result back.
4. After returning a result the worker immediately accepts the next request.

The coordinator runs a `poll(2)` event loop — it reads requests from stdin and forwards them to free workers as they become available; responses are forwarded to stdout as they arrive.

**Crash recovery:** if a worker crashes (killed by signal or alarm), the coordinator detects `POLLHUP` on the socket, returns an error response for the in-flight request, and respawns a replacement worker.

**Shutdown:** the workers poll their socket to the coordinator while a command runs. When the coordinator closes it — because boxsh got SIGTERM/SIGINT/SIGHUP, or because the process was killed outright — the worker kills the command's whole process group before exiting. boxsh does the same for PTY sessions on the way out, so no command or session is left behind.

---

## Timeout

Two layers, because a caller that gives up never says so:

```sh
# Explicit: the command is killed after 5s
printf '%s\n' '{"jsonrpc":"2.0","id":"t","method":"tools/call","params":{"name":"bash","arguments":{"command":"sleep 60","timeout":5}}}' | boxsh --rpc
```

1. **Per-request** — a `timeout` argument kills the command after that many seconds (`exit_code: -1`, `stderr: "timeout"`, `timed_out: true`). The worker itself remains alive and immediately accepts the next request — no respawn is needed.
2. **Server default** — `--command-timeout N` (default **60 s**) is used for every request that carries no positive `timeout`, including `timeout: 0`. Clients that never pass a timeout would otherwise leave a runaway command behind after they stop waiting for it. `--command-timeout 0` restores unlimited execution.

An explicit `timeout` always wins over the default (it is a fallback, not a ceiling), so long builds and test suites keep working:

```sh
# default 1s, but this command is allowed 5s
printf '%s\n' '{"jsonrpc":"2.0","id":"t","method":"tools/call","params":{"name":"bash","arguments":{"command":"make -j8","timeout":300}}}' | boxsh --rpc --command-timeout 1
```

When the server default is what fired, the result says so instead of a bare `[timeout]`:

```json
{"jsonrpc":"2.0","id":"t","result":{
  "content":[{"type":"text","text":"[stderr]\ntimeout\n[timeout: killed after the server default of 60s \u2014 pass `timeout` to allow a longer command]\n[exit code: -1]\n"}],
  "structuredContent":{"exit_code":-1,"stdout":"","stderr":"timeout","duration_ms":60001,"timed_out":true,"timeout_sec":60,"timeout_source":"server_default"},
  "isError":true
}}
```

`timeout_source` is `"request"` for a timeout the caller asked for and `"server_default"` for the safety net. Both are present only when `timed_out` is true.

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
| `command-timeout.test.mjs` | Server-side default timeout (`--command-timeout`) precedence and `timeout_source`, shutdown cleanup (SIGTERM/SIGKILL/EOF leave no orphaned commands or PTY sessions) |
| `terminal-stream.test.mjs` | Terminal session output model: raw log + cursors (no loss above the viewport), `wait_for`/`wait_ms`, `capture_status` exit codes, PTY window size, session reaping and `E_TOO_MANY_SESSIONS` |
| `concurrent.test.mjs` | Concurrent correctness, out-of-order responses, isolation, stress |
| `overlay.test.mjs` | COW bind mounts, copy-on-write, delete/whiteout |
| `tools.test.mjs` | Built-in tools: read (offset/limit), write, edit (uniqueness checks) |
| `file-tools-robustness.test.mjs` | Hardening: FIFO/socket/directory targets, `empty_reason`/`next_offset`/`file_size`, 32 MiB single line, declared-pixel image bombs, write-path semantics (mode/hard links/symlinks, no-op edits), errno→code mapping |
| `view-image.test.mjs` | `view_image`: image block + metadata, 2000px/512px downscaling, animated flag, image error codes |
| `tool-contract.test.mjs` | Result contract: descriptors, `outputSchema` conformance, error codes, readable `content`, bash text budget |
| `mcp.test.mjs` | MCP protocol: initialize, tools/list, tools/call, notifications, handshake |
| `protocol-regression.test.mjs` | Content-Length transport, ID type preservation, initialize handshake, error distinction |
| `docker.test.mjs` | Container engine contract: engine switch, COW via fuse-overlayfs, sandbox isolation (run by `docker-test.sh`, not in `index.test.mjs`) |
| `docker-negative.test.mjs` | Negative path: COW without `/dev/fuse` reports actionable error (run by `docker-test.sh`, not in `index.test.mjs`) |
| `docker-test.sh` | Dev/CI Docker test runner: supports `--vol=bind` (host-mapped) and `--vol=tmpfs` (ephemeral) modes. On a macOS host it mounts `build/boxsh-linux` into the container (a Mach-O build cannot run there) and prints the one-line command that produces it when the file is missing |

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

