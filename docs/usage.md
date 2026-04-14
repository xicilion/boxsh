# boxsh Usage Guide

boxsh is a sandboxed POSIX shell and MCP server with built-in OS-native isolation.

It works in two main modes: **Shell mode** — a drop-in `/bin/sh` replacement with optional sandboxing and overlay COW; and **MCP / RPC mode** — an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server over stdio that AI agents, build systems, or orchestration layers can drive programmatically.

This guide walks through the core scenarios boxsh is built for, with concrete examples you can run directly.

---

## Table of Contents

- [How it Works](#how-it-works)
  - [Namespace Sandbox](#namespace-sandbox)
  - [Overlayfs Copy-on-Write](#overlayfs-copy-on-write)
  - [Two Modes](#two-modes)
- [Scenario 1: AI Agent Command Sandbox](#scenario-1-ai-agent-command-sandbox)
- [Scenario 2: Zero-cost Directory Forking](#scenario-2-zero-cost-directory-forking)
- [Scenario 3: Session Checkpointing and Branching](#scenario-3-session-checkpointing-and-branching)
- [Scenario 4: Parallel Isolated Workers](#scenario-4-parallel-isolated-workers)
- [Scenario 5: Deployment / Migration Dry-runs](#scenario-5-deployment--migration-dry-runs)
- [Scenario 6: Isolated Development Shell](#scenario-6-isolated-development-shell)
- [Scenario 7: Agent Interactive Terminal](#scenario-7-agent-interactive-terminal)
- [Reference](#reference)
  - [Installation](#installation)
  - [Shell Mode](#shell-mode)
  - [Quick-try Mode](#quick-try-mode)
  - [RPC Mode](#rpc-mode)
  - [Sandbox Flags](#sandbox-flags)
  - [Node.js SDK](#nodejs-sdk)

---

## How it Works

boxsh is a single static binary with a built-in POSIX shell. It uses OS-native sandbox mechanisms — Linux namespaces and overlayfs on Linux, Seatbelt and clonefile on macOS — to provide process-level filesystem isolation. No root privileges, no Docker, no daemon, no runtime dependencies.

### Namespace Sandbox

When you pass `--sandbox`, boxsh creates an isolated environment for the shell process. From the outside, it's still your normal user process. From the inside, it looks and behaves like a minimal container:

| Capability | What it means for you |
|---|---|
| **User mapping** | You appear as root inside the sandbox, but you're still your normal user on the host. No `sudo` needed. |
| **Private mounts** | Overlay mounts, bind mounts, and tmpfs are visible only inside the sandbox. The host mount table is unaffected. |
| **Network isolation** (`--new-net-ns`) | The sandbox gets an empty network stack. No outbound connections — `curl`, `wget`, `npm install` (from registry) all fail. |

With `--sandbox`, boxsh switches the root to a clean tmpfs and automatically includes standard system directories (`/usr`, `/proc`, `/dev`, `/tmp`, and selected `/etc` files). Only the mounts you specify are accessible; everything else is hidden.

```mermaid
flowchart TB
    subgraph Host["Host"]
        BoxshProc["boxsh process"]
    end

    BoxshProc -- "--sandbox" --> Sandbox

    subgraph Sandbox["Sandboxed Environment"]
        direction TB
        UID["Appears as root (still unprivileged on host)"]
        MNT["Private mount table"]
        PID["Isolated PID tree"]
        NET["Empty network stack"]

        subgraph RootFS["Clean Root"]
            Overlay["/workspace — overlay"]
            Proc["/proc"]
            Tmp["/tmp"]
        end
    end

    MNT --> RootFS
```

### Overlayfs Copy-on-Write

The `--bind cow:` flag mounts a directory with copy-on-write semantics. Your original files serve as a read-only base layer. A separate destination directory captures all modifications:

- **Reads** go straight to the original files — zero copy, zero overhead.
- **Writes** are automatically redirected to the destination directory. The original file is never touched.
- **Deletes** create a marker (whiteout) in the destination directory. The original file remains intact.

```mermaid
flowchart LR
    subgraph Merged["/workspace (merged view)"]
        direction TB
        F1["README.md"]
        F2["src/main.cpp"]
        F3["node_modules/ (new)"]
    end

    subgraph Upper["dst/ (writable)"]
        U1["node_modules/"]
        U2[".wh.temp.txt (whiteout)"]
    end

    subgraph Lower["src/ (read-only, original project)"]
        L1["README.md"]
        L2["src/main.cpp"]
        L3["temp.txt"]
    end

    Lower -- "read-through" --> Merged
    Upper -- "override / add" --> Merged
```

No matter how many `npm install`, `make`, or `rm -rf` commands run inside the sandbox, the original directory never changes. All modifications accumulate in the destination directory — you can inspect them with `find dst/` or use the SDK's `getChanges()` to get a structured list of added, modified, and deleted files.

Multiple lower layers are also supported — boxsh uses this to enable session branching (see Scenario 3).

### Two Modes

boxsh operates in two modes for different integration needs:

```mermaid
flowchart TB
    CLI["boxsh"]

    CLI -- "default" --> ShellMode
    CLI -- "--rpc --workers N" --> RPCMode

    subgraph ShellMode["Shell Mode"]
        direction TB
        SM1["Apply sandbox"] --> SM2["Start shell"]
        SM2 --> SM3["Interactive prompt\nor -c 'cmd'"]
    end

    subgraph RPCMode["MCP / RPC Mode"]
        direction TB
        Coord["Coordinator\n(reads JSON-RPC 2.0 from stdin)"]
        Coord --> W1["Worker 1"]
        Coord --> W2["Worker 2"]
        Coord --> WN["Worker N"]
    end
```

**Shell mode** is a sandboxed `/bin/sh`. You get an interactive shell (or run a one-liner with `-c`). Good for manual exploration and scripting.

**MCP / RPC mode** is for programmatic integration. boxsh implements the MCP protocol over stdio — AI clients connect to it as a sandboxed code execution server. It reads JSON-RPC 2.0 requests from stdin and writes responses to stdout:

1. You send a request: `{"method":"tools/call", "params":{"name":"bash", "arguments":{"command":"make"}}}`
2. The coordinator dispatches it to an available worker
3. The worker runs the command and collects stdout/stderr
4. You receive: `{"result":{"content":[...], "structuredContent":{"exit_code":0, "stdout":"..."}}}`

Multiple workers run in parallel. Responses arrive in completion order, not submission order. File operations (read / write / edit) do not occupy a worker slot.

```mermaid
sequenceDiagram
    participant Agent as Agent / SDK
    participant Coord as Coordinator
    participant W1 as Worker 1
    participant W2 as Worker 2

    Agent->>Coord: tools/call bash "npm install"
    Agent->>Coord: tools/call bash "npm test"
    Coord->>W1: dispatch cmd 1
    Coord->>W2: dispatch cmd 2
    W2-->>Coord: {exit_code: 0} (faster)
    Coord-->>Agent: {"id":"2", ...}
    W1-->>Coord: {exit_code: 0}
    Coord-->>Agent: {"id":"1", ...}
```

> Responses arrive as each command finishes — fast commands don't wait for slow ones.

---

## Scenario 1: AI Agent Command Sandbox

**Problem.** You're building an AI agent that generates and runs shell commands — installing packages, editing files, running tests. You need to let it execute arbitrary commands, but you can't let it touch the host filesystem or reach the network. If something goes wrong, you need to throw everything away and start over.

**Conventional approach: Docker.** The standard answer is to run the agent inside a Docker container with a bind-mounted volume:

```sh
docker run --rm --network none -v /home/user/myproject:/workspace ubuntu bash -c 'cd /workspace && npm install'
```

This works, but has real costs:

- **Cold start overhead.** Pulling/building images, launching the container runtime, setting up the network bridge — even a warm start takes 500ms–2s. boxsh starts in under 5ms.
- **Heavy dependency.** Requires dockerd, containerd, and runc. Root or a Docker socket. On CI you need Docker-in-Docker or a privileged runner. boxsh is a static binary with no runtime dependencies.
- **Coarse filesystem isolation.** A bind mount exposes the directory read-write. To protect the host you need a volume copy or a multi-stage setup. With boxsh the overlay is built in — the project is always read-only; writes go to a separate directory automatically.
- **No built-in diff.** After the container exits, you have to diff the volume yourself. boxsh's `getChanges()` (SDK) or `find dst/` gives you the exact list of added, modified, and deleted files.
- **No session branching.** You can't fork a running container into two divergent sessions without committing an image. boxsh branches by stacking overlays (see Scenario 3).

| | Docker | boxsh |
|---|---|---|
| Startup | 500ms–2s (warm) | < 5ms |
| Dependencies | dockerd + containerd + runc | Single static binary |
| Filesystem isolation | Bind mount (manual COW) | Built-in overlay COW |
| Network isolation | Bridge + iptables | `--new-net-ns` (empty network) |
| Diff after run | Manual | `getChanges()` / `find dst/` |
| Session branching | Commit image + new container | Stack overlays |

**Solution.** Give the agent a boxsh instance with `--sandbox`, `--new-net-ns`, and `--bind cow:`. The agent sees a full working directory it can read and write freely, but every modification lands in a throwaway destination directory. The network is cut off. The host is untouched.

```sh
# Prepare the sandbox workspace
project=/home/user/myproject
sandbox=/tmp/agent-session
mkdir -p "$sandbox/dst"

# Start boxsh in RPC mode — the agent talks to this over stdin/stdout
boxsh --rpc --workers 2 --sandbox --new-net-ns \
  --bind cow:"$project:$sandbox/dst"
```

Now the agent sends JSON-RPC 2.0 requests:

```json
{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/agent-session/dst && npm install"}}}
{"jsonrpc":"2.0","id":"2","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/agent-session/dst && npm test"}}}
```

Inside the sandbox, `$sandbox/dst` looks like a complete copy of the project — the agent can `npm install`, create files, delete files, run builds. But:

- **All writes go to `$sandbox/dst/`**. The original project is never modified.
- **Outbound network is blocked** (`--new-net-ns`). The agent can't `curl` or `wget` anything from the internet; `npm install` only works if the packages are already in the overlay.

When the agent finishes, you inspect the destination directory to decide what to keep:

```sh
# See what changed
find "$sandbox/dst" -type f

# Happy with the result? Copy it back
cp -a "$sandbox/dst/." "$project/"

# Not happy? Discard everything
rm -rf "$sandbox"
```

**With the Node.js SDK**, the same workflow looks like:

```js
import { BoxshClient, getChanges, formatChanges } from 'boxsh.js';
import fs from 'node:fs';

const sandbox = '/tmp/agent-session';
fs.mkdirSync(`${sandbox}/dst`, { recursive: true });

const client = new BoxshClient({
    sandbox: true,
    newNetNs: true,
    binds: [{
        mode: 'cow',
        src: '/home/user/myproject',
        dst: `${sandbox}/dst`,
    }],
});

await client.exec('npm install', `${sandbox}/dst`);
await client.exec('npm test',    `${sandbox}/dst`);

// Use built-in file tools — no shell round-trip needed
const pkg = await client.read(`${sandbox}/dst/package.json`);
await client.write(`${sandbox}/dst/notes.txt`, 'Agent completed run.\n');
await client.edit(`${sandbox}/dst/config.js`, [
    { oldText: 'DEBUG = false', newText: 'DEBUG = true' },
]);

await client.close();

// Inspect what the agent actually changed
const changes = getChanges({ upper: `${sandbox}/dst`, base: '/home/user/myproject' });
console.log(formatChanges(changes));
// M  package-lock.json
// A  node_modules/
// A  notes.txt
// M  config.js
```

---

## Scenario 2: Zero-cost Directory Forking

**Problem.** You want to experiment with a directory — run a build, install dependencies, modify config files — without actually changing anything. Git stash doesn't work because untracked files get lost, and `cp -a` is too slow for large trees.

**Conventional approaches:**

| Approach | Downsides |
|---|---|
| `cp -a` | O(n) time and disk — copying a 10 GB tree takes minutes and doubles disk usage |
| `git stash` / `git checkout -b` | Only tracks git-managed files; untracked files, node_modules, build artifacts are invisible |
| `btrfs subvolume snapshot` | Requires btrfs filesystem; not available on ext4, xfs, or cloud VMs with EBS |
| `rsync --link-dest` | Hard links break COW semantics — a write to one copy silently modifies the other |
| Docker volume | Requires container runtime; coarse granularity; no inline diff |

All of these either copy data (slow, wasteful) or require a specific filesystem/tool.

**Solution with boxsh.** Mount the directory as the source of a COW bind. Reads go straight to the original files (zero copy). Writes land in a separate destination directory. The original directory is never touched.

```sh
# "Fork" a 10 GB sysroot in zero time
base=/opt/sysroot
dst=/tmp/experiment/dst
mkdir -p "$dst"

boxsh --sandbox --bind cow:"$base:$dst" -c '
    # Install a package "experimentally"
    cd /tmp/experiment/dst
    make install PREFIX=/tmp/experiment/dst/usr
    echo "Installed files:"
    find /tmp/experiment/dst/usr -type f
'

# The original /opt/sysroot is completely untouched
# All installed files are physically in $dst/usr/
```

This works for **any directory** — it's not limited to git repos. You can fork a Python venv, a Docker layer, a database data directory, or a compiled build tree.

**Key point:** Reading 100,000 files from the base layer costs nothing extra — they are served directly from the original directory. Only files you actually modify consume additional disk space.

---

## Scenario 3: Session Checkpointing and Branching

**Problem.** An agent has been working for 20 minutes — installing packages, editing files, running tests. You want to save this state, try two different approaches from here, and compare the results. Or you want to roll back to a known-good point if the next step fails.

**Conventional approaches:**

| Approach | Downsides |
|---|---|
| `git branch` + `git stash` | Only covers tracked files; ignores node_modules, build artifacts, .env files. Creating a branch doesn't snapshot the working tree — you have to commit or stash first, and stash doesn't stack cleanly for multiple branches. |
| VM snapshot (VirtualBox, QEMU) | Full machine snapshot — GB-scale, takes seconds to minutes. Restoring means rebooting the VM. Cannot branch two snapshots and run them simultaneously. |
| Docker commit + run | `docker commit` creates a new image layer, then `docker run` starts a new container. Heavyweight: each commit is a full layer, and you can't share writable state between two forked containers. |
| `cp -a` the working directory | O(n) copy. For a 5 GB directory with 200K files, this takes minutes. Two branches = two full copies = 10 GB extra disk. |
| Filesystem snapshot (btrfs/ZFS) | Fast, but requires a specific filesystem. Not available on ext4, xfs, or typical cloud VMs. |

**Solution with boxsh.** overlayfs can be stacked. The current session's destination directory becomes the read-only source for the next level. The original session is untouched — you just create new overlays on top of it.

### How it works

Suppose session A is running with this layout:

```
base (your project, read-only)
  └── dst_a (session A's modifications)
```

You want to branch into two new sessions without disturbing session A. Stop the boxsh process, then stack two new overlays on top of `dst_a`:

```
base (read-only)
  └── dst_a (session A, now frozen as source)
        ├── dst_a1 (branch A1 — new writes go here)
        └── dst_b  (branch B  — new writes go here)
```

Both branches see the full state of session A, but new writes go to their own destination directories. Session A's `dst_a` is never modified again.

### Branching in practice

```sh
# Session A has been running with:
#   --bind cow:"$project:$session/dst_a"
# Stop the boxsh process. dst_a now contains all of A's modifications.

project=/home/user/myproject
session=/tmp/agent-session

# Create new dst dirs for each branch
mkdir -p "$session"/{dst_a1,dst_b}

# Branch A1: continues where A left off
boxsh --rpc --sandbox \
  --bind cow:"$session/dst_a:$session/dst_a1" &
pid_a1=$!

# Branch B: also continues where A left off
boxsh --rpc --sandbox \
  --bind cow:"$session/dst_a:$session/dst_b" &
pid_b=$!

# Send different commands to each branch...
# Branch A1: try lodash
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd '$session'/dst_a1 && npm install lodash"}}}' \
  > /proc/$pid_a1/fd/0

# Branch B: try underscore
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd '$session'/dst_b && npm install underscore"}}}' \
  > /proc/$pid_b/fd/0
```

After both branches finish, compare:

```sh
diff <(find "$session/dst_a1" -type f | sort) \
     <(find "$session/dst_b"  -type f | sort)
```

`dst_a` is completely untouched. You can branch again from it, or resume session A by creating yet another overlay on top of it.

### Rolling back

Rolling back is just discarding the branch's destination directory and creating a fresh one:

```sh
# Branch A1 went wrong — discard and retry
rm -rf "$session/dst_a1"
mkdir -p "$session/dst_a1"
# Restart boxsh with the same --bind cow: — back to session A's state
```

### Saving a checkpoint

You can also archive a session's destination directory for long-term storage:

```sh
tar czf checkpoint-a.tar.gz -C "$session/dst_a" .
```

Restore later by extracting into a new directory and using it as a lower layer.

---

## Scenario 4: Parallel Isolated Workers

**Problem.** You have a large read-only tree — a `node_modules` directory, a Python virtual environment, a compiled sysroot — and you want to run multiple tasks against it concurrently. Each task might write temp files, modify configs, or produce build artifacts. They must not interfere with each other.

**Conventional approach: `git worktree`.** Git worktree creates a separate working directory linked to the same repository. Each worktree gets its own checkout:

```sh
git worktree add ../build-x86    main
git worktree add ../build-aarch64 main
git worktree add ../test-suite   main
```

This works, but has real limitations:

- **Slow for large repos.** Each worktree is a full checkout — for a 2 GB monorepo, creating 8 worktrees takes minutes and consumes 16 GB of disk.
- **Git-only.** Doesn't work on non-git directories — `node_modules`, Python venvs, compiled sysroots, database data directories.
- **Cleanup required.** Worktrees must be removed with `git worktree remove`; stale worktrees accumulate and confuse tooling.
- **No write isolation between workers.** Two worktrees on the same branch can write to shared git state (index, refs) and conflict.

**Solution with boxsh.** Share one read-only base across all workers via COW bind. Each worker gets its own copy-on-write view — no data is duplicated. Only files that a worker actually modifies consume additional disk space.

| | `git worktree` | boxsh COW bind |
|---|---|---|
| Setup time | Full checkout per worktree | Instant (kernel mount) |
| Disk cost | Full copy per worktree | Only modified files |
| Works on non-git dirs | No | Yes |
| Write isolation | Shared git state | Complete (per-process COW) |
| Cleanup | `git worktree remove` | `rm -rf dst/` |

```sh
# 8 workers, all sharing the same base, each with COW semantics
boxsh --rpc --workers 8 --sandbox \
  --bind cow:"/opt/sysroot:/tmp/parallel/dst"
```

Send 8 requests at once — they execute in parallel:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":"test-1","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make test SUITE=unit"}}}' \
  '{"jsonrpc":"2.0","id":"test-2","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make test SUITE=integration"}}}' \
  '{"jsonrpc":"2.0","id":"test-3","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make test SUITE=e2e"}}}' \
  '{"jsonrpc":"2.0","id":"build-1","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make build ARCH=x86_64"}}}' \
  '{"jsonrpc":"2.0","id":"build-2","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make build ARCH=aarch64"}}}' \
  '{"jsonrpc":"2.0","id":"lint","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make lint"}}}' \
  '{"jsonrpc":"2.0","id":"docs","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make docs"}}}' \
  '{"jsonrpc":"2.0","id":"bench","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/parallel/dst && make bench"}}}' \
| boxsh --rpc --workers 8 --sandbox \
    --bind cow:"/opt/sysroot:/tmp/parallel/dst"
```

Responses stream back as each task finishes — fast tasks don't wait for slow ones. If a worker crashes (OOM, timeout), the coordinator respawns it automatically and returns an error response for that request only. Other workers are unaffected.

**With the Node.js SDK:**

```js
import { BoxshClient } from 'boxsh.js';

const client = new BoxshClient({
    workers: 8,
    sandbox: true,
    binds: [{
        mode: 'cow',
        src: '/opt/sysroot',
        dst: '/tmp/parallel/dst',
    }],
});

const results = await Promise.all([
    client.exec('make test SUITE=unit',        '/tmp/parallel/dst'),
    client.exec('make test SUITE=integration', '/tmp/parallel/dst'),
    client.exec('make test SUITE=e2e',         '/tmp/parallel/dst'),
    client.exec('make build ARCH=x86_64',      '/tmp/parallel/dst'),
    client.exec('make build ARCH=aarch64',     '/tmp/parallel/dst'),
]);

for (const r of results) {
    console.log(`exit: ${r.exitCode}`);
}

await client.close();
```

---

## Scenario 5: Deployment / Migration Dry-runs

**Problem.** You want to run `make install`, a package upgrade, or a database migration, but you need to see exactly which files will be created, modified, or deleted **before** committing the change. Rolling back a failed migration is painful; previewing it is free.

**Conventional approaches:**

| Approach | Downsides |
|---|---|
| `make install DESTDIR=/tmp/staging` | Only works if the Makefile respects DESTDIR. Many build systems, scripts, and package managers hard-code paths. Database migrations don't have a DESTDIR equivalent at all. |
| `apt-get --simulate` / `dnf --assumeno` | Simulation only — tells you what **would** happen but doesn't actually run post-install scripts, config file merges, or triggers. The real result can differ from the preview. |
| LVM snapshot + rollback | Creates a block-level snapshot of the entire volume. Works, but: requires LVM setup, the snapshot degrades I/O performance, and you have to reboot or remount to roll back. Not practical on cloud VMs with EBS/managed disks. |
| Docker: build a test image | `COPY . /app && RUN make install` in a Dockerfile. Gives you a diff via `docker diff`, but requires dockerd, an image build, and doesn't easily let you compare the result to the host filesystem. |
| VM snapshot | Same as LVM but even heavier — snapshot the entire machine, try the operation, revert if it fails. Minutes of downtime. |

**Solution with boxsh.** Run the operation on a COW overlay. The original filesystem is read-only. After the operation completes, inspect the destination directory to see every file that was touched.

### Preview a `make install`

```sh
mkdir -p /tmp/dryrun/dst

echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"make install PREFIX=/tmp/dryrun/dst/usr"}}}' \
| boxsh --rpc --sandbox \
    --bind cow:"/:/tmp/dryrun/dst"

# What would be installed?
echo "--- Files that would be created or modified ---"
find /tmp/dryrun/dst -type f | sed 's|^/tmp/dryrun/dst||'
```

### Preview a package upgrade

```sh
mkdir -p /tmp/upgrade/dst

echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"apt-get install -y --simulate nginx 2>&1; dpkg --configure -a"}}}' \
| boxsh --rpc --sandbox \
    --bind cow:"/:/tmp/upgrade/dst"

# Inspect exactly which config files, binaries, and libraries would change
find /tmp/upgrade/dst -type f | head -20
```

### Approve or discard

The workflow always ends the same way:

```sh
# Option A: looks good — apply for real
cp -a /tmp/dryrun/dst/. /

# Option B: something's wrong — throw it away
rm -rf /tmp/dryrun
```

No rollback mechanism needed. The change never happened until you explicitly copy it.

This scenario also works well in **shell mode** — run the operation directly without RPC:

```sh
mkdir -p /tmp/dryrun/dst

boxsh --sandbox --bind cow:"$PWD:/tmp/dryrun/dst" -c '
    make install PREFIX=/tmp/dryrun/dst/usr
'

# Inspect what would have been installed
find /tmp/dryrun/dst -type f | sed 's|^/tmp/dryrun/dst||'
```

**With the Node.js SDK:**

```js
import { BoxshClient, getChanges, formatChanges } from 'boxsh.js';

const client = new BoxshClient({
    sandbox: true,
    binds: [{
        mode: 'cow',
        src: '/',
        dst: '/tmp/dryrun/dst',
    }],
});

await client.exec('make install PREFIX=/tmp/dryrun/dst/usr');
await client.close();

// Inspect what would change
const changes = getChanges({ upper: '/tmp/dryrun/dst', base: '/' });
console.log(formatChanges(changes));
// A  usr/bin/myapp
// A  usr/lib/libmyapp.so
// A  usr/share/man/man1/myapp.1.gz
```

---

## Scenario 6: Isolated Development Shell

**Problem.** You want to experiment in a project — try a different build configuration, install an experimental package, run a destructive migration script — without setting up any tooling or worrying about cleanup. You just want to open a shell, do whatever you want, and walk away without consequences.

**Conventional approaches:**

| Approach | Downsides |
|---|---|
| Docker interactive shell (`docker run -it -v ...`) | Needs dockerd running, 500ms–2s startup, different userland (Ubuntu/Alpine inside vs host), file ownership mismatches on bind-mounted volumes |
| `distrobox` / `toolbox` | Container-based (requires podman/docker), designed for persistent managed environments — not throwaway sandboxes. Installing one is a multi-step process. |
| `chroot` | Requires root, no COW — you must manually copy the filesystem tree. No mount/network/PID isolation. |
| `firejail` / `bubblewrap` | Security-focused; complex profile/policy files to get overlay + network right. Not designed as an interactive development shell. |
| Git branch + stash | Only covers tracked files. `node_modules/`, build artifacts, `.env`, database files are all invisible to git. |

**Solution with boxsh.** Open an interactive sandboxed shell with overlay in one command:

```sh
mkdir -p /tmp/dev/dst

boxsh --sandbox --bind cow:"$PWD:/tmp/dev/dst"
```

You land in an interactive shell with line editing (libedit). `/tmp/dev/dst` is a COW view of your project — you can read everything, and every write goes to `/tmp/dev/dst`. The host project directory is never modified.

```sh
# Inside the sandboxed shell
cd /tmp/dev/dst
npm install           # node_modules goes to dst, not your real project
vim config.js         # edits land in dst
make build            # build artifacts go to dst
rm -rf src/           # original src/ is untouched — only a whiteout is created in dst
```

When you exit the shell, inspect and decide:

```sh
# See what you did
find /tmp/dev/dst -type f

# Keep it? Copy back.
cp -a /tmp/dev/dst/. "$PWD/"

# Discard it? One command.
rm -rf /tmp/dev
```

Add `--new-net-ns` to block outbound network:

```sh
boxsh --sandbox --new-net-ns \
  --bind cow:"$PWD:/tmp/dev/dst"
```

**Why this beats the alternatives:**

- **Zero startup overhead.** Under 5ms. No image pull, no container runtime.
- **Same userland.** You're running the host's files directly, not a different distro inside a container. Your tools, paths, and libraries are all there.
- **Throwaway by default.** No cleanup commands needed — `rm -rf /tmp/dev` and it's as if nothing happened.
- **Works on any directory.** Not limited to git repos. Fork a Python venv, a compiled sysroot, a database data directory.

---

## Scenario 7: Agent Interactive Terminal

**Problem.** You're building an AI agent that needs a real interactive terminal — not just a request/response API. The agent needs to handle interactive programs (vim, python REPL, top), respond to prompts ("Are you sure? [y/n]"), and maintain shell state across commands (environment variables, working directory, shell functions). But you can't let the agent touch the host system.

**Conventional approaches:**

| Approach | Downsides |
|---|---|
| Docker exec with PTY (`docker exec -it`) | Needs a running container + dockerd. Cold start is slow. Agent must manage container lifecycle. No built-in COW for the workspace. |
| SSH into a VM | Minutes to provision. Per-VM cost. Heavy for a throwaway session. |
| `screen` / `tmux` in a chroot | Fragile multi-step setup. No mount/network/PID isolation. No COW. |
| Spawn `/bin/sh` with PTY | No isolation at all — agent can `rm -rf /`, `curl` arbitrary URLs, kill host processes. |

**Solution with boxsh.** Allocate a PTY and connect it to boxsh with sandbox + overlay. The agent gets a real interactive shell session — tab completion, job control, signal handling — inside a fully isolated namespace.

```python
import subprocess, os, pty

# Create a PTY pair
parent_fd, child_fd = pty.openpty()

proc = subprocess.Popen(
    ['boxsh', '--sandbox', '--new-net-ns',
     '--bind', f'cow:{project}:{dst}'],
    stdin=child_fd, stdout=child_fd, stderr=child_fd,
    preexec_fn=os.setsid,
)
os.close(child_fd)

# Agent interacts via parent_fd — reads output, writes commands
os.write(parent_fd, b'cd $dst && ls\n')
output = os.read(parent_fd, 4096)

os.write(parent_fd, b'npm install\n')
# ... read output, parse, decide next action ...

os.write(parent_fd, b'exit\n')
proc.wait()
os.close(parent_fd)
```

Or for simpler non-interactive use, pipe commands directly:

```sh
# Agent sends commands one at a time, reads stdout/stderr
boxsh --sandbox --bind cow:"$project:$dst" -c '
    cd "$dst"
    npm install
    npm test
'
```

**What the agent gets:**

- A real POSIX shell with full syntax: pipes, redirections, variables, functions, subshells
- Shell state persists across commands (cd, export, aliases)
- Interactive programs work (python REPL, less, vi) when connected via PTY
- The host filesystem is read-only — all writes land in the COW destination directory
- Network is isolated (with `--new-net-ns`) — no exfiltration risk

**When to use Shell mode vs RPC mode:**

| | Shell Mode | RPC Mode |
|---|---|---|
| Protocol | stdin/stdout text stream | JSON-RPC 2.0 (MCP-compatible) |
| Concurrency | Sequential (one command at a time) | Parallel (multi-worker) |
| Output format | Raw text (agent must parse) | Structured JSON (`content` + `structuredContent`) |
| Interactive programs | Yes (with PTY) | No |
| Shell state | Persists (cd, export, aliases) | Isolated per command |
| Built-in file tools | No | read / write / edit |
| Best for | Interactive sessions, stateful workflows | Programmatic automation, parallel execution |

---

## Reference

### Installation

Build from source (requires CMake ≥ 3.16, GCC or Clang with C11/C++17; supports Linux kernel ≥ 3.8 and macOS ≥ 10.12):

```sh
cmake -B build
cmake --build build
```

The resulting binary is `build/boxsh`. Copy it anywhere on your `$PATH`.

### Shell Mode

By default boxsh acts as a drop-in POSIX shell:

```sh
# Interactive shell with line editing (libedit)
boxsh

# Run a command string
boxsh -c 'echo hello world'

# Run a script
boxsh script.sh arg1 arg2

# Pipe input
echo 'ls -la' | boxsh
```

All dash features work: pipelines, redirections, variables, arithmetic, heredocs, etc.

### Quick-try Mode

`--try` launches an ephemeral sandboxed shell on the current directory in one command. No directories to prepare, no flags to remember:

```sh
boxsh --try
```

What it does:

1. Mounts the current directory as a copy-on-write overlay — you see all your files, but every write goes to a temporary directory.
2. Enters an isolated namespace (private mount table, appears as root inside).
3. When you exit the shell, the temporary layer is kept and its path is printed to stderr — inspect it to see exactly what changed, then discard when done.

This is equivalent to the manual form:

```sh
mkdir -p /tmp/box/work
boxsh --sandbox \
  --bind cow:"$PWD:/tmp/box/work"
# ... exit shell ...
rm -rf /tmp/box
```

but reduced to a single flag.

**Use cases:** installing packages to evaluate them, running untrusted scripts, experimenting with config changes, anything where you want a "what if" shell without consequences. The temporary directory left behind acts as a diff — you can review or replay the changes selectively.

### RPC Mode

RPC mode turns boxsh into an MCP-compatible server. It reads JSON-RPC 2.0 requests from stdin and writes responses to stdout. Any MCP client (VS Code, Claude Desktop, Cursor, etc.) can connect directly.

```sh
boxsh --rpc [--workers N] [sandbox flags...]
```

- `--workers N` — number of parallel workers (default: 4)
- Responses arrive in **completion order**, not submission order

boxsh supports two transports, auto-detected from the first bytes:

| Transport | Format | Used by |
|---|---|---|
| **Content-Length framed** | `Content-Length: N\r\n\r\nJSON` | VS Code, most MCP clients |
| **Newline-delimited** | One JSON object per line | CLI testing, piped input |

#### MCP Methods

| Method | Description |
|---|---|
| `initialize` | Returns server capabilities and protocol version |
| `notifications/initialized` | Acknowledged silently (no response) |
| `tools/list` | Returns all nine tools with `inputSchema` and `annotations` |
| `tools/call` | Dispatches to a named tool: `bash`, `read`, `write`, `edit`, `run_in_terminal`, `send_to_terminal`, `get_terminal_output`, `kill_terminal`, `list_terminals` |

#### Shell Commands

Execute shell commands via the `bash` tool:

```sh
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"echo hello"}}}' | boxsh --rpc
```

**Response** (MCP `CallToolResult` format):

```json
{"jsonrpc":"2.0","id":"1","result":{
  "content":[{"type":"text","text":"hello\n"}],
  "structuredContent":{"exit_code":0,"stdout":"hello\n","stderr":"","duration_ms":3}
}}
```

- `content` — text representation for the LLM
- `structuredContent` — typed fields: `exit_code`, `stdout`, `stderr`, `duration_ms`
- `isError: true` — set when `exit_code != 0` or the command fails

Full shell syntax is supported — pipes, redirections, variables, subshells, etc.:

```sh
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"echo hello | tr a-z A-Z"}}}' | boxsh --rpc
# → content: "HELLO\n", structuredContent: {exit_code: 0, stdout: "HELLO\n", ...}

echo '{"jsonrpc":"2.0","id":"2","method":"tools/call","params":{"name":"bash","arguments":{"command":"x=42; echo $((x * 2))"}}}' | boxsh --rpc
# → content: "84\n", structuredContent: {exit_code: 0, stdout: "84\n", ...}
```

#### Built-in File Tools

Three file-operation tools are available via `tools/call`. They run on background threads and do not occupy a worker slot.

**`read`** — Read a file. Text files support `offset`/`limit` for slicing. Binary files are automatically detected and returned as base64 with MIME type.

```sh
# Read entire file
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"read","arguments":{"path":"/etc/hostname"}}}' | boxsh --rpc

# Read lines 10–19
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"read","arguments":{"path":"src/main.cpp","offset":10,"limit":10}}}' | boxsh --rpc
```

| Argument | Type | Default | Description |
|---|---|---|---|
| `offset` | number | 1 | 1-based start line (text only) |
| `limit` | number | unlimited | Maximum lines to return (text only) |

`structuredContent` includes: `content`, `encoding` (`"text"` or `"base64"`), `mime_type`, and `truncated`/`line_count` (text) or `size` (binary).

**`write`** — Create or overwrite a file. Parent directories are created automatically.

```sh
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"write","arguments":{"path":"/tmp/hello.txt","content":"hello\n"}}}' | boxsh --rpc
# → content: "written 6 bytes"
```

**`edit`** — Apply one or more search-and-replace operations on a file.

```sh
echo '{
  "jsonrpc":"2.0","id":"1","method":"tools/call",
  "params":{"name":"edit","arguments":{"path":"config.ini","edits":[
    {"oldText":"debug = false","newText":"debug = true"},
    {"oldText":"port = 3000","newText":"port = 8080"}
  ]}}
}' | boxsh --rpc
```

Rules:

- Each `oldText` must appear **exactly once** in the original file
- All matches are found against the **original** content, not intermediate results
- Edits must not overlap
- `oldText` must not be empty

`structuredContent` includes `diff` (unified diff) and `firstChangedLine` (1-indexed line number of the first changed line).

#### Error Model

boxsh distinguishes two kinds of errors per the MCP spec:

| Error type | Serialization | Example |
|---|---|---|
| **Protocol error** | JSON-RPC `{"error": {"code": N, "message": "..."}}` | Invalid JSON, unknown method, unknown tool |
| **Tool execution error** | `{"result": {"content": [...], "isError": true}}` | Non-zero exit code, file not found |

#### Concurrency

Multiple requests sent at once are dispatched to different workers and execute in parallel:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":"slow","method":"tools/call","params":{"name":"bash","arguments":{"command":"sleep 0.5; echo slow"}}}' \
  '{"jsonrpc":"2.0","id":"fast","method":"tools/call","params":{"name":"bash","arguments":{"command":"echo fast"}}}' \
| boxsh --rpc --workers 2
```

