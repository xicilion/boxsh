#include "sandbox.h"

#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <climits>
#include <atomic>
#include <chrono>
#include <string>
#include <thread>

#include <unistd.h>
#include <sys/stat.h>
#include <sys/clonefile.h>

// sandbox_init() is declared deprecated/obsoleted in the public SDK for
// deployment targets >= macOS 10.8, so including <sandbox.h> hides the
// declarations via availability guards.  We forward-declare the functions
// directly here — the symbols still exist in libSystem at runtime and have
// been verified to work on macOS 26 (see macos-sandbox-design.md §3.1).
extern "C" {
    int  sandbox_init(const char *profile, uint64_t flags, char **errorbuf);
    void sandbox_free_error(char *errorbuf);
}

namespace boxsh {

static std::string errno_str(const char *context) {
    return std::string(context) + ": " + std::strerror(errno);
}

// ---------------------------------------------------------------------------
// SBPL profile builder
// ---------------------------------------------------------------------------

// Resolve symlinks in a path using realpath(3).  Returns the original path
// unchanged if realpath fails (e.g. path does not yet exist).
static std::string resolve_path(const std::string &path) {
    char buf[PATH_MAX];
    const char *r = realpath(path.c_str(), buf);
    return r ? std::string(r) : path;
}

// True if path equals prefix or starts with prefix + '/'.
static bool is_under(const std::string &path, const std::string &prefix) {
    return path == prefix ||
           (path.size() > prefix.size() &&
            path[prefix.size()] == '/' &&
            path.compare(0, prefix.size(), prefix) == 0);
}

// Build a Sandbox Profile Language (SBPL) string from the sandbox
// configuration.  sandbox_init() with flags=0 and a custom SBPL string is an
// undocumented private API verified to work on macOS 26+.
//
// Design: whitelist system-maintained directories for read access; everything
// else (user homes, external drives, network mounts, …) is denied unless
// explicitly exposed via --bind.  Write access is granted only to /dev and
// explicit bind-mount destinations.
//
// All paths are resolved via realpath() so SBPL subpath rules use canonical
// paths (e.g. /private/tmp rather than the /tmp symlink).

// Emit (allow file-read-metadata (literal "…")) for each ancestor directory
// of 'path' so that the kernel can traverse intermediate directories outside
// the whitelisted system paths.  Required for getcwd() and path lookup when
// a bound path lives under e.g. /Users/me/project.
static void allow_ancestor_metadata(std::string &p, const std::string &path) {
    for (size_t i = 1; i < path.size(); ++i) {
        if (path[i] == '/') {
            std::string dir = path.substr(0, i);
            p += "(allow file-read-metadata (literal \"" + dir + "\"))\n";
        }
    }
}

static std::string build_sbpl(const SandboxConfig &cfg) {
    std::string p;
    p += "(version 1)\n";
    p += "(deny default)\n";

    // Root directory — full read access.  macOS has symlinks at root level
    // (/var → /private/var, /tmp → /private/tmp, /etc → /private/etc) and
    // resolving them requires file-read-data, not just metadata.
    p += "(allow file-read* (literal \"/\"))\n";

    // System-maintained directories — read-only access.  These are owned and
    // managed by the OS; they do not contain user data.
    static const char *const system_dirs[] = {
        "/usr", "/bin", "/sbin",
        "/System", "/Library", "/Applications",
        "/opt",
        "/dev",
        "/private",
        // /var, /tmp, /etc are symlinks to /private/* on macOS.  The sandbox
        // evaluates paths before resolving symlinks, so these must be listed
        // explicitly in addition to /private.
        "/var", "/tmp", "/etc",
        nullptr
    };
    for (int i = 0; system_dirs[i]; i++) {
        p += "(allow file-read* (subpath \"";
        p += system_dirs[i];
        p += "\"))\n";
    }

    // Process permissions — only exec, fork, and same-sandbox info/signal.
    p += "(allow process-exec)\n";
    p += "(allow process-fork)\n";
    p += "(allow process-info* (target same-sandbox))\n";
    p += "(allow signal (target same-sandbox))\n";

    // Mach IPC — whitelist of audited safe XPC services.
    p += "(allow mach-lookup\n";
    p += "  (global-name \"com.apple.audio.systemsoundserver\")\n";
    p += "  (global-name \"com.apple.distributed_notifications@Uv3\")\n";
    p += "  (global-name \"com.apple.FontObjectsServer\")\n";
    p += "  (global-name \"com.apple.fonts\")\n";
    p += "  (global-name \"com.apple.logd\")\n";
    p += "  (global-name \"com.apple.lsd.mapdb\")\n";
    p += "  (global-name \"com.apple.PowerManagement.control\")\n";
    p += "  (global-name \"com.apple.system.logger\")\n";
    p += "  (global-name \"com.apple.system.notification_center\")\n";
    p += "  (global-name \"com.apple.system.opendirectoryd.libinfo\")\n";
    p += "  (global-name \"com.apple.system.opendirectoryd.membership\")\n";
    p += "  (global-name \"com.apple.bsd.dirhelper\")\n";
    p += "  (global-name \"com.apple.securityd.xpc\")\n";
    p += "  (global-name \"com.apple.SecurityServer\")\n";
    p += ")\n";

    // POSIX IPC — only shared memory and semaphores.
    p += "(allow ipc-posix-shm)\n";
    p += "(allow ipc-posix-sem)\n";

    // sysctl — read-only, restricted to a curated whitelist.
    p += "(allow sysctl-read\n";
    p += "  (sysctl-name \"hw.activecpu\")\n";
    p += "  (sysctl-name \"hw.busfrequency_compat\")\n";
    p += "  (sysctl-name \"hw.byteorder\")\n";
    p += "  (sysctl-name \"hw.cacheconfig\")\n";
    p += "  (sysctl-name \"hw.cachelinesize_compat\")\n";
    p += "  (sysctl-name \"hw.cpufamily\")\n";
    p += "  (sysctl-name \"hw.cpufrequency\")\n";
    p += "  (sysctl-name \"hw.cpufrequency_compat\")\n";
    p += "  (sysctl-name \"hw.cputype\")\n";
    p += "  (sysctl-name \"hw.l1dcachesize_compat\")\n";
    p += "  (sysctl-name \"hw.l1icachesize_compat\")\n";
    p += "  (sysctl-name \"hw.l2cachesize_compat\")\n";
    p += "  (sysctl-name \"hw.l3cachesize_compat\")\n";
    p += "  (sysctl-name \"hw.logicalcpu\")\n";
    p += "  (sysctl-name \"hw.logicalcpu_max\")\n";
    p += "  (sysctl-name \"hw.machine\")\n";
    p += "  (sysctl-name \"hw.memsize\")\n";
    p += "  (sysctl-name \"hw.ncpu\")\n";
    p += "  (sysctl-name \"hw.nperflevels\")\n";
    p += "  (sysctl-name \"hw.packages\")\n";
    p += "  (sysctl-name \"hw.pagesize_compat\")\n";
    p += "  (sysctl-name \"hw.pagesize\")\n";
    p += "  (sysctl-name \"hw.physicalcpu\")\n";
    p += "  (sysctl-name \"hw.physicalcpu_max\")\n";
    p += "  (sysctl-name \"hw.tbfrequency_compat\")\n";
    p += "  (sysctl-name \"hw.vectorunit\")\n";
    p += "  (sysctl-name \"kern.argmax\")\n";
    p += "  (sysctl-name \"kern.hostname\")\n";
    p += "  (sysctl-name \"kern.maxfiles\")\n";
    p += "  (sysctl-name \"kern.maxfilesperproc\")\n";
    p += "  (sysctl-name \"kern.maxproc\")\n";
    p += "  (sysctl-name \"kern.ngroups\")\n";
    p += "  (sysctl-name \"kern.osproductversion\")\n";
    p += "  (sysctl-name \"kern.osrelease\")\n";
    p += "  (sysctl-name \"kern.ostype\")\n";
    p += "  (sysctl-name \"kern.osversion\")\n";
    p += "  (sysctl-name \"kern.version\")\n";
    p += "  (sysctl-name-prefix \"hw.optional.\")\n";
    p += "  (sysctl-name-prefix \"hw.perflevel\")\n";
    p += "  (sysctl-name-prefix \"kern.proc.pid.\")\n";
    p += "  (sysctl-name-prefix \"machdep.cpu.\")\n";
    p += "  (sysctl-name-prefix \"sysctl.\")\n";
    p += ")\n";

    // File ioctl — restricted to specific device paths.
    p += "(allow file-ioctl (literal \"/dev/null\"))\n";
    p += "(allow file-ioctl (literal \"/dev/zero\"))\n";
    p += "(allow file-ioctl (literal \"/dev/random\"))\n";
    p += "(allow file-ioctl (literal \"/dev/urandom\"))\n";
    p += "(allow file-ioctl (literal \"/dev/tty\"))\n";

    // Allow reads and writes to /dev (e.g. /dev/null, /dev/zero, /dev/urandom).
    p += "(allow file-write* (subpath \"/dev\"))\n";

    // User-specified bind rules.  Paths are resolved so SBPL matches the
    // canonical path that the kernel presents to the policy engine.
    // For each bound path we also allow file-read-metadata on its ancestor
    // directories so that getcwd() and path lookup work correctly.
    for (const auto &bm : cfg.bind_mounts) {
        std::string rsrc = resolve_path(bm.src);
        allow_ancestor_metadata(p, rsrc);
        if (bm.mode == BindMount::Mode::RO) {
            p += "(allow file-read* (subpath \"" + rsrc + "\"))\n";
        } else if (bm.mode == BindMount::Mode::RW) {
            p += "(allow file-read* (subpath \"" + rsrc + "\"))\n";
            p += "(allow file-write* (subpath \"" + rsrc + "\"))\n";
        } else if (bm.mode == BindMount::Mode::COW) {
            std::string rdst = resolve_path(bm.dst);
            allow_ancestor_metadata(p, rdst);
            // Allow reads on the COW source.
            p += "(allow file-read* (subpath \"" + rsrc + "\"))\n";
            // Block writes to the COW source so it stays pristine.
            p += "(deny file-write* (subpath \"" + rsrc + "\"))\n";
            // Allow full read+write access to the clone (dst).
            p += "(allow file-read* (subpath \"" + rdst + "\"))\n";
            p += "(allow file-write* (subpath \"" + rdst + "\"))\n";
        }
    }

    // Protect dangerous dotfiles from writes.
    // Even when $HOME is RW-bound, shell config files and tool config
    // files must not be writable to prevent persistent backdoors that
    // survive sandbox teardown (e.g. injecting commands into .bashrc).
    // In SBPL, explicit deny rules override allow rules for the same
    // operation, so these take effect even after (allow file-write*
    // (subpath "$HOME")).
    {
        const char *home_env = getenv("HOME");
        if (home_env && home_env[0] != '\0') {
            std::string home = resolve_path(home_env);
            static const char *const dangerous_files[] = {
                ".bashrc", ".bash_profile", ".profile",
                ".zshrc", ".zprofile",
                ".gitconfig", ".mcp.json", ".npmrc",
                ".aws/credentials", ".pip/pip.conf",
                ".cargo/credentials.toml", ".ssh/authorized_keys",
                nullptr
            };
            static const char *const dangerous_dirs[] = {
                ".config/gcloud", ".gnupg", nullptr
            };
            for (int i = 0; dangerous_files[i]; i++) {
                p += "(deny file-write* (literal \""
                   + home + "/" + dangerous_files[i] + "\"))\n";
            }
            for (int i = 0; dangerous_dirs[i]; i++) {
                p += "(deny file-write* (subpath \""
                   + home + "/" + dangerous_dirs[i] + "\"))\n";
            }
        }
    }

    // Network: allow by default; deny everything when --new-net-ns is set.
    if (!cfg.new_net_ns) {
        p += "(allow network*)\n";
    }

    return p;
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

    // ── 1. COW: clonefile(src, dst) ──────────────────────────────────────
    // clonefile(2) creates an instant APFS COW snapshot of src at dst.
    // dst must not already exist.  main() pre-creates an empty directory
    // for Linux overlayfs compatibility; remove it before clonefile.
    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode != BindMount::Mode::COW) continue;

