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

`exec(cmd, cwd?, timeout?)` runs a shell command in a boxsh worker, returning the exit code, stdout, and stderr.

```js
// Specify a working directory
const result = await client.exec('ls -la', '/workspace');
console.log(result.exitCode);  // 0
console.log(result.stdout);    // file listing

// Set a timeout (seconds) — the worker is killed via SIGALRM when it expires
const result2 = await client.exec('sleep 100', '/workspace', 5);
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

boxsh has three built-in file tools — `read`, `write`, and `edit`. They run on background threads and never block the RPC event loop.

```js
// Read a file — optionally specify a start line and line limit
const content = await client.read('/workspace/src/main.cpp');
const first50 = await client.read('/workspace/src/main.cpp', 1, 50);

// Write a file — full replacement
await client.write('/workspace/output.txt', 'hello\n');

// Edit a file — search-and-replace; each oldText must appear exactly once
const { diff, firstChangedLine } = await client.edit('/workspace/output.txt', [
    { oldText: 'hello', newText: 'world' },
]);
console.log(diff);  // unified diff format
```

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

Deletions are tracked via whiteout files (`.wh.<name>`), which `getChanges` detects automatically.

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

### `client.read(path, offset?, limit?) → Promise<string>`

Read file contents. `offset` is the 1-based start line; `limit` is the maximum number of lines.

### `client.write(path, content) → Promise<void>`

Create a new file. Fails if the file already exists — use `edit` to modify existing files.

### `client.edit(path, edits) → Promise<{ diff, firstChangedLine }>`

Apply search-and-replace edits. `edits` is an array of `{ oldText, newText }`. Each `oldText` must appear exactly once in the file. All edits match against the original file content (not the result of a previous edit). Returns a unified diff and the first changed line number.

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
