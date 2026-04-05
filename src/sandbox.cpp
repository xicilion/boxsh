#include "sandbox.h"

#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>

#include <fcntl.h>
#include <unistd.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>

namespace boxsh {

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

static std::string errno_str(const char *context) {
    return std::string(context) + ": " + std::strerror(errno);
}

// Write a single string to a file, used for uid_map / gid_map / setgroups.
static bool write_file(const char *path, const char *content) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) return false;
    ssize_t n = write(fd, content, std::strlen(content));
    close(fd);
    return n == (ssize_t)std::strlen(content);
}

// pivot_root(2) is not wrapped by glibc, call it directly.
static int do_pivot_root(const char *new_root, const char *put_old) {
    return syscall(SYS_pivot_root, new_root, put_old);
}

// Mount an overlayfs at 'dest' using caller-managed upper/work directories.
static bool mount_overlay_at(const std::string &lowerdir,
                               const std::string &dest,
                               const std::string &upper,
                               const std::string &work,
                               std::string &err) {
    if (mkdir(dest.c_str(), 0755) != 0 && errno != EEXIST) {
        err = errno_str(("mkdir overlay dest: " + dest).c_str());
        return false;
    }
    std::string opts = "lowerdir=" + lowerdir +
                       ",upperdir=" + upper +
                       ",workdir="  + work;
    if (mount("overlay", dest.c_str(), "overlay", 0, opts.c_str()) != 0) {
        err = errno_str(("mount overlay -> " + dest).c_str());
        return false;
    }
    return true;
}

// Apply overlay mounts.  upper/work directories are provided by the caller
// and must already exist on the host filesystem.
//
// 'dest_prefix' is prepended to container_path — use the new rootfs path
// when pivot_root is in use, or empty otherwise.
//
// Kernel requirements:
//   - CLONE_NEWNS must already be active (mount namespace isolation).
//   - To work inside a CLONE_NEWUSER namespace, the kernel must have
//     CONFIG_OVERLAY_FS_METACOPY=y (Linux >= 5.11).  Without it the call
//     fails with EPERM/EINVAL.
//   - When running as real root (--no-user-ns), standard kernel overlayfs
//     (CONFIG_OVERLAY_FS=y/m) is sufficient.
static bool apply_overlay_mounts(const std::vector<OverlayMount> &overlays,
                                  const std::string &dest_prefix,
                                  std::string &err) {
    for (const auto &ov : overlays) {
        std::string dest = dest_prefix + ov.container_path;
        if (!mount_overlay_at(ov.lowerdir, dest, ov.upperdir, ov.workdir, err))
            return false;
    }
    return true;
}

// Mount a proc filesystem at 'path', creating the directory if needed.
static bool mount_proc(const std::string &path, std::string &err) {
    if (mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) {
        err = errno_str(("mkdir proc target: " + path).c_str());
        return false;
    }
    if (mount("proc", path.c_str(), "proc", 0, nullptr) != 0) {
        err = errno_str(("mount proc -> " + path).c_str());
        return false;
    }
    return true;
}

// Mount a tmpfs at 'path', creating the directory if needed.
// 'options' may be empty or a comma-separated mount options string (e.g. "size=128m").
static bool mount_tmpfs_at(const std::string &path,
                             const std::string &options,
                             std::string &err) {
    if (mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) {
        err = errno_str(("mkdir tmpfs target: " + path).c_str());
        return false;
    }
    const char *opts = options.empty() ? "mode=0755" : options.c_str();
    if (mount("tmpfs", path.c_str(), "tmpfs", 0, opts) != 0) {
        err = errno_str(("mount tmpfs -> " + path).c_str());
        return false;
    }
    return true;
}

// Mount a tmpfs at 'path' for the new rootfs base (always uses default options).
static bool mount_tmpfs(const std::string &path, std::string &err) {
    return mount_tmpfs_at(path, "mode=0755", err);
}