Output (fast completes first):

```
{"jsonrpc":"2.0","id":"fast","result":{"content":[...],"structuredContent":{"exit_code":0,"stdout":"fast\n",...}}}
{"jsonrpc":"2.0","id":"slow","result":{"content":[...],"structuredContent":{"exit_code":0,"stdout":"slow\n",...}}}
```

Tool requests and shell commands can be interleaved — tools do not occupy a worker.

#### Terminal Tools

Five terminal tools manage persistent PTY sessions. They run on background threads and do not occupy a worker slot.

**`run_in_terminal`** — Start a PTY session.

```sh
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"run_in_terminal","arguments":{"command":"bash"}}}' | boxsh --rpc
# → structuredContent: { id: "<session-id>", output: "...", exited: false, exit_code: null }
```

**`send_to_terminal`** — Write to stdin and get updated screen output.

```sh
echo '{"jsonrpc":"2.0","id":"2","method":"tools/call","params":{"name":"send_to_terminal","arguments":{"id":"<id>","command":"ls -la\n"}}}' | boxsh --rpc
```

**`get_terminal_output`** — Poll for new output (up to 500 ms).

```sh
echo '{"jsonrpc":"2.0","id":"3","method":"tools/call","params":{"name":"get_terminal_output","arguments":{"id":"<id>"}}}' | boxsh --rpc
```

