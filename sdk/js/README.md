# boxsh.js

Node.js SDK for [boxsh](../../README.md) — a sandboxed POSIX shell with OS-native isolation and copy-on-write overlay filesystem.

boxsh.js lets you drive a long-lived boxsh instance from Node.js: execute shell commands, read/write files, and perform search-and-replace edits — all inside an isolated sandbox.

**Requirements:** Node.js ≥ 18, Linux or macOS, `boxsh` binary on `$PATH` (or set `BOXSH` env var).

## Install

```sh
npm install boxsh.js
```

---

## Quick start

Simplest form — no sandbox, just run a command:

```js
import { BoxshClient } from 'boxsh.js';

const client = new BoxshClient();

const { exitCode, stdout } = await client.exec('echo hello');
console.log(stdout);  // "hello\n"

await client.close();
```

---

## Running shell commands

`exec(cmd, cwd?, timeout?)` runs a shell command in a boxsh worker, returning
`{ exitCode, stdout, stderr, timedOut, truncated }`. A command killed by its
timeout has `exitCode: -1` and `timedOut: true` (the MCP result underneath is
`isError: true`) and still carries whatever it printed before the kill —
`stderr` ends with the `timeout` marker.

```js
// Specify a working directory
const result = await client.exec('ls -la', '/workspace');
console.log(result.exitCode);  // 0
console.log(result.stdout);    // file listing

// Set a timeout (seconds) — the command's process group is killed when it expires
const result2 = await client.exec('sleep 100', '/workspace', 5);
// Omit the timeout and the server's --command-timeout default (60s) applies.
```

Multiple `exec` calls can run concurrently. BoxshClient dispatches them across workers and resolves responses in completion order:

```js
const client = new BoxshClient({ workers: 4 });

const [a, b, c] = await Promise.all([
    client.exec('make build',  '/workspace'),
    client.exec('make lint',   '/workspace'),
    client.exec('make test',   '/workspace'),
]);
```

---

## File operations

boxsh has four built-in file tools — `read`, `view_image`, `write`, and `edit`. They run on background threads and never block the RPC event loop.

```js
// Read a text file — returns { content, encoding, mime_type, ... }
const result = await client.read('/workspace/src/main.cpp');
console.log(result.content);   // file text
console.log(result.mime_type); // "text/plain"

// Read a slice (1-indexed start line + line limit)
const first50 = await client.read('/workspace/src/main.cpp', 1, 50);

// Truncated reads report how to continue
if (first50.truncated) {
    const next = await client.read('/workspace/src/main.cpp', first50.next_offset);
}

// Images are read through view_image, which returns an image block + metadata
const img = await client.viewImage('/workspace/logo.png');
console.log(img.mimeType);    // "image/png"
console.log(img.data);        // base64 payload
console.log(img.text);        // "[Image: image/png, 200x133]"
const preview = await client.viewImage('/workspace/photo.jpg', 'low'); // 512px

// Binary files cannot be read as text: the server rejects them with a
// BoxshToolError whose `code` is E_NOT_TEXT (or E_NOT_IMAGE for images).
try {
    await client.read('/workspace/archive.zip');
} catch (err) {
    console.log(err.code);   // "E_NOT_TEXT"
    console.log(err.detail); // { mime: 'application/zip', size: 1234 }
}

// Write a file — creates or overwrites; parent dirs are created automatically
await client.write('/workspace/output.txt', 'hello\n');

// Edit a file — search-and-replace; each oldText must appear exactly once
await client.edit('/workspace/output.txt', [
    { oldText: 'hello', newText: 'world' },
]);
```

---

## Terminal sessions

The terminal tools manage persistent PTY sessions: an interactive process you can type into, with a lossless raw output log next to the rendered screen.

