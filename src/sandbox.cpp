#include "sandbox.h"

#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <set>
#include <vector>

#include <fcntl.h>
#include <unistd.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <dirent.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <stddef.h>

namespace boxsh {

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

static std::string path_parent(const std::string &p);
static bool bind_mount(const std::string &src, const std::string &dst,
                       bool readonly, std::string &err);

enum class ProtectedPathKind {
    File,
    Directory,
};

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

static bool path_exists(const std::string &path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

static bool path_lexists(const std::string &path) {
    struct stat st;
    return lstat(path.c_str(), &st) == 0;
}

static bool ensure_file_mountpoint(const std::string &path, std::string &err) {
    int fd = open(path.c_str(), O_CREAT | O_WRONLY | O_CLOEXEC, 0444);
    if (fd < 0 && errno != EEXIST) {
        err = errno_str(("create protected file mountpoint: " + path).c_str());
        return false;
    }
    if (fd >= 0) close(fd);
    return true;
}

static bool protect_path_readonly(const std::string &host_path,
                                  const std::string &new_root,
                                  bool is_dir,
                                  std::string &err) {
    std::string sandbox_path = new_root + host_path;
    if (is_dir) {
        if (!mkdir_p(sandbox_path, 0755, err)) return false;
    } else {
        std::string parent = path_parent(sandbox_path);
        if (!mkdir_p(parent, 0755, err)) return false;
        if (!ensure_file_mountpoint(sandbox_path, err)) return false;
    }
    return bind_mount(host_path, sandbox_path, /*readonly=*/true, err);
}

static bool ensure_protection_sources(const std::string &new_root,
                                      std::string &empty_dir,
                                      std::string &empty_file,
                                      std::string &err) {
    std::string base = new_root + "/.boxsh-protect";
    if (!mkdir_p(base, 0755, err)) return false;

    empty_dir = base + "/empty-dir";
    if (!mkdir_p(empty_dir, 0755, err)) return false;

    empty_file = base + "/empty-file";
    if (!ensure_file_mountpoint(empty_file, err)) return false;

    return true;
}

static bool write_cleanup_path(int fd, const std::string &path,
                               std::string &err) {
    if (fd < 0) return true;

    size_t off = 0;
    const size_t len = path.size() + 1;
    const char *data = path.c_str();
    while (off < len) {
        ssize_t n = write(fd, data + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            err = errno_str("write cleanup path");
            return false;
        }
        off += static_cast<size_t>(n);
    }
    return true;
}

static bool has_non_directory_ancestor(const std::string &path) {
    std::string current;
    size_t pos = 1;
    while (pos <= path.size()) {
        size_t next = path.find('/', pos);
        if (next == std::string::npos) next = path.size();
        current = path.substr(0, next);
        if (current.empty()) {
            pos = next + 1;
            continue;
        }

        struct stat st;
        if (lstat(current.c_str(), &st) != 0) return false;
        if (!S_ISDIR(st.st_mode)) return true;

        pos = next + 1;
    }
    return false;
}

static std::string find_first_missing_component(const std::string &path) {
    std::string current;
    size_t pos = 1;
    while (pos <= path.size()) {
        size_t next = path.find('/', pos);
        if (next == std::string::npos) next = path.size();
        current = path.substr(0, next);
        if (current.empty()) {
            pos = next + 1;
            continue;
        }

        struct stat st;
        if (lstat(current.c_str(), &st) != 0) return current;
        pos = next + 1;
    }
    return path;
}

static bool ensure_host_dir_mountpoint(const std::string &path, std::string &err) {
    if (mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) {
        err = errno_str(("create protected dir mountpoint: " + path).c_str());
        return false;
    }
    return true;
}

static bool protect_missing_path_readonly(const std::string &host_path,
                                          const std::string &new_root,
                                          ProtectedPathKind kind,
                                          const std::string &empty_dir,
                                          const std::string &empty_file,
                                          int cleanup_fd,
                                          std::string &err) {
    if (has_non_directory_ancestor(host_path)) return true;

    std::string first_missing = find_first_missing_component(host_path);
    bool mount_as_dir = (kind == ProtectedPathKind::Directory) ||
                        (first_missing != host_path);

    if (!path_lexists(first_missing)) {
        if (mount_as_dir) {
            if (!ensure_host_dir_mountpoint(first_missing, err)) return false;
        } else {
            if (!ensure_file_mountpoint(first_missing, err)) return false;
        }
        if (!write_cleanup_path(cleanup_fd, first_missing, err)) return false;
    }

    return bind_mount(mount_as_dir ? empty_dir : empty_file,
                      new_root + first_missing,
                      /*readonly=*/true,
                      err);
}

static bool protect_path_deny_write(const std::string &host_path,
                                    const std::string &new_root,
                                    ProtectedPathKind kind,
                                    const std::string &empty_dir,
                                    const std::string &empty_file,
                                    int cleanup_fd,
                                    std::string &err) {
    if (path_lexists(host_path)) {
        return protect_path_readonly(host_path,
                                     new_root,
                                     kind == ProtectedPathKind::Directory,
                                     err);
    }

    return protect_missing_path_readonly(host_path,
                                         new_root,
                                         kind,
                                         empty_dir,
                                         empty_file,
                                         cleanup_fd,
                                         err);
}

static bool path_intersects(const std::string &path,
                            const std::string &other) {
    auto is_under = [](const std::string &candidate,
                       const std::string &prefix) {
        return candidate == prefix ||
               (candidate.size() > prefix.size() &&
                candidate[prefix.size()] == '/' &&
                candidate.compare(0, prefix.size(), prefix) == 0);
    };
    return is_under(path, other) || is_under(other, path);
}

static bool path_is_under(const std::string &path,
                          const std::string &prefix) {
    return path == prefix ||
           (path.size() > prefix.size() &&
            path[prefix.size()] == '/' &&
            path.compare(0, prefix.size(), prefix) == 0);
}

static bool path_writable_via_bind(const SandboxConfig &cfg,
                                   const std::string &path) {
    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode != BindMount::Mode::RW) continue;
        if (path_intersects(path, bm.dst)) return true;
    }
    return false;
}