**`kill_terminal`** — Terminate session and free resources.

**`list_terminals`** — List all active sessions.

#### Timeout

Set a per-request timeout via the `timeout` argument. When the timeout fires, the command is killed and the worker is respawned automatically.

```sh
echo '{"jsonrpc":"2.0","id":"t","method":"tools/call","params":{"name":"bash","arguments":{"command":"sleep 60","timeout":2}}}' | boxsh --rpc
# Response after ~2 seconds:
# {"jsonrpc":"2.0","id":"t","result":{"content":[{"type":"text","text":"timeout"}],"structuredContent":{"exit_code":-1,"stdout":"","stderr":"timeout","duration_ms":2001},"isError":true}}
```

Subsequent requests continue to work normally — the crashed worker is replaced transparently.

#### Client Configuration

`--sandbox` enforces minimal privileges — you must explicitly `--bind` any project directories.

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

**Example handshake:**

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":"2","method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":"3","method":"tools/call","params":{"name":"bash","arguments":{"command":"echo hello"}}}' \
| boxsh --rpc --workers 1
```

### Sandbox Flags

Pass `--sandbox` to enable sandbox isolation. Inside the sandbox, you appear as root.

```sh
# Basic sandbox
boxsh --sandbox -c 'whoami'
# root

# Isolate network (loopback only, no outbound access)
boxsh --sandbox --new-net-ns -c 'curl http://example.com'
# curl: (6) Could not resolve host: example.com
```

In RPC mode, each worker runs inside the sandbox — all commands share the same isolated environment:

```sh
boxsh --rpc --workers 4 --sandbox --new-net-ns
```

| Flag | Effect |
|---|---|
| `--sandbox` | Enable sandbox isolation |
| `--new-net-ns` | Loopback-only network |

#### COW Bind (`--bind cow:`)

COW bind is the primary usage pattern for boxsh. It mounts a read-only source directory as a copy-on-write workspace. Commands can read and write freely; all modifications land in the destination directory while the source remains untouched.

```
--bind cow:SRC:DST
```

| Parameter | Description |
|---|---|
| `SRC` | Read-only base directory (e.g. your project root) |
| `DST` | Writable destination directory (all modifications accumulate here) |

Both directories must exist before starting boxsh.

**Example — run `npm install` without touching the real project:**

```sh
# Prepare directories
project=/home/user/myproject
dst=/tmp/sandbox/dst
mkdir -p "$dst"