```js
// Start a bash session
const { id, output } = await client.runInTerminal('bash');
console.log(output); // initial screen snapshot

// Send a command and get the updated screen
const result = await client.sendToTerminal(id, 'ls -la\n');
console.log(result.output);

// Run a command line and get its exit code (persistent shell session)
const build = await client.sendToTerminal(id, 'make -j8\n', {
    captureStatus: true,   // → build.commandExitCode
    waitMs: 300000,
});

// Collect output that scrolled off the screen: cursor reads return deltas only
let cursor = 0;
while (true) {
    const chunk = await client.getTerminalOutput(id, { cursor, waitMs: 1000 });
    process.stdout.write(chunk.stream ?? '');   // raw bytes since `cursor`
    cursor = chunk.nextCursor;
    if (chunk.exited) break;
}

// Stop what the session is running (and the rest of that command line)
await client.sendToTerminal(id, undefined, { signal: 'INT' });

// One-shot command: one call, complete output, exit code
const one = await client.runInTerminal('seq 1 100', { waitFor: 'exit', waitMs: 20000 });
console.log(one.exited, one.exitCode, one.stream);

// Terminate the session and free resources (returns the final screen)
const finalOutput = await client.killTerminal(id);

// List sessions (exited ones are hidden unless includeExited is set)
const sessions = await client.listTerminals();
// [{ id, command, alive, cols, rows, total_bytes, ... }, ...]
```

Cursor reads are cheap and safe to poll: without a cursor the session continues where the previous read stopped (an idle session returns zero bytes), every result also carries the rendered screen, and if the log wrapped the result says so through `truncatedBefore` / `droppedBytes` (the log keeps 1 MiB per session by default).

---

## Sandbox isolation

With `sandbox` enabled, commands run inside an OS-native sandbox (Linux namespaces or macOS Seatbelt), separated from the host. You can further isolate the network:

```js
const client = new BoxshClient({
    sandbox:  true,
    newNetNs: true,   // Isolated network namespace (no external access)
});
```

---

## COW Bind (Overlay Filesystem)

COW bind is the primary usage pattern for boxsh: mount a read-only source directory as a copy-on-write workspace. Commands can read and write freely, but all modifications land in the destination directory while the source remains untouched.

```
Bind parameters:
  src  Read-only base directory (your project/repository)
  dst  Writable destination directory (all modifications go here)
```

```js
import { BoxshClient } from 'boxsh.js';
import fs from 'node:fs';

// Prepare destination directory
const dst = '/tmp/sandbox/dst';
fs.mkdirSync(dst, { recursive: true });

const client = new BoxshClient({
    sandbox: true,
    binds: [{
        mode: 'cow',
        src: '/home/user/myproject',   // read-only base
        dst,                            // modifications land here
    }],
});

// Inside the sandbox, dst is a COW copy of myproject
await client.exec('npm install', dst);

// Read/write files via built-in tools (RPC, no shell round-trip needed)
const pkg = await client.read(`${dst}/package.json`);
await client.write(`${dst}/result.txt`, 'done\n');

await client.close();

// At this point dst/ contains all modifications; base is completely untouched.
// You can commit, archive, or simply delete dst/ to discard changes.
```

The destination directory persists across sessions. To resume a previous session, create a new BoxshClient pointing at the same `dst` directory.

---

## Inspecting changes

`getChanges` scans the COW destination directory against the base and returns all added, modified, and deleted files. `formatChanges` formats the result as human-readable text.

Both functions run on the host side (inside the Node.js process) and do not require a running boxsh instance.

```js
import { getChanges, formatChanges } from 'boxsh.js';

const changes = getChanges({
    upper: '/tmp/sandbox/dst',
    base:  '/home/user/myproject',
});
// [{ path: 'package-lock.json', type: 'modified' },
//  { path: 'result.txt',        type: 'added' }]

console.log(formatChanges(changes));
// M	package-lock.json
// A	result.txt
```

On Linux overlay workspaces, deletions are tracked via whiteout files (`.wh.<name>`). On macOS clone-based workspaces, `getChanges` uses the COW snapshot manifest to report deletions and to avoid flagging untouched cloned files as modified.

---

## `shellQuote`

POSIX single-quote escaping for safely interpolating variables into shell commands:

```js
import { shellQuote } from 'boxsh.js';

const userInput = "hello'world";
await client.exec(`echo ${shellQuote(userInput)}`);
// Executed safely — no injection
```