        struct stat st;
        if (stat(bm.dst.c_str(), &st) == 0) {
            if (!S_ISDIR(st.st_mode)) {
                res.error = "COW dst exists and is not a directory: " + bm.dst;
                return res;
            }
            if (rmdir(bm.dst.c_str()) != 0) {
                res.error = errno_str(("rmdir pre-existing dst: " + bm.dst).c_str());
                return res;
            }
        }

        // Show a spinner with elapsed time on stderr so the user knows
        // the clone is in progress.  The spinner only appears after a
        // short grace period to avoid flashing on small directories.
        bool show_progress = isatty(STDERR_FILENO);
        std::atomic<bool> clone_done{false};
        std::thread spinner;
        if (show_progress) {
            spinner = std::thread([&clone_done, &bm]() {
                static const char frames[] = "|/-\\";
                auto start = std::chrono::steady_clock::now();
                // Wait a short grace period before showing anything.
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
                int i = 0;
                while (!clone_done.load(std::memory_order_relaxed)) {
                    auto elapsed = std::chrono::duration_cast<
                        std::chrono::seconds>(
                            std::chrono::steady_clock::now() - start)
                        .count();
                    std::fprintf(stderr,
                        "\rboxsh: preparing snapshot of %s ... %c  %llds",
                        bm.src.c_str(), frames[i++ % 4], (long long)elapsed);
                    std::this_thread::sleep_for(
                        std::chrono::milliseconds(200));
                }
            });
        }

