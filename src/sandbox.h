#pragma once

#include <string>
#include <vector>

namespace boxsh {

// A single bind entry.  Three modes are supported:
//   RO  — read-only:  host path exposed inside sandbox, writes denied.
//   RW  — read-write: host path exposed inside sandbox, writes allowed.
//   COW — copy-on-write: src is the read-only base; dst captures writes.
//         The COW workspace semantics are consistent across platforms even
//         though the host-side implementation differs (overlayfs on Linux,
//         clone snapshots + manifest tracking on macOS).
//         sandbox_apply() auto-creates any transient directories needed.
struct BindMount {
    enum class Mode { RO, RW, COW };
    Mode        mode;
    std::string src;  // ro/rw: access path; cow: source directory (read-only base)
    std::string dst;  // ro/rw: same as src;  cow: destination (captures writes)
};

// Configuration for a sandbox scope (global or per-request).
struct SandboxConfig {
    bool enabled = false;

    bool new_net_ns = false; // isolate network (loopback only)

    // Bind mounts to apply inside the sandbox (in addition to the automatic
    // read-only system mounts that sandbox_apply() always sets up).
    std::vector<BindMount> bind_mounts;
};

// Result returned from sandbox_apply().
struct SandboxResult {
    bool ok = false;
    std::string error;
};

// Apply a sandbox configuration inside the *current* process.
// This is meant to be called in a child process after fork(), before exec().
// For global sandbox: called once in the coordinator child before it becomes
// the worker pool.
// For request-level sandbox: called in the worker child after it forks to
// handle a request.
SandboxResult sandbox_apply(const SandboxConfig &cfg);

// Process-wide marker set by main() once sandbox_apply() has succeeded (the
// restrictions are inherited by forked workers and shared by tool threads).
// File tools use it when reporting EACCES/EPERM so that a caller can tell a
// sandbox denial apart from a plain file-permission denial (reported as
// `detail.sandbox` on the error result).
inline bool &sandbox_active_ref() {
    static bool active = false;
    return active;
}
inline bool sandbox_active() { return sandbox_active_ref(); }

} // namespace boxsh