---

## API reference

### `new BoxshClient(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `boxshPath` | `string` | `$BOXSH` → `'boxsh'` | Path to the boxsh binary |
| `workers` | `number` | `1` | Number of pre-forked workers |
| `sandbox` | `boolean` | `false` | Enable namespace sandbox |
| `newNetNs` | `boolean` | `false` | Isolate network |
| `binds` | `BoxshBindOption[]` | — | Bind mount configuration (ro/wr/cow) |

### `client.exec(cmd, cwd?, timeout?) → Promise<{ exitCode, stdout, stderr }>`

Execute a shell command. `timeout` is in seconds.

### `client.read(path, offset?, limit?) → Promise<ReadResult>`

Read a text file. `offset` is the 1-based start line and `limit` is the maximum number of lines (default 2000, also capped at 50 KiB per call). `ReadResult` has fields: `content` (the file text), `encoding` (always `"text"`), `mime_type`, and optionally `line_count`, `truncated`, `file_size` (bytes, always present), `total_lines`, `next_offset` (only when a further line exists) and `empty_reason` (`empty_file` | `offset_beyond_eof`). Targets must be regular files: FIFOs and sockets are rejected with `E_INVALID_ARGUMENT` (+ `detail.kind`).

Binary files are rejected: images with `E_NOT_IMAGE` (use `viewImage`) and other binaries with `E_NOT_TEXT` (use `exec` with `file`/`xxd`/`strings`). Failures throw a `BoxshToolError` carrying `code` and `detail`.

### `client.viewImage(path, detail?) → Promise<ViewImageResult>`

View an image (png, jpeg, gif, bmp, tiff, webp). `detail: 'low'` returns a 512px preview instead of the 2000px default. Animated GIF/APNG/WebP sources are re-encoded so only the first frame comes back. Formats outside the model-native set (jpeg/png/gif/webp) are converted to PNG/JPEG with `converted: true`, so the payload is always something a multimodal model can ingest. Other image formats (avif, heic, jxl, …) are rejected with `E_UNSUPPORTED_FORMAT`. `ViewImageResult` has fields: `data` (base64), `mimeType`, `width`, `height`, `original_width`, `original_height`, `was_resized`, `size`, `animated`, `converted`, and the model-facing `text`.

### `client.write(path, content) → Promise<void>`

Create or overwrite a file. Parent directories are created automatically if needed.

### `client.edit(path, edits) → Promise<void>`

Apply search-and-replace edits. `edits` is an array of `{ oldText, newText }`. Each `oldText` must appear exactly once in the file. All edits match against the original file content (not the result of a previous edit).

### `client.runInTerminal(command, opts?) → Promise<RunInTerminalResult>`

Start a PTY session running `command`. Returns `{ id, output, exited, exitCode }`. `opts` may include `explanation`, `goal`, `cols`, `rows`.

### `client.sendToTerminal(id, command) → Promise<TerminalOutputResult>`

Write text to a session's stdin, wait up to 500 ms, and return the updated screen snapshot `{ output, exited, exitCode }`. Append `\n` to execute as a shell command.

### `client.getTerminalOutput(id) → Promise<TerminalOutputResult>`

Wait up to 500 ms for new output and return the current screen snapshot. Use this to poll long-running commands until `exited` is `true`.

### `client.killTerminal(id) → Promise<string>`

Terminate the session and free resources. Returns the final screen snapshot.

### `client.listTerminals() → Promise<TerminalSession[]>`

Return metadata for all active and recently-exited sessions.

### `client.close() → Promise<void>`

Close stdin and wait for the boxsh process to exit.

### `client.terminate() → void`

Send SIGTERM immediately.

### `getChanges({ upper, base }) → Array<{ path, type }>`

Scan the destination directory and return a list of changes relative to base. `type` is `'added'`, `'modified'`, or `'deleted'`.

### `formatChanges(changes) → string`

Format a change list as `A/M/D\tpath` text.

---

## Testing

```sh
node --test test/all.test.mjs
```
