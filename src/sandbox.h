#pragma once

#include <sys/types.h>
#include <stdint.h>
#include <string>
#include <vector>

namespace boxsh {

// A single bind-mount entry: host_path -> container_path, optionally read-only.
struct BindMount {
    std::string host_path;
    std::string container_path;
    bool readonly = false;
};

// An overlay mount: overlayfs with caller-managed upper and work directories.
// The sandbox sees a merged view of lowerdir (read-only base) and upperdir
// (writable layer).  Writes go to upperdir and persist between commands;
// the caller is responsible for creating upper/work directories before launch.
struct OverlayMount {
    std::string lowerdir;       // host path: read-only base layer
    std::string upperdir;       // host path: writable upper layer (persistent)
    std::string workdir;        // host path: overlayfs work directory
    std::string container_path; // mount point inside the sandbox
};

// A procfs mount: mount proc at container_path inside the sandbox.
struct ProcMount {
    std::string container_path;
};

// A tmpfs mount: mount an empty tmpfs at container_path inside the sandbox.
struct TmpfsMount {
    std::string container_path;
    std::string options; // e.g. "size=128m" — empty = kernel default
};

// Configuration for a sandbox scope (global or per-request).
struct SandboxConfig {
    bool enabled = false;

    // User/group mapping for the new user namespace.
    // Maps container uid/gid 0 -> host uid/gid.
    uint32_t host_uid = 0;
    uint32_t host_gid = 0;

    // Namespace flags to unshare.
    bool new_user_ns  = true;  // CLONE_NEWUSER
    bool new_mount_ns = true;  // CLONE_NEWNS
    bool new_pid_ns   = false; // CLONE_NEWPID (requires extra fork)
    bool new_net_ns   = false; // CLONE_NEWNET

    // New root filesystem (empty = keep current root).
    // If set, boxsh will mount a tmpfs here, apply bind mounts,
    // then pivot_root into it.
    std::string new_rootfs;

    // Bind mounts to apply inside the sandbox.
    std::vector<BindMount> bind_mounts;

    // If true, remount / as read-only after pivot_root.
    bool readonly_root = false;

    // Overlay mounts: each entry is mounted as overlayfs.  upper/work dirs
    // are managed by the caller and must exist before sandbox_apply().
    // Requires CLONE_NEWNS.
    std::vector<OverlayMount> overlay_mounts;

    // Extra filesystem mounts inside the sandbox.
    std::vector<ProcMount>  proc_mounts;   // --proc DST
    std::vector<TmpfsMount> tmpfs_mounts;  // --tmpfs DST[:opts]
};

// Result returned from sandbox_enter_*() helpers.
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
//
// NOTE: new_pid_ns requires an additional fork after unshare() to actually
// enter the new PID namespace — callers are responsible for that.
SandboxResult sandbox_apply(const SandboxConfig &cfg);

// Write uid_map / gid_map for a child process that was cloned with
// CLONE_NEWUSER. Must be called from the *parent* process right after fork/clone.
// Returns false on error and sets errno.
bool sandbox_write_uid_map(pid_t child_pid, uint32_t host_uid, uint32_t host_gid);

} // namespace boxsh