        int clone_rc = clonefile(bm.src.c_str(), bm.dst.c_str(), 0);
        int clone_errno = errno;
        clone_done.store(true, std::memory_order_relaxed);
        if (spinner.joinable()) spinner.join();
        if (show_progress) {
            // Clear the spinner line.
            std::fprintf(stderr, "\r\033[K");
        }

        if (clone_rc != 0) {
            if (clone_errno == ENOTSUP) {
                res.error = "clonefile: " + bm.src + " -> " + bm.dst
                    + ": filesystem does not support COW cloning"
                      " (APFS volume required)";
            } else {
                errno = clone_errno;
                res.error = errno_str(
                    ("clonefile: " + bm.src + " -> " + bm.dst).c_str());
            }
            return res;
        }
    }

    // ── 2. Apply Seatbelt profile ─────────────────────────────────────────
    // Capture CWD before sandbox_init — afterwards getcwd() may fail if
    // CWD is outside the whitelisted system paths.
    char *cwd_buf = getcwd(nullptr, 0);
    std::string saved_cwd = cwd_buf ? cwd_buf : "";
    free(cwd_buf);

    // sandbox_init() with flags=0 and a custom SBPL string is an undocumented
    // private API.  On failure we print a warning and continue without
    // sandboxing (documented fallback; see macos-sandbox-design.md §7).
    std::string profile = build_sbpl(cfg);
    char *sb_err = nullptr;
    int rc = sandbox_init(profile.c_str(), 0, &sb_err);
    if (rc != 0) {
        res.error = std::string("sandbox_init failed: ") +
                   (sb_err ? sb_err : "unknown error");
        if (sb_err) sandbox_free_error(sb_err);
        return res;
    }

    // ── 3. Redirect CWD ──────────────────────────────────────────────────
    // Use the saved_cwd captured before sandbox_init.  If the old CWD was
    // within a COW source, redirect into the clone (dst).  Otherwise, if
    // CWD is no longer accessible (outside whitelisted paths), fall back
    // to "/".
    {
        bool redirected = false;
        for (const auto &bm : cfg.bind_mounts) {
            if (bm.mode != BindMount::Mode::COW) continue;
            std::string rsrc = resolve_path(bm.src);
            if (!is_under(saved_cwd, rsrc)) continue;

            std::string new_cwd = (saved_cwd == rsrc)
                ? bm.dst
                : bm.dst + saved_cwd.substr(rsrc.size());
            if (chdir(new_cwd.c_str()) != 0) {
                chdir(bm.dst.c_str()); // fall back to clone root
            }
            redirected = true;
            break;
        }

        // If CWD was not redirected, verify it is still accessible.
        // With the whitelist SBPL, CWD under /Users (or other non-system
        // paths) becomes inaccessible — fall back to "/".
        if (!redirected) {
            char *check = getcwd(nullptr, 0);
            if (!check) {
                chdir("/");
            } else {
                free(check);
            }
        }
    }

    res.ok = true;
    return res;
}

} // namespace boxsh