# Run inside COW overlay
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"cd /tmp/sandbox/dst && npm install"}}}' \
| boxsh --rpc --sandbox --bind cow:"$project:$dst"

# Base is untouched; all changes are in $dst
ls "$dst"
# node_modules/  package-lock.json
```

The destination directory **persists** across commands within the same boxsh session, and even across sessions if you reuse the same directories. To discard all changes, simply `rm -rf "$dst"`.

**Platform-specific requirements for COW:**

- **Linux:** `CONFIG_OVERLAY_FS=y/m`; inside user namespaces (the default): `CONFIG_OVERLAY_FS_METACOPY=y` (kernel ≥ 5.11)
- **macOS:** APFS filesystem (default on macOS ≥ 10.13)

#### Bind Mounts

Expose specific host paths inside the sandbox:

```sh
# Read-write bind
boxsh --sandbox --bind wr:/data -c 'ls /data'

# Read-only bind
boxsh --sandbox --bind ro:/etc/resolv.conf -c 'cat /etc/resolv.conf'
```

Formats:
- `--bind ro:PATH` — read-only
- `--bind wr:PATH` — read-write


### Node.js SDK

The `boxsh.js` SDK provides a high-level client for Node.js applications.

```sh
npm install boxsh.js
```

#### Quick start

```js
import { BoxshClient } from 'boxsh.js';