static bool protect_git_hook_dir(const std::string &repo_root,
                                 const std::string &new_root,
                                 const std::string &empty_dir,
                                 const std::string &empty_file,
                                 int cleanup_fd,
                                 std::string &err) {
    std::string git_dir = repo_root + "/.git";
    struct stat st;
    if (lstat(git_dir.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) {
        return true;
    }

    std::string hooks = git_dir + "/hooks";
    return protect_path_deny_write(hooks,
                                   new_root,
                                   ProtectedPathKind::Directory,
                                   empty_dir,
                                   empty_file,
                                   cleanup_fd,
                                   err);
}

static bool protect_git_hook_paths(const SandboxConfig &cfg,
                                   const std::string &home,
                                   const std::string &saved_cwd,
                                   const std::string &new_root,
                                   const std::string &empty_dir,
                                   const std::string &empty_file,
                                   int cleanup_fd,
                                   std::string &err) {
    struct ScanEntry {
        std::string dir;
        int depth;
    };

    std::set<std::string> scan_roots;
    std::set<std::string> visited;
    std::set<std::string> protected_repos;
    std::vector<ScanEntry> stack;

    if (path_is_under(saved_cwd, home) && path_writable_via_bind(cfg, saved_cwd)) {
        scan_roots.insert(saved_cwd);
    }

    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode != BindMount::Mode::RW) continue;
        if (!path_is_under(bm.dst, home)) continue;
        scan_roots.insert(bm.dst);
    }

    for (const auto &root : scan_roots) {
        std::string current = root;
        while (path_is_under(current, home)) {
            if (protected_repos.insert(current).second &&
                !protect_git_hook_dir(current,
                                      new_root,
                                      empty_dir,
                                      empty_file,
                                      cleanup_fd,
                                      err)) {
                return false;
            }
            if (current == home) break;
            current = path_parent(current);
        }

        stack.push_back({root, 0});
    }

    while (!stack.empty()) {
        ScanEntry entry = stack.back();
        stack.pop_back();

        if (!visited.insert(entry.dir).second) continue;
        if (protected_repos.insert(entry.dir).second &&
            !protect_git_hook_dir(entry.dir,
                                  new_root,
                                  empty_dir,
                                  empty_file,
                                  cleanup_fd,
                                  err)) {
            return false;
        }
        if (entry.depth >= 2) continue;

        DIR *d = opendir(entry.dir.c_str());
        if (!d) continue;

        struct dirent *ent;
        while ((ent = readdir(d)) != nullptr) {
            if (std::strcmp(ent->d_name, ".") == 0 ||
                std::strcmp(ent->d_name, "..") == 0) {
                continue;
            }
            if (ent->d_name[0] == '.' && std::strcmp(ent->d_name, ".git") != 0) {
                continue;
            }

            std::string child = entry.dir + "/" + ent->d_name;
            struct stat st;
            if (lstat(child.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) {
                continue;
            }
            if (!path_is_under(child, home)) continue;

            stack.push_back({child, entry.depth + 1});
        }

        closedir(d);
    }

    return true;
}