// Recursively bind-mount 'src' to 'dst', creating 'dst' if needed.
static bool bind_mount(const std::string &src, const std::string &dst,
                       bool readonly, std::string &err) {
    // Detect whether src is a file or directory to create the right type.
    struct stat st;
    if (stat(src.c_str(), &st) != 0) {
        err = errno_str(("stat bind-mount src: " + src).c_str());
        return false;
    }

    if (S_ISDIR(st.st_mode)) {
        if (mkdir(dst.c_str(), 0755) != 0 && errno != EEXIST) {
            err = errno_str(("mkdir bind-mount dst: " + dst).c_str());
            return false;
        }
    } else {
        // For regular files create an empty file as mount point.
        int fd = open(dst.c_str(), O_CREAT | O_WRONLY | O_CLOEXEC, 0644);
        if (fd < 0 && errno != EEXIST) {
            err = errno_str(("create bind-mount file dst: " + dst).c_str());
            return false;
        }
        if (fd >= 0) close(fd);
    }

    unsigned long flags = MS_BIND | MS_REC;
    if (mount(src.c_str(), dst.c_str(), nullptr, flags, nullptr) != 0) {
        err = errno_str(("bind mount: " + src + " -> " + dst).c_str());
        return false;
    }

    if (readonly) {
        // A second remount is required to actually apply MS_RDONLY on a bind mount.
        flags |= MS_REMOUNT | MS_RDONLY;
        if (mount(src.c_str(), dst.c_str(), nullptr, flags, nullptr) != 0) {
            err = errno_str(("bind mount remount rdonly: " + dst).c_str());
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

SandboxResult sandbox_apply(const SandboxConfig &cfg) {
    SandboxResult res;

    if (!cfg.enabled) {
        res.ok = true;
        return res;
    }

    // --- 1. Build unshare flags ---
    int unshare_flags = 0;
    if (cfg.new_user_ns)  unshare_flags |= CLONE_NEWUSER;
    if (cfg.new_mount_ns) unshare_flags |= CLONE_NEWNS;
    if (cfg.new_pid_ns)   unshare_flags |= CLONE_NEWPID;
    if (cfg.new_net_ns)   unshare_flags |= CLONE_NEWNET;

    if (unshare_flags == 0 && cfg.new_rootfs.empty() && !cfg.readonly_root) {
        res.ok = true;
        return res;
    }

    // --- 2. Unshare namespaces ---
    if (unshare_flags != 0) {
        if (unshare(unshare_flags) != 0) {
            res.error = errno_str("unshare");
            return res;
        }
    }

    // --- 3. Write uid/gid mapping (only when entering user ns from child side) ---
    // When called in the child after fork(), the parent must have written the
    // uid_map already.  When called via unshare() (no separate fork), we write
    // the map ourselves because we ARE both parent and child in that case.
    if (cfg.new_user_ns) {
        // Deny setgroups before writing gid_map (kernel requirement).
        char self_setgroups[] = "/proc/self/setgroups";
        write_file(self_setgroups, "deny");

        char uid_map_content[64];
        char gid_map_content[64];
        std::snprintf(uid_map_content, sizeof(uid_map_content),
                      "0 %u 1\n", cfg.host_uid);
        std::snprintf(gid_map_content, sizeof(gid_map_content),
                      "0 %u 1\n", cfg.host_gid);

        if (!write_file("/proc/self/uid_map", uid_map_content)) {
            res.error = errno_str("write uid_map");
            return res;
        }
        if (!write_file("/proc/self/gid_map", gid_map_content)) {
            res.error = errno_str("write gid_map");
            return res;
        }
    }

    // --- 4. Set up new rootfs (pivot_root) ---
    if (!cfg.new_rootfs.empty()) {
        const std::string &new_root = cfg.new_rootfs;
        // The directory must already be a mount point for pivot_root.
        // Mount a tmpfs there first.
        if (!mount_tmpfs(new_root, res.error)) return res;

        // Apply bind mounts.
        for (const auto &bm : cfg.bind_mounts) {
            std::string dst = new_root + bm.container_path;
            if (!bind_mount(bm.host_path, dst, bm.readonly, res.error))
                return res;
        }

        // Apply overlay mounts (before pivot_root so paths are relative to new_root).
        if (!apply_overlay_mounts(cfg.overlay_mounts, new_root, res.error))
            return res;

        // Apply proc mounts inside new_root.
        for (const auto &pm : cfg.proc_mounts) {
            if (!mount_proc(new_root + pm.container_path, res.error))
                return res;
        }

        // Apply tmpfs mounts inside new_root.
        for (const auto &tm : cfg.tmpfs_mounts) {
            if (!mount_tmpfs_at(new_root + tm.container_path, tm.options, res.error))
                return res;
        }

        // Create the put_old directory inside new_root.
        std::string put_old = new_root + "/.old_root";
        if (mkdir(put_old.c_str(), 0700) != 0) {
            res.error = errno_str("mkdir put_old");
            return res;
        }

        // pivot_root requires new_root to be a mount point.
        // Bind-mount it onto itself to guarantee this.
        if (mount(new_root.c_str(), new_root.c_str(), nullptr,
                  MS_BIND, nullptr) != 0) {
            res.error = errno_str("bind-mount new_root onto itself");
            return res;
        }

        if (do_pivot_root(new_root.c_str(), put_old.c_str()) != 0) {
            res.error = errno_str("pivot_root");
            return res;
        }

        // Now inside the new root. Unmount old root.
        if (umount2("/.old_root", MNT_DETACH) != 0) {
            res.error = errno_str("umount2 old_root");
            return res;
        }
        if (rmdir("/.old_root") != 0) {
            // Non-fatal: just warn via stderr, don't abort.
            std::fprintf(stderr, "boxsh: sandbox: rmdir /.old_root: %s\n",
                         std::strerror(errno));
        }
    } else if (!cfg.bind_mounts.empty() || !cfg.overlay_mounts.empty() ||
               !cfg.proc_mounts.empty() || !cfg.tmpfs_mounts.empty()) {
        // No new root: apply all mounts in-place into the new mount namespace
        // (CLONE_NEWNS must already be active).
        for (const auto &bm : cfg.bind_mounts) {
            if (!bind_mount(bm.host_path, bm.container_path,
                            bm.readonly, res.error))
                return res;
        }
        if (!apply_overlay_mounts(cfg.overlay_mounts, "", res.error))
            return res;
        for (const auto &pm : cfg.proc_mounts) {
            if (!mount_proc(pm.container_path, res.error))
                return res;
        }
        for (const auto &tm : cfg.tmpfs_mounts) {
            if (!mount_tmpfs_at(tm.container_path, tm.options, res.error))
                return res;
        }
    }

    // --- 5. Optional: make root read-only ---
    if (cfg.readonly_root) {
        if (mount(nullptr, "/", nullptr,
                  MS_REMOUNT | MS_RDONLY | MS_BIND, nullptr) != 0) {
            res.error = errno_str("remount / rdonly");
            return res;
        }
    }

    res.ok = true;
    return res;
}

bool sandbox_write_uid_map(pid_t child_pid, uint32_t host_uid,
                           uint32_t host_gid) {
    char path[128];
    char content[64];

    // Deny setgroups first.
    std::snprintf(path, sizeof(path), "/proc/%d/setgroups", (int)child_pid);
    write_file(path, "deny"); // best-effort, ignore failure

    std::snprintf(path, sizeof(path), "/proc/%d/uid_map", (int)child_pid);
    std::snprintf(content, sizeof(content), "0 %u 1\n", host_uid);
    if (!write_file(path, content)) return false;

    std::snprintf(path, sizeof(path), "/proc/%d/gid_map", (int)child_pid);
    std::snprintf(content, sizeof(content), "0 %u 1\n", host_gid);
    return write_file(path, content);
}

} // namespace boxsh