const client = new BoxshClient();
const { exitCode, stdout } = await client.exec('echo hello');
console.log(stdout);  // "hello\n"
await client.close();
```

#### Overlay workflow

```js
import { BoxshClient, getChanges, formatChanges } from 'boxsh.js';
import fs from 'node:fs';

const dst = '/tmp/sandbox/dst';
fs.mkdirSync(dst, { recursive: true });

const client = new BoxshClient({
    sandbox: true,
    binds: [{ mode: 'cow', src: '/home/user/myproject', dst }],
});

// Run commands inside the sandbox
await client.exec('npm install', dst);

# Read/write files via built-in tools (no shell round-trip)
const { content } = await client.read(`${dst}/package.json`);
await client.write(`${dst}/notes.txt`, 'done\n');

// Edit files with search-and-replace
const { diff } = await client.edit(`${dst}/config.js`, [
    { oldText: 'DEBUG = false', newText: 'DEBUG = true' },
]);
console.log(diff);

await client.close();

// Inspect what changed
const changes = getChanges({ upper: dst, base: '/home/user/myproject' });
console.log(formatChanges(changes));
// M  package-lock.json
// A  node_modules/
// A  notes.txt
```

#### Concurrent execution

Run multiple commands in parallel with multiple workers:

```js
import { BoxshClient } from 'boxsh.js';

