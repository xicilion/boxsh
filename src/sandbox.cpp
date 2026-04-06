#include "sandbox.h"

#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>

#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>

#ifndef XFS_SUPER_MAGIC
#define XFS_SUPER_MAGIC 0x58465342
#endif

namespace boxsh {

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

static std::string errno_str(const char *context) {
    return std::string(context) + ": " + std::strerror(errno);
}

// Recursively create directory and all parents (like mkdir -p).
static bool mkdir_p(const std::string &path, mode_t mode, std::string &err) {
    for (size_t pos = 1; pos <= path.size(); ++pos) {
        if (pos == path.size() || path[pos] == '/') {
            std::string prefix = path.substr(0, pos);
            if (mkdir(prefix.c_str(), mode) != 0 && errno != EEXIST) {
                err = errno_str(("mkdir_p: " + prefix).c_str());
                return false;
            }
        }
    }
    return true;
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

// Returns true when the lower-layer filesystem requires directory pre-mirroring
// to prevent EOVERFLOW during overlayfs directory copy-up in user namespaces.
// XFS encodes file handles using inode numbers that may exceed the range
// overlayfs can represent internally, causing copy-up to fail.  Pre-populating
// upper with an empty directory skeleton avoids the copy-up entirely.
static bool lower_needs_mirror_dirs(const std::string &lowerdir) {
    // lowerdir may be a colon-separated list for multi-layer overlayfs.
    // Copy-up originates from the topmost (first listed) lower layer.
    std::string top = lowerdir;
    size_t colon = lowerdir.find(':');
    if (colon != std::string::npos)
        top = lowerdir.substr(0, colon);

    struct statfs sfs;
    if (statfs(top.c_str(), &sfs) != 0)
        return true; // fail-safe: mirror anyway
    return sfs.f_type == XFS_SUPER_MAGIC;
}

// Recursively mirror the directory skeleton of 'src' into 'dst' (dirs only).
static void mirror_dirs(const std::string &src, const std::string &dst) {
    DIR *dir = opendir(src.c_str());
    if (!dir) return;
    struct dirent *ent;
    while ((ent = readdir(dir)) != nullptr) {
        if (ent->d_name[0] == '.' &&
            (ent->d_name[1] == '\0' ||
             (ent->d_name[1] == '.' && ent->d_name[2] == '\0')))
            continue;
        std::string src_child = src + "/" + ent->d_name;
        std::string dst_child = dst + "/" + ent->d_name;
        struct stat st;
        if (lstat(src_child.c_str(), &st) != 0) continue;
        if (!S_ISDIR(st.st_mode)) continue;
        // Ignore errors: the directory may already exist.
        mkdir(dst_child.c_str(), 0755);
        mirror_dirs(src_child, dst_child);
    }
    closedir(dir);
}

static bool mount_overlay_at(const std::string &lowerdir,
                               const std::string &dest,
                               const std::string &upper,
                               const std::string &work,
                               std::string &err) {
    if (!mkdir_p(dest, 0755, err)) return false;
    // Pre-populate upper with the directory skeleton of lower only when the
    // lower filesystem (XFS) cannot complete directory copy-up in a user
    // namespace.  On other filesystems (tmpfs, ext4, …) copy-up works fine
    // and we skip the potentially expensive pre-mirror step.
    //
    // For multi-layer lowerdirs (colon-separated) we mirror the topmost layer:
    // that is the layer overlayfs uses as the source for directory copy-up.
    if (lower_needs_mirror_dirs(lowerdir)) {
        std::string top_lower = lowerdir;
        size_t colon = lowerdir.find(':');
        if (colon != std::string::npos)
            top_lower = lowerdir.substr(0, colon);
        mirror_dirs(top_lower, upper);
    }
    // xino=off: disable cross-inode-number encoding between lower and upper
    // layers.  Without this, overlayfs copy-up fails with EOVERFLOW when the
    // lower filesystem (e.g. ext4) has inode numbers that exceed the range
    // the upper filesystem (e.g. tmpfs) can represent.
    std::string opts = "lowerdir=" + lowerdir +
                       ",upperdir=" + upper +
                       ",workdir="  + work +
                       ",xino=off";
    if (mount("overlay", dest.c_str(), "overlay", 0, opts.c_str()) != 0) {
        err = errno_str(("mount overlay -> " + dest).c_str());
        return false;
    }
    return true;
}

// Apply overlay mounts inside new_root.  dest_prefix is the new root path.
//
// Kernel requirements:
//   - CLONE_NEWNS must already be active (mount namespace isolation).
//   - To work inside a CLONE_NEWUSER namespace, the kernel must have
//     CONFIG_OVERLAY_FS_METACOPY=y (Linux >= 5.11).  Without it the call
//     fails with EPERM/EINVAL.
//   - When running as real root (--no-user-ns), standard kernel overlayfs
//     (CONFIG_OVERLAY_FS=y/m) is sufficient.
// Return the parent directory of an absolute path (empty string for root).
static std::string path_parent(const std::string &p) {
    size_t pos = p.rfind('/');
    if (pos == std::string::npos || pos == 0) return "/";
    return p.substr(0, pos);
}

static bool apply_overlay_mounts(const std::vector<OverlayMount> &overlays,
                                  const std::string &dest_prefix,
                                  std::string &err) {
    for (const auto &ov : overlays) {
        std::string dest = dest_prefix + ov.container_path;

        // Hide overlay internals (lower/upper/work) from inside the sandbox.
        // If upper and work share a common parent directory that happens to be
        // accessible in the sandbox (e.g. via the CWD auto-bind), mount a fresh
        // empty tmpfs on that parent BEFORE mounting the overlay.  This makes
        // lower/upper/work truly non-existent (ENOENT) inside the sandbox rather
        // than merely empty directories, which is the correct security boundary.
        // We do this *before* mount_overlay_at so the overlay mount point (dst)
        // can be created inside the fresh tmpfs when it falls under that parent.
        //
        // Note: the kernel's overlayfs module holds its own internal references
        // to lowerdir/upperdir/workdir obtained at mount time via the host-path
        // options string; shadowing those paths in userspace does not affect the
        // overlay's operation.
        {
            std::string p_upper = path_parent(ov.upperdir);
            std::string p_work  = path_parent(ov.workdir);
            // Only apply when upper and work share a common, non-root parent that
            // is distinct from the container_path itself.
            if (p_upper == p_work && p_upper != "/" &&
                p_upper != ov.container_path) {
                std::string base_in_root = dest_prefix + p_upper;
                struct stat st;
                if (stat(base_in_root.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
                    if (mount("tmpfs", base_in_root.c_str(), "tmpfs",
                              MS_NOSUID | MS_NODEV, "mode=0755") == 0) {
                        // If dst is a child of this base, create its directory
                        // inside the fresh tmpfs so mount_overlay_at has a target.
                        if (ov.container_path.size() > p_upper.size() + 1 &&
                            ov.container_path.compare(0, p_upper.size() + 1,
                                                      p_upper + "/") == 0) {
                            std::string dst_err;
                            mkdir_p(dest, 0755, dst_err);
                        }
                    }
                }
            }
        }

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
        if (!mkdir_p(dst, 0755, err)) return false;
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

// Conditionally bind a host path into new_root if the source exists.
// System directories don't need MS_RDONLY: write access is controlled by
// host Unix permissions (the sandbox maps to real uid, not kernel root).
static bool try_bind(const std::string &src, const std::string &new_root,
                     std::string &err) {
    struct stat st;
    if (stat(src.c_str(), &st) != 0) return true; // not present, skip
    return bind_mount(src, new_root + src, /*readonly=*/false, err);
}


// Set up the automatic read-only system mounts that every sandbox gets.
// These provide a working environment without exposing writable host paths.
static bool setup_system_mounts(const std::string &new_root, std::string &err) {
    // /usr — all system binaries and libraries.
    if (!try_bind("/usr", new_root, err)) return false;

    // On merged-usr distros /bin /sbin /lib /lib64 are symlinks to usr/*.
    // On non-merged distros they are real directories that need binding.
    static const char *const usr_compat[] = {
        "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", nullptr
    };
    for (int i = 0; usr_compat[i]; i++) {
        struct stat lst;
        if (lstat(usr_compat[i], &lst) != 0) continue;
        if (S_ISLNK(lst.st_mode)) {
            // Read the symlink target and recreate it inside new_root.
            char target[256] = {};
            if (readlink(usr_compat[i], target, sizeof(target) - 1) > 0) {
                std::string dst = new_root + usr_compat[i];
                struct stat dst_st;
                if (stat(dst.c_str(), &dst_st) != 0)
                    symlink(target, dst.c_str()); // best-effort
            }
        } else {
            // Real directory — bind mount.
            if (!try_bind(usr_compat[i], new_root, err)) return false;
        }
    }

    // /proc — bind-mount from host; works in user namespace without new PID ns.
    // A fresh proc mount requires CAP_SYS_ADMIN beyond user-ns scope on some
    // kernels; a bind-mount is always allowed with CLONE_NEWNS.
    if (mkdir((new_root + "/proc").c_str(), 0755) != 0 && errno != EEXIST) {
        err = errno_str("mkdir /proc");
        return false;
    }
    if (mount("/proc", (new_root + "/proc").c_str(), nullptr,
              MS_BIND | MS_REC, nullptr) != 0) {
        err = errno_str("bind /proc");
        return false;
    }

    // /dev — bind entire host /dev recursively so all sub-mounts (devpts, shm,
    // hugepages, mqueue) are included. Device access is still governed by the
    // real uid and kernel DAC; no additional filtering is needed.
    if (!try_bind("/dev", new_root, err)) return false;

    // /tmp — fresh writable tmpfs; never shared with host.
    if (!mount_tmpfs_at(new_root + "/tmp", "mode=1777", err)) return false;

    // /run — bind from host so symlink targets under /run (e.g. resolv.conf)
    // resolve correctly inside the sandbox.
    if (!try_bind("/run", new_root, err)) return false;

    // /etc — bind entire host /etc. All files are world-readable by design;
    // write access is controlled by host Unix permissions (real uid).
    if (!try_bind("/etc", new_root, err)) return false;

    // /var — bind from host so package databases (dpkg, rpm) and other
    // system state are accessible inside the sandbox.
    if (!try_bind("/var", new_root, err)) return false;

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

    // Save CWD before any namespace changes so we can restore it after
    // pivot_root moves the process into the new root.
    char *cwd_buf = getcwd(nullptr, 0);
    std::string saved_cwd = cwd_buf ? cwd_buf : "/";
    free(cwd_buf);

    // --- 1. Unshare namespaces ---
    int unshare_flags = CLONE_NEWNS; // always need a private mount namespace
    if (cfg.new_user_ns) unshare_flags |= CLONE_NEWUSER;
    if (cfg.new_pid_ns)  unshare_flags |= CLONE_NEWPID;
    if (cfg.new_net_ns)  unshare_flags |= CLONE_NEWNET;

    if (unshare(unshare_flags) != 0) {
        res.error = errno_str("unshare");
        return res;
    }

    // --- 2. Write uid/gid mapping ---
    // When called via unshare() (no separate fork) we write the map ourselves.
    if (cfg.new_user_ns) {
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

    // --- 3. Make all existing mounts private so our changes don't propagate ---
    if (mount(nullptr, "/", nullptr, MS_SLAVE | MS_REC, nullptr) != 0) {
        res.error = errno_str("mount --make-rslave /");
        return res;
    }

    // --- 4. Build new root on a tmpfs ---
    // We use /tmp as staging area (same approach as bubblewrap).
    // Mount a fresh tmpfs there; it becomes the new root base.
    const std::string new_root = "/tmp/.boxsh-newroot";
    if (mkdir(new_root.c_str(), 0755) != 0 && errno != EEXIST) {
        res.error = errno_str("mkdir newroot");
        return res;
    }
    if (mount("tmpfs", new_root.c_str(), "tmpfs",
              MS_NOSUID | MS_NODEV, "mode=0755") != 0) {
        res.error = errno_str("mount tmpfs newroot");
        return res;
    }

    // --- 5. Automatic read-only system mounts ---
    if (!setup_system_mounts(new_root, res.error)) return res;

    // --- 6. User-specified bind mounts ---
    for (const auto &bm : cfg.bind_mounts) {
        std::string dst = new_root + bm.container_path;
        if (!bind_mount(bm.host_path, dst, bm.readonly, res.error))
            return res;
    }

    // --- 7. User-specified extra tmpfs mounts ---
    for (const auto &tm : cfg.tmpfs_mounts) {
        if (!mount_tmpfs_at(new_root + tm.container_path, tm.options, res.error))
            return res;
    }

    // --- 8. User-specified proc mounts ---
    for (const auto &pm : cfg.proc_mounts) {
        if (!mount_proc(new_root + pm.container_path, res.error))
            return res;
    }

    // --- 8b. Auto-bind CWD into the new root (if not already covered) ---
    // Ensures CWD-relative writes reach the host filesystem.
    // Overlays in step 9 will shadow this bind if CWD falls under an overlay
    // mount point, so overlay-based CWD is still correctly captured.
    if (!saved_cwd.empty()) {
        auto is_under = [](const std::string &path,
                           const std::string &prefix) -> bool {
            return path == prefix ||
                   (path.size() > prefix.size() && path[prefix.size()] == '/' &&
                    path.compare(0, prefix.size(), prefix) == 0);
        };
        // System dirs already set up: no auto-bind needed for these.
        static const char *sys_prefixes[] = {
            "/usr", "/bin", "/sbin", "/lib", "/proc", "/dev",
        };
        bool cwd_covered = false;
        for (auto &p : sys_prefixes)
            if (is_under(saved_cwd, p)) { cwd_covered = true; break; }
        if (!cwd_covered) {
            for (const auto &bm : cfg.bind_mounts)
                if (is_under(saved_cwd, bm.container_path)) { cwd_covered = true; break; }
        }
        if (!cwd_covered) {
            // Best-effort: ignore failures (CWD may be a system path we handle
            // specially, e.g. /tmp is fresh tmpfs — in that case CWD falls back to /).
            std::string cwd_err;
            bind_mount(saved_cwd, new_root + saved_cwd, false, cwd_err);
        }
    }

    // --- 9. Overlay mounts (applied inside new_root before pivot_root) ---
    if (!apply_overlay_mounts(cfg.overlay_mounts, new_root, res.error))
        return res;

    // --- 10. pivot_root into new_root ---
    // Bind new_root onto itself so it is a mount point (pivot_root requirement).
    if (mount(new_root.c_str(), new_root.c_str(), nullptr,
              MS_BIND | MS_REC, nullptr) != 0) {
        res.error = errno_str("bind-mount newroot onto itself");
        return res;
    }

    // Use the pivot_root(".", ".") trick: chdir then pivot in-place.
    if (chdir(new_root.c_str()) != 0) {
        res.error = errno_str("chdir newroot");
        return res;
    }
    if (do_pivot_root(".", ".") != 0) {
        res.error = errno_str("pivot_root");
        return res;
    }

    // Now "/" is the old root, "." is the new root.
    // Unmount the old root (detach so busy mounts don't fail).
    if (umount2(".", MNT_DETACH) != 0) {
        res.error = errno_str("umount2 old root");
        return res;
    }

    // Switch into the new "/".
    if (chdir("/") != 0) {
        res.error = errno_str("chdir / after pivot_root");
        return res;
    }

    // --- 11. Restore CWD inside the new root ---
    // If the old CWD exists inside the new root, go back there.
    // Otherwise fall back to "/".
    if (!saved_cwd.empty() && chdir(saved_cwd.c_str()) != 0) {
        chdir("/");
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
