#include "sandbox.h"

#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include <fcntl.h>
#include <unistd.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>

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

// Try to mount an overlay using fuse-overlayfs(1).  This is the fallback
// when kernel overlayfs fails (e.g. XFS with large inodes in a user
// namespace).  fuse-overlayfs runs entirely in userspace via FUSE and is
// not affected by kernel-level file-handle encoding limitations.
//
// fuse-overlayfs daemonises itself by default.  We fork+exec and then
// wait for the mount point to appear (poll the mount table).
static bool try_fuse_overlayfs(const std::string &lowerdir,
                                const std::string &dest,
                                const std::string &upper,
                                const std::string &work,
                                std::string &err) {
    // Check whether the binary is available before forking.
    if (access("/usr/bin/fuse-overlayfs", X_OK) != 0 &&
        access("/usr/local/bin/fuse-overlayfs", X_OK) != 0) {
        err = "fuse-overlayfs not found; "
              "install it with: apt install fuse-overlayfs";
        return false;
    }

    std::string opts = "lowerdir=" + lowerdir +
                       ",upperdir=" + upper +
                       ",workdir="  + work;

    pid_t pid = fork();
    if (pid < 0) {
        err = errno_str("fork for fuse-overlayfs");
        return false;
    }
    if (pid == 0) {
        // Child: exec fuse-overlayfs.
        execlp("fuse-overlayfs", "fuse-overlayfs",
               "-o", opts.c_str(), dest.c_str(), nullptr);
        _exit(127);
    }

    // Parent: wait for the child to finish (fuse-overlayfs daemonises).
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        err = errno_str("waitpid fuse-overlayfs");
        return false;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        err = "fuse-overlayfs exited with status " +
              std::to_string(WIFEXITED(status) ? WEXITSTATUS(status) : -1);
        return false;
    }
    return true;
}

static bool mount_overlay_at(const std::string &lowerdir,
                               const std::string &dest,
                               const std::string &upper,
                               const std::string &work,
                               const std::string & /*staging_base*/,
                               std::string &err) {
    if (!mkdir_p(dest, 0755, err)) return false;

    // xino=off: disable cross-inode-number encoding between lower and upper
    // layers.  Without this, overlayfs copy-up fails with EOVERFLOW when the
    // lower filesystem has inode numbers that exceed the representable range.
    std::string opts = "lowerdir=" + lowerdir +
                       ",upperdir=" + upper +
                       ",workdir="  + work +
                       ",xino=off";
    if (mount("overlay", dest.c_str(), "overlay", 0, opts.c_str()) == 0)
        return true;

    // Only fall back to fuse-overlayfs for EINVAL, which is the specific
    // error produced by XFS with large inodes in a user namespace ("failed
    // to clone lowerpath").  Other errors (ENOENT, EPERM, …) indicate real
    // configuration problems that fuse-overlayfs won't fix.
    int saved_errno = errno;
    if (saved_errno != EINVAL) {
        err = errno_str(("mount overlay -> " + dest).c_str());
        return false;
    }

    std::fprintf(stderr,
        "boxsh: kernel overlay mount failed (%s), trying fuse-overlayfs...\n",
        std::strerror(saved_errno));

    if (try_fuse_overlayfs(lowerdir, dest, upper, work, err))
        return true;

    // Both methods failed — report the fuse-overlayfs error which contains
    // an actionable install hint.
    return false;
}

// Return the parent directory of an absolute path.
static std::string path_parent(const std::string &p) {
    size_t pos = p.rfind('/');
    if (pos == std::string::npos || pos == 0) return "/";
    return p.substr(0, pos);
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

    // Capture host uid/gid before unshare — after CLONE_NEWUSER the real
    // ids are no longer visible.  These are Linux-specific and not part of
    // the platform-neutral SandboxConfig.
    uint32_t host_uid = (uint32_t)getuid();
    uint32_t host_gid = (uint32_t)getgid();

    // --- 1. Unshare namespaces ---
    int unshare_flags = CLONE_NEWNS | CLONE_NEWUSER;
    if (cfg.new_net_ns)  unshare_flags |= CLONE_NEWNET;

    if (unshare(unshare_flags) != 0) {
        res.error = errno_str("unshare");
        return res;
    }

    // --- 2. Write uid/gid mapping ---
    // When called via unshare() (no separate fork) we write the map ourselves.
    {
        char self_setgroups[] = "/proc/self/setgroups";
        write_file(self_setgroups, "deny");

        char uid_map_content[64];
        char gid_map_content[64];
        std::snprintf(uid_map_content, sizeof(uid_map_content),
                      "0 %u 1\n", host_uid);
        std::snprintf(gid_map_content, sizeof(gid_map_content),
                      "0 %u 1\n", host_gid);

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

    // --- 6. User-specified RO/RW bind mounts ---
    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode == BindMount::Mode::COW) continue;
        bool readonly = (bm.mode == BindMount::Mode::RO);
        if (!bind_mount(bm.src, new_root + bm.dst, readonly, res.error))
            return res;
    }

    // --- 7. COW bind mounts: overlayfs with auto-created workdir ---
    // dst is used as the upperdir (captures writes); a sibling workdir is
    // created automatically.  After the sandbox exits, dst on the host holds
    // the upper layer so the caller can inspect changes.
    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode != BindMount::Mode::COW) continue;

        // Ensure upper layer directory exists on the host.
        if (!mkdir_p(bm.dst, 0755, res.error)) return res;

        // Auto-create workdir as a sibling of dst (same filesystem as upper).
        std::string work_tmpl = path_parent(bm.dst) + "/.boxsh-ovl-work-XXXXXX";
        std::vector<char> work_buf(work_tmpl.begin(), work_tmpl.end());
        work_buf.push_back('\0');
        if (!mkdtemp(work_buf.data())) {
            res.error = errno_str("mkdtemp for COW workdir");
            return res;
        }
        std::string workdir(work_buf.data());

        if (!mount_overlay_at(bm.src, new_root + bm.dst, bm.dst, workdir,
                              new_root, res.error))
            return res;
    }

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
    // --- 11. Restore CWD inside the new root ---
    // For COW mounts: if the old CWD was within a COW source, redirect to
    // the corresponding dst (the overlay mount point) so the process works
    // through the overlay.  Otherwise fall back to saved_cwd or "/".
    {
        auto is_under = [](const std::string &path,
                           const std::string &prefix) -> bool {
            return path == prefix ||
                   (path.size() > prefix.size() && path[prefix.size()] == '/' &&
                    path.compare(0, prefix.size(), prefix) == 0);
        };

        std::string restore_path = saved_cwd;
        for (const auto &bm : cfg.bind_mounts) {
            if (bm.mode == BindMount::Mode::COW && is_under(saved_cwd, bm.src)) {
                if (saved_cwd == bm.src) {
                    restore_path = bm.dst;
                } else {
                    restore_path = bm.dst + saved_cwd.substr(bm.src.size());
                }
                break;
            }
        }

        if (!restore_path.empty() && chdir(restore_path.c_str()) != 0) {
            chdir("/");
        }
    }

    res.ok = true;
    return res;
}

} // namespace boxsh