const client = new BoxshClient({ workers: 4 });

const [a, b, c] = await Promise.all([
    client.exec('make build',  '/workspace'),
    client.exec('make lint',   '/workspace'),
    client.exec('make test',   '/workspace'),
]);

await client.close();
```

#### Constructor options

| Option | Type | Default | Description |
|---|---|---|---|
| `boxshPath` | `string` | `$BOXSH` → `'boxsh'` | Path to boxsh binary |
| `workers` | `number` | `1` | Parallel worker count |
| `sandbox` | `boolean` | `false` | Enable namespace isolation |
| `newNetNs` | `boolean` | `false` | Isolate network |
| `binds` | `BoxshBindOption[]` | — | Bind mount configuration (ro/wr/cow) |

#### Methods

| Method | Returns | Description |
|---|---|---|
| `exec(cmd, cwd?, timeout?)` | `{ exitCode, stdout, stderr }` | Run a shell command |
| `read(path, offset?, limit?)` | `ReadResult` | Read file content (text or binary) |
| `write(path, content)` | `void` | Create or overwrite a file |
| `edit(path, edits)` | `{ diff, firstChangedLine }` | Search-and-replace edit |
| `runInTerminal(cmd, opts?)` | `{ id, output, exited, exitCode }` | Start a PTY session |
| `sendToTerminal(id, cmd)` | `{ output, exited, exitCode }` | Send to PTY and get screen |
| `getTerminalOutput(id)` | `{ output, exited, exitCode }` | Poll PTY output |
| `killTerminal(id)` | `string` | Kill session, return final screen |
| `listTerminals()` | `TerminalSession[]` | List active sessions |
| `close()` | `void` | Graceful shutdown |
| `terminate()` | `void` | Kill immediately |

#### Utility functions

| Function | Description |
|---|---|
| `shellQuote(s)` | POSIX single-quote escaping for safe command interpolation |
| `getChanges({ upper, base })` | Scan COW destination dir for added/modified/deleted files |
| `formatChanges(changes)` | Format change list as `A/M/D\tpath` text |