static std::vector<std::string> read_cleanup_paths(int fd) {
    std::vector<std::string> paths;
    std::string current;
    char buf[512];

    if (fd < 0) return paths;
    lseek(fd, 0, SEEK_SET);

    for (;;) {
        ssize_t n = read(fd, buf, sizeof(buf));
        if (n == 0) break;
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }

        for (ssize_t i = 0; i < n; ++i) {
            if (buf[i] == '\0') {
                if (!current.empty()) {
                    paths.push_back(current);
                    current.clear();
                }
            } else {
                current.push_back(buf[i]);
            }
        }
    }

    if (!current.empty()) paths.push_back(current);
    return paths;
}

static void cleanup_host_mountpoints(std::vector<std::string> paths) {
    std::sort(paths.begin(), paths.end());
    paths.erase(std::unique(paths.begin(), paths.end()), paths.end());
    std::sort(paths.begin(), paths.end(),
              [](const std::string &a, const std::string &b) {
                  return a.size() > b.size();
              });

    for (const auto &path : paths) {
        struct stat st;
        if (lstat(path.c_str(), &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            rmdir(path.c_str());
        } else {
            unlink(path.c_str());
        }
    }
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

static bool create_cleanup_file(int &fd, std::string &err) {
    char path[] = "/tmp/boxsh-cleanup-XXXXXX";
    fd = mkstemp(path);
    if (fd < 0) {
        err = errno_str("mkstemp cleanup file");
        return false;
    }

    if (unlink(path) != 0) {
        err = errno_str("unlink cleanup file");
        close(fd);
        fd = -1;
        return false;
    }

    int flags = fcntl(fd, F_GETFD);
    if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0) {
        err = errno_str("fcntl cleanup file cloexec");
        close(fd);
        fd = -1;
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

    // Fall back to fuse-overlayfs for the two user-namespace failure modes we
    // see in practice: EINVAL on XFS with large inodes and EPERM when nested
    // containers block kernel overlay mounts without CAP_SYS_ADMIN.
    int saved_errno = errno;
    if (saved_errno != EINVAL && saved_errno != EPERM) {
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

// Return the last component of a path.
static std::string path_basename(const std::string &p) {
    size_t pos = p.rfind('/');
    if (pos == std::string::npos) return p;
    return p.substr(pos + 1);
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

    // /proc — mount a fresh procfs that only shows processes in our PID
    // namespace.  This prevents leaking host process information (cmdline,
    // environ, memory maps) which would be exposed by a bind-mount of the
    // host's /proc.
    if (mkdir((new_root + "/proc").c_str(), 0755) != 0 && errno != EEXIST) {
        err = errno_str("mkdir /proc");
        return false;
    }
    if (mount("proc", (new_root + "/proc").c_str(), "proc",
              MS_NOSUID | MS_NODEV | MS_NOEXEC, nullptr) != 0) {
        err = errno_str("mount proc");
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
    // CLONE_NEWPID isolates the process tree: the next fork()'d child becomes
    // PID 1 in a new PID namespace.  Host processes are invisible, and signals
    // cannot escape the namespace boundary.
    int unshare_flags = CLONE_NEWNS | CLONE_NEWUSER | CLONE_NEWPID;
    if (cfg.new_net_ns)  unshare_flags |= CLONE_NEWNET;

    if (unshare(unshare_flags) != 0) {
        res.error = errno_str("unshare");
        return res;
    }

    // --- 2. Write uid/gid mapping ---
    // When called via unshare() (no separate fork) we write the map ourselves.
    {
        char self_setgroups[] = "/proc/self/setgroups";
        if (!write_file(self_setgroups, "deny") && errno != ENOENT) {
            res.error = errno_str("write setgroups deny");
            return res;
        }

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

    int cleanup_fd = -1;
    if (!create_cleanup_file(cleanup_fd, res.error)) {
        return res;
    }

    // --- 3b. Fork into the new PID namespace ---
    // CLONE_NEWPID only affects children: the next fork()'d child becomes
    // PID 1 in the new PID namespace.  The parent stays in the old namespace
    // and acts as a simple wait-and-forward wrapper.
    {
        pid_t child = fork();
        if (child < 0) {
            close(cleanup_fd);
            res.error = errno_str("fork for PID namespace");
            return res;
        }
        if (child > 0) {
            // Parent: forward signals to child, wait for it, then _exit.
            // This process never returns from sandbox_apply().
            static volatile pid_t g_sandbox_child = child;
            auto fwd = [](int sig) {
                kill(g_sandbox_child, sig);
            };
            signal(SIGTERM, fwd);
            signal(SIGINT,  fwd);
            signal(SIGHUP,  fwd);

            int status = 0;
            while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}

            std::vector<std::string> cleanup_paths = read_cleanup_paths(cleanup_fd);
            close(cleanup_fd);
            cleanup_host_mountpoints(cleanup_paths);

            if (WIFEXITED(status))   _exit(WEXITSTATUS(status));
            if (WIFSIGNALED(status)) _exit(128 + WTERMSIG(status));
            _exit(1);
        }
        // Child: now PID 1 in the new PID namespace.

        // Prevent ptrace attachment from outside the namespace.
        prctl(PR_SET_DUMPABLE, 0);

        // As PID 1, we must reap orphaned child processes to prevent zombie
        // accumulation.  Install a SIGCHLD handler that reaps all finished
        // children asynchronously.
        struct sigaction sa = {};
        sa.sa_handler = [](int) {
            while (waitpid(-1, nullptr, WNOHANG) > 0) {}
        };
        sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
        sigaction(SIGCHLD, &sa, nullptr);
    }

    struct CleanupPipeCloser {
        int fd;
        ~CleanupPipeCloser() {
            if (fd >= 0) close(fd);
        }
    } cleanup_pipe_closer{cleanup_fd};

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

    // --- 7. COW bind mounts: overlayfs with deterministic workdir ---
    // dst is used as the upperdir (captures writes); the workdir is placed
    // at <parent>/.boxsh/<basename> so it lives inside the same filesystem
    // and is cleaned up together with dst.  The deterministic path also
    // prevents duplicate COW mounts on the same dst (overlayfs returns
    // EBUSY when two mounts share a workdir).

    // Lazy cleanup: scan .boxsh dirs and remove entries whose corresponding
    // sibling directory no longer exists.
    {
        std::set<std::string> boxsh_parents;
        for (const auto &bm : cfg.bind_mounts) {
            if (bm.mode != BindMount::Mode::COW) continue;
            boxsh_parents.insert(path_parent(bm.dst));
        }
        for (const auto &parent : boxsh_parents) {
            std::string dotboxsh = parent + "/.boxsh";
            DIR *d = opendir(dotboxsh.c_str());
            if (!d) continue;
            struct dirent *ent;
            while ((ent = readdir(d)) != nullptr) {
                if (ent->d_name[0] == '.') continue;
                std::string sibling = parent + "/" + ent->d_name;
                struct stat st;
                if (stat(sibling.c_str(), &st) != 0) {
                    // Sibling gone — remove stale workdir.
                    std::string stale = dotboxsh + "/" + ent->d_name;
                    // workdir may contain a kernel-created "work" subdir.
                    rmdir((stale + "/work").c_str());
                    rmdir(stale.c_str());
                }
            }
            closedir(d);
            // Remove .boxsh itself if now empty.
            rmdir(dotboxsh.c_str());
        }
    }

    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode != BindMount::Mode::COW) continue;

        // Ensure upper layer directory exists on the host.
        if (!mkdir_p(bm.dst, 0755, res.error)) return res;

        // Deterministic workdir: <parent>/.boxsh/<basename>
        std::string parent = path_parent(bm.dst);
        std::string name   = path_basename(bm.dst);
        std::string workdir = parent + "/.boxsh/" + name;
        if (!mkdir_p(workdir, 0755, res.error)) return res;

        if (!mount_overlay_at(bm.src, new_root + bm.dst, bm.dst, workdir,
                              new_root, res.error))
            return res;
    }

    // --- 8. Protect dangerous home paths from writes ---
    // Even when $HOME is exposed read-write, high-value shell, credential,
    // and VCS hook paths must stay read-only to prevent persistent backdoors
    // that survive sandbox teardown.
    {
        const char *home_env = getenv("HOME");
        if (home_env && home_env[0] != '\0') {
            std::string home(home_env);
            if (path_exists(new_root + home) && path_writable_via_bind(cfg, home)) {
                std::string empty_dir;
                std::string empty_file;
                if (!ensure_protection_sources(new_root,
                                               empty_dir,
                                               empty_file,
                                               res.error)) {
                    return res;
                }

                static const char *const dangerous_files[] = {
                    ".bashrc", ".bash_profile", ".profile",
                    ".zshrc", ".zprofile",
                    ".gitconfig", ".gitmodules", ".ripgreprc",
                    ".mcp.json", ".npmrc",
                    ".aws/credentials", ".pip/pip.conf",
                    ".cargo/credentials.toml",
                    nullptr
                };
                static const char *const dangerous_dirs[] = {
                    ".ssh", ".gnupg", ".config/gcloud", nullptr
                };

                for (int i = 0; dangerous_files[i]; i++) {
                    std::string protected_path = home + "/" + dangerous_files[i];
                    if (!path_writable_via_bind(cfg, protected_path)) continue;
                    if (!protect_path_deny_write(protected_path,
                                                 new_root,
                                                 ProtectedPathKind::File,
                                                 empty_dir,
                                                 empty_file,
                                                 cleanup_fd,
                                                 res.error)) {
                        return res;
                    }
                }
                for (int i = 0; dangerous_dirs[i]; i++) {
                    std::string protected_path = home + "/" + dangerous_dirs[i];
                    if (!path_writable_via_bind(cfg, protected_path)) continue;
                    if (!protect_path_deny_write(protected_path,
                                                 new_root,
                                                 ProtectedPathKind::Directory,
                                                 empty_dir,
                                                 empty_file,
                                                 cleanup_fd,
                                                 res.error)) {
                        return res;
                    }
                }

                if (path_writable_via_bind(cfg, home) &&
                    !protect_git_hook_paths(cfg,
                                            home,
                                            saved_cwd,
                                            new_root,
                                            empty_dir,
                                            empty_file,
                                            cleanup_fd,
                                            res.error)) {
                    return res;
                }
            }
        }
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
            // The saved CWD may not exist inside the new root (e.g. /tmp is a
            // fresh tmpfs not shared with the host).  Only auto-create the
            // directory when it lives under a writable, sandbox-owned mount
            // (currently only /tmp).  For paths outside any mount, we must
            // NOT create them — that would leak a host path into the sandbox.
            if (errno == ENOENT &&
                (restore_path == "/tmp" ||
                 restore_path.compare(0, 5, "/tmp/") == 0)) {
                std::string ignored_err;
                mkdir_p(restore_path, 0755, ignored_err);
                if (chdir(restore_path.c_str()) != 0) {
                    chdir("/");
                }
            } else {
                chdir("/");
            }
        }
    }

    // --- 12. Apply seccomp-bpf syscall filter ---
    // Block dangerous syscalls that could be used to escape the sandbox:
    //   - socket(AF_UNIX, ...) — prevents connecting to Docker, SSH agent, D-Bus
    //   - io_uring_setup/enter/register — prevents bypassing seccomp via io_uring
    {
        // AUDIT_ARCH_* must match the target: use compiler-defined arch macros.
#if defined(__x86_64__)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_AARCH64
#elif defined(__i386__)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_I386
#elif defined(__arm__)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_ARM
#elif defined(__mips64)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_MIPSEL64
#elif defined(__powerpc64__)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_PPC64LE
#elif defined(__riscv) && (__riscv_xlen == 64)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_RISCV64
#elif defined(__loongarch64)
#define BOXSH_AUDIT_ARCH AUDIT_ARCH_LOONGARCH64
#else
#warning "seccomp: unsupported architecture, skipping filter"
#endif

        // Syscall numbers come from <sys/syscall.h> — automatically correct
        // for the target architecture, no manual table needed.
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup    425
#endif
#ifndef __NR_io_uring_enter
#define __NR_io_uring_enter    426
#endif
#ifndef __NR_io_uring_register
#define __NR_io_uring_register 427
#endif

#ifdef BOXSH_AUDIT_ARCH
        struct sock_filter filter[] = {
            // [0] Load architecture
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
            // [1] Check architecture matches — if not, allow (skip to ALLOW)
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, BOXSH_AUDIT_ARCH, 0, 9),

            // [2] Load syscall number
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),

            // [3] Check io_uring_setup
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 6, 0),
            // [4] Check io_uring_enter
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 5, 0),
            // [5] Check io_uring_register
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_register, 4, 0),

            // [6] Check if socket syscall
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 4),

            // [7] socket() — load first argument (domain/family)
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
            // [8] If AF_UNIX (1), block it
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 1 /*AF_UNIX*/, 0, 2),

            // [9] Block: return EPERM
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | 1 /*EPERM*/),

            // [10] Also block (for io_uring): return EPERM
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | 1 /*EPERM*/),

            // [11] Allow
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        };

        struct sock_fprog prog = {
            .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
            .filter = filter,
        };

        // Allow the process to install seccomp filters without CAP_SYS_ADMIN.
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
            res.error = errno_str("prctl PR_SET_NO_NEW_PRIVS");
            return res;
        }
        if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) {
            res.error = errno_str("prctl PR_SET_SECCOMP");
            return res;
        }
#endif
#undef BOXSH_AUDIT_ARCH
    }

    res.ok = true;
    return res;
}

} // namespace boxsh
