#include "sandbox.h"

#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <climits>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>
#include <thread>

#include <mach-o/dyld.h>
#include <signal.h>
#include <unistd.h>
#include <dirent.h>
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

namespace fs = std::filesystem;

static std::string errno_str(const char *context) {
    return std::string(context) + ": " + std::strerror(errno);
}

static std::string cow_manifest_path(const std::string &dst) {
    fs::path dst_path(dst);
    return (dst_path.parent_path() / ".boxsh" /
            (dst_path.filename().string() + ".manifest")).string();
}

static bool path_exists(const std::string &path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

static bool write_cow_manifest(const std::string &src,
                               const std::string &dst,
                               std::string &error) {
    fs::path src_path(src);
    fs::path manifest_path(cow_manifest_path(dst));

    std::error_code ec;
    fs::create_directories(manifest_path.parent_path(), ec);
    if (ec) {
        error = "create manifest parent: " + manifest_path.parent_path().string()
              + ": " + ec.message();
        return false;
    }

    std::ofstream manifest(manifest_path, std::ios::out | std::ios::trunc);
    if (!manifest) {
        error = errno_str(("open manifest: " + manifest_path.string()).c_str());
        return false;
    }

    fs::recursive_directory_iterator it(
        src_path,
        fs::directory_options::skip_permission_denied,
        ec
    );
    fs::recursive_directory_iterator end;
    if (ec) {
        error = "scan manifest source: " + src + ": " + ec.message();
        return false;
    }

    for (; it != end; it.increment(ec)) {
        if (ec) {
            error = "scan manifest source: " + src + ": " + ec.message();
            return false;
        }

        std::error_code rel_ec;
        fs::path rel = fs::relative(it->path(), src_path, rel_ec);
        if (rel_ec) {
            error = "relative manifest path: " + it->path().string()
                  + ": " + rel_ec.message();
            return false;
        }

        std::string rel_str = rel.generic_string();
        if (!rel_str.empty()) manifest << rel_str << '\n';
        if (!manifest) {
            error = "write manifest: " + manifest_path.string();
            return false;
        }
    }

    manifest.close();
    if (!manifest) {
        error = "close manifest: " + manifest_path.string();
        return false;
    }

    return true;
}

static bool directory_is_empty(const std::string &path, std::string &error) {
    DIR *dir = opendir(path.c_str());
    if (!dir) {
        error = errno_str(("opendir: " + path).c_str());
        return false;
    }

    bool empty = true;
    while (struct dirent *entry = readdir(dir)) {
        if (std::strcmp(entry->d_name, ".") == 0 ||
            std::strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        empty = false;
        break;
    }

    int close_rc = closedir(dir);
    if (close_rc != 0) {
        error = errno_str(("closedir: " + path).c_str());
        return false;
    }

    return empty;
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

static std::string escape_regex(const std::string &value) {
    std::string escaped;
    escaped.reserve(value.size() * 2);
    for (char ch : value) {
        switch (ch) {
        case '\\':
        case '.':
        case '^':
        case '$':
        case '|':
        case '(': case ')':
        case '[': case ']':
        case '{': case '}':
        case '*': case '+': case '?':
            escaped.push_back('\\');
            break;
        default:
            break;
        }
        escaped.push_back(ch);
    }
    return escaped;
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

// System-maintained directories — read-only access.  These are owned and
// managed by the OS; they do not contain user data.
static const char *const kSystemDirs[] = {
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

// True when 'path' is already readable through the base rules (a system
// directory or a bind mount), so no extra grant is needed for it.
static bool path_already_readable(const SandboxConfig &cfg,
                                 const std::string &path) {
    for (int i = 0; kSystemDirs[i]; i++) {
        if (is_under(path, kSystemDirs[i])) return true;
    }
    if (is_under(path, "/System/Volumes")) return true;  // explicitly denied
    for (const auto &bm : cfg.bind_mounts) {
        if (is_under(path, resolve_path(bm.src))) return true;
        if (is_under(path, resolve_path(bm.dst))) return true;
    }
    return false;
}

// Every executable a command can start needs its own directory to be
// stat()-able, and nothing more.
//
// CoreFoundation's main-bundle lookup walks the directories of the running
// executable's path and gives up as soon as one of them cannot be stat()ed:
// CFBundleGetMainBundle() then returns NULL, and libuv dereferences it -
// node dies with SIGSEGV the moment a program sets process.title, which npm
// and npx do on startup.  That is the whole failure mode: `npm --version`
// inside a sandbox that hides /Users exits 139 with no output.
//
// Commands are normally started by name through $PATH, so granting metadata
// for the directories on $PATH (plus the boxsh executable itself) covers the
// installs that live outside the system directories - nvm, Homebrew's
// per-user prefix, ~/Tools, ~/.cargo/bin and friends.  Metadata alone is
// enough for the lookup, so the contents of those directories stay
// unreadable: no file can be read or listed through this grant.
static void allow_executable_search_metadata(std::string &p,
                                              const SandboxConfig &cfg) {
    std::vector<std::string> dirs;

    char exe_buf[PATH_MAX];
    uint32_t exe_size = sizeof(exe_buf);
    if (_NSGetExecutablePath(exe_buf, &exe_size) == 0) {
        std::string exe = resolve_path(exe_buf);
        size_t slash = exe.rfind('/');
        if (slash != std::string::npos && slash > 0) dirs.push_back(exe.substr(0, slash));
    }

    const char *path_env = getenv("PATH");
    if (path_env) {
        std::string path = path_env;
        size_t start = 0;
        while (start <= path.size()) {
            size_t end = path.find(':', start);
            std::string dir = (end == std::string::npos)
                ? path.substr(start) : path.substr(start, end - start);
            if (!dir.empty() && dir[0] == '/') dirs.push_back(dir);
            if (end == std::string::npos) break;
            start = end + 1;
        }
    }

    std::set<std::string> emitted;
    for (const auto &dir : dirs) {
        std::string resolved = resolve_path(dir);
        if (path_already_readable(cfg, resolved)) continue;
        if (!emitted.insert(resolved).second) continue;
        allow_ancestor_metadata(p, resolved);
        p += "(allow file-read-metadata (literal \"" + resolved + "\"))\n";
    }
}

static std::string build_sbpl(const SandboxConfig &cfg,
                              const std::string &scratch_root) {
    std::string p;
    p += "(version 1)\n";
    p += "(deny default)\n";

    // Root directory — full read access.  macOS has symlinks at root level
    // (/var → /private/var, /tmp → /private/tmp, /etc → /private/etc) and
    // resolving them requires file-read-data, not just metadata.
    p += "(allow file-read* (literal \"/\"))\n";

    for (int i = 0; kSystemDirs[i]; i++) {
        p += "(allow file-read* (subpath \"";
        p += kSystemDirs[i];
        p += "\"))\n";
    }

    // On macOS, /System/Volumes contains APFS volume mount points (Data,
    // Preboot, VM, etc.).  The data volume (/System/Volumes/Data) is already
    // reachable through root-level firmlinks (/Users, /usr/local, /opt, …),
    // so allowing recursive traversal through the mount point causes commands
    // like `find /` to walk the entire data volume twice — roughly doubling
    // the number of inodes visited and causing frequent timeouts.
    //
    // Explicit deny overrides the (allow file-read* (subpath "/System")) rule
    // above.  SBPL evaluates deny rules after allow rules for the same
    // operation, so this correctly blocks /System/Volumes and everything
    // beneath it while keeping /System/Library, /System/Applications, etc.
    // accessible.
    p += "(deny file-read* (subpath \"/System/Volumes\"))\n";

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
    p += "  (global-name \"com.apple.communicationtrustd\")\n";
    p += "  (global-name \"com.apple.trustd\")\n";
    p += "  (global-name \"com.apple.trustd.agent\")\n";
    p += "  (global-name \"com.apple.trustdFileHelper\")\n";
    // Chromium-family browsers: every helper process looks up the rendezvous
    // port its browser process published (see the mach-register grant below).
    p += "  (global-name-prefix \"org.chromium\")\n";
    p += "  (global-name-prefix \"com.google.Chrome\")\n";
    p += ")\n";

    // Chromium-family browsers publish a per-process Mach rendezvous port so
    // their helper processes (GPU, renderer, network) can reach them.  Without
    // this grant the browser aborts during startup:
    //   FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed:
    //   kr == KERN_SUCCESS. bootstrap_check_in
    //   org.chromium.Chromium.MachPortRendezvousServer.1234: Permission denied
    // Service names are bundle-scoped, so registering under one of these
    // prefixes cannot shadow a system service: every com.apple.* name stays
    // unregisterable and unlookupable.
    p += "(allow mach-register\n";
    p += "  (global-name-prefix \"org.chromium\")\n";
    p += "  (global-name-prefix \"com.google.Chrome\")\n";
    p += ")\n";

    // Power-management queries used by fibjs go through IOKit and open the
    // RootDomain user client after the bootstrap lookup succeeds.
    p += "(allow iokit-open\n";
    p += "  (iokit-user-client-class \"RootDomainUserClient\")\n";
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
    // PTY master: posix_openpt() opens /dev/ptmx; grantpt()/unlockpt()
    // issue ioctl on the master fd and may touch the slave device.
    p += "(allow file-ioctl (literal \"/dev/ptmx\"))\n";
    // The slave pseudo-terminal devices live under /dev/ttys*.
    // grantpt() may need to chown/chmod these when the sandbox is active.
    p += "(allow file-read* file-write* file-ioctl (regex \"^/dev/ttys[0-9a-f]+$\"))\n";

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

    // Scratch directory: the session's writable temp/cache area.  It lives
    // outside the workspace (and outside $HOME) so temp files and tool caches
    // never end up in the caller's files or directories.
    if (!scratch_root.empty()) {
        std::string rscratch = resolve_path(scratch_root);
        allow_ancestor_metadata(p, rscratch);
        p += "(allow file-read* (subpath \"" + rscratch + "\"))\n";
        p += "(allow file-write* (subpath \"" + rscratch + "\"))\n";
    }

    // Executables started by name through $PATH must be stat()-able, or
    // CoreFoundation-based programs (node/npm/npx) crash on startup.
    allow_executable_search_metadata(p, cfg);

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
                p += "(deny file-write* (literal \""
                   + home + "/" + dangerous_files[i] + "\"))\n";
            }
            for (int i = 0; dangerous_dirs[i]; i++) {
                p += "(deny file-write* (subpath \""
                   + home + "/" + dangerous_dirs[i] + "\"))\n";
            }

            // Block Git hooks anywhere under $HOME, including newly created
            // repositories and hook files inside nested worktrees.
            p += "(deny file-write* (regex \"^"
               + escape_regex(home)
               + "/(.*/)?\\.git/hooks(/.*)?$\"))\n";
        }
    }

    // Network: allow by default; deny everything when --new-net-ns is set.
    if (!cfg.new_net_ns) {
        p += "(allow network*)\n";
    }

    return p;
}

// ---------------------------------------------------------------------------
// Scratch directory
// ---------------------------------------------------------------------------

// Directory boxsh created itself and must remove again on exit (as opposed to
// one that lives inside a caller-managed session or workspace directory).
// Deliberately never destroyed: the atexit handler may run after static
// destructors.
static std::string &owned_scratch_root() {
    static std::string *path = new std::string();
    return *path;
}

static pid_t &owned_scratch_owner_pid() {
    static pid_t pid = getpid();
    return pid;
}

// Remove the scratch directory boxsh created when the owning process exits.
// Workers are forked after sandbox_apply() and leave through _exit(), so only
// the process that created the directory runs this.  It runs while the process
// is still confined (the profile grants writes inside the scratch), which is
// enough to remove the directory; sweep_stale_scratch_dirs() covers the exits
// that never get here - a crash or SIGKILL.
static void register_scratch_cleanup(const std::string &path) {
    static bool registered = false;
    owned_scratch_root() = path;
    owned_scratch_owner_pid();  // capture the owner before any fork
    if (registered) return;
    registered = true;
    std::atexit([]() {
        if (getpid() != owned_scratch_owner_pid()) return;
        std::error_code ec;
        fs::remove_all(owned_scratch_root(), ec);  // best effort
    });
}

// Scratch directories are named boxsh-scratch-<pid>-<random>.  Remove those
// whose owner is gone; this runs before the sandbox is applied, which is the
// only moment a boxsh process may write to the temp dir's parent.  It also
// covers crashes and SIGKILL, where the atexit handler never runs.
static void sweep_stale_scratch_dirs(const std::string &base) {
    DIR *dir = opendir(base.c_str());
    if (!dir) return;

    static const char prefix[] = "boxsh-scratch-";
    while (struct dirent *ent = readdir(dir)) {
        if (std::strncmp(ent->d_name, prefix, sizeof(prefix) - 1) != 0) continue;

        const char *pid_text = ent->d_name + sizeof(prefix) - 1;
        char *end = nullptr;
        long owner = std::strtol(pid_text, &end, 10);
        if (end == pid_text || *end != '-' || owner <= 1) continue;

        // A live process keeps its scratch; ESRCH is the only answer that
        // proves the owner is gone (pid reuse just leaves it for later).
        if (kill((pid_t)owner, 0) == 0 || errno != ESRCH) continue;

        std::string path = base + "/" + ent->d_name;
        struct stat st;
        if (lstat(path.c_str(), &st) != 0) continue;
        if (!S_ISDIR(st.st_mode) || st.st_uid != getuid()) continue;

        std::error_code ec;
        fs::remove_all(path, ec);  // best effort
    }
    closedir(dir);
}

// Create one owned scratch directory under 'base' (boxsh-scratch-<pid>-XXXXXX).
// Returns an empty string when the directory cannot be created there.
static std::string make_scratch_dir(const std::string &base) {
    std::string tmpl = base + "/boxsh-scratch-" + std::to_string(getpid()) + "-XXXXXX";
    std::vector<char> buf(tmpl.begin(), tmpl.end());
    buf.push_back('\0');
    if (!mkdtemp(buf.data())) {
        std::fprintf(stderr, "boxsh: cannot create scratch directory in %s: %s\n",
                     base.c_str(), std::strerror(errno));
        return std::string();
    }
    return std::string(buf.data());
}

// Pick the directory that will hold this session's writable scratch space
// (temp files).  The preferred location sits next to the COW workspace -
// <dst parent>/.boxsh/<dst name>.scratch, the same convention as the COW
// manifest - so it follows the workspace's lifetime and never shows up inside
// the workspace itself.  Without a COW workspace there is nothing to anchor to,
// and boxsh creates a private directory in the system temp dir.
//
// Returns an empty string when no directory could be created; the sandbox
// then simply has no writable scratch, as it had before.
static std::string choose_scratch_root(const SandboxConfig &cfg) {
    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode != BindMount::Mode::COW) continue;
        fs::path dst(bm.dst);
        std::string parent = dst.parent_path().string();
        std::string name = dst.filename().string();
        if (parent.empty() || name.empty()) break;

        std::string root = (fs::path(parent) / ".boxsh" /
                            (name + ".scratch")).string();
        SandboxResult sr = sandbox_scratch_prepare(root);
        if (sr.ok) return root;
        std::fprintf(stderr,
            "boxsh: cannot prepare scratch directory %s: %s; "
            "falling back to the system temp dir\n",
            root.c_str(), sr.error.c_str());
        break;
    }

    std::string base;
    const char *tmpdir = getenv("TMPDIR");
    if (tmpdir && tmpdir[0] != '\0') base = tmpdir;
    else base = "/tmp";
    while (base.size() > 1 && base.back() == '/') base.pop_back();

    sweep_stale_scratch_dirs(base);

    // A caller TMPDIR that does not exist must not leave the sandbox without a
    // scratch: fall back to /tmp, the one directory that is always there.
    std::string root = make_scratch_dir(base);
    if (root.empty() && base != "/tmp") {
        std::fprintf(stderr,
            "boxsh: cannot create scratch directory in %s; trying /tmp\n",
            base.c_str());
        root = make_scratch_dir("/tmp");
    }
    if (root.empty()) return std::string();

    SandboxResult sr = sandbox_scratch_prepare(root);
    if (!sr.ok) {
        std::fprintf(stderr, "boxsh: cannot prepare scratch directory %s: %s\n",
                     root.c_str(), sr.error.c_str());
        std::error_code ec;
        fs::remove_all(root, ec);
        return std::string();
    }
    register_scratch_cleanup(root);
    return root;
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

    // ── 0. Capture CWD before any filesystem mutations ───────────────────
    // Must happen before the COW step: rmdir + clonefile may delete and
    // recreate the overlay directory that IS the process CWD, making
    // getcwd() return ENOENT afterwards.
    char *cwd_buf = getcwd(nullptr, 0);
    std::string saved_cwd = cwd_buf ? cwd_buf : "";
    free(cwd_buf);

    // ── 1. COW: clonefile(src, dst) ──────────────────────────────────────
    // clonefile(2) creates an instant APFS COW snapshot of src at dst for the
    // initial workspace materialization.  If dst already contains data, treat
    // it as an existing workspace and reuse it across sessions.
    for (const auto &bm : cfg.bind_mounts) {
        if (bm.mode != BindMount::Mode::COW) continue;

        bool should_clone = true;
        struct stat st;
        if (stat(bm.dst.c_str(), &st) == 0) {
            if (!S_ISDIR(st.st_mode)) {
                res.error = "COW dst exists and is not a directory: " + bm.dst;
                return res;
            }

            std::string dir_error;
            bool is_empty = directory_is_empty(bm.dst, dir_error);
            if (!dir_error.empty()) {
                res.error = dir_error;
                return res;
            }

            if (is_empty) {
                if (rmdir(bm.dst.c_str()) != 0) {
                    res.error = errno_str(("rmdir pre-existing dst: " + bm.dst).c_str());
                    return res;
                }
            } else {
                std::string manifest_path = cow_manifest_path(bm.dst);
                if (!path_exists(manifest_path) &&
                    !write_cow_manifest(bm.src, bm.dst, res.error)) {
                    return res;
                }
                should_clone = false;
            }
        }

        if (!should_clone) continue;

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

        if (!write_cow_manifest(bm.src, bm.dst, res.error)) return res;
    }

    // ── 2. Scratch directory ──────────────────────────────────────────────
    // Prepared before the profile is built (so it can be granted, and so the
    // grant can use its canonical path) and before sandbox_init() (creating
    // a directory needs write access to its parent, which the profile does
    // not grant).  Only the environment is exported later, after the
    // process is confined.
    std::string scratch_root = choose_scratch_root(cfg);

    // ── 3. Apply Seatbelt profile ─────────────────────────────────────────
    // saved_cwd was captured before the COW step (step 0).

    // sandbox_init() with flags=0 and a custom SBPL string is an undocumented
    // private API.  On failure we print a warning and continue without
    // sandboxing (documented fallback; see macos-sandbox-design.md §7).
    std::string profile = build_sbpl(cfg, scratch_root);
    // BOXSH_SBPL_DUMP=<path> writes the generated profile out, which makes
    // "why is this command denied?" answerable without a rebuild.
    if (const char *dump = getenv("BOXSH_SBPL_DUMP")) {
        std::ofstream out(dump, std::ios::out | std::ios::trunc);
        out << profile;
    }
    char *sb_err = nullptr;
    int rc = sandbox_init(profile.c_str(), 0, &sb_err);
    if (rc != 0) {
        res.error = std::string("sandbox_init failed: ") +
                   (sb_err ? sb_err : "unknown error");
        if (sb_err) sandbox_free_error(sb_err);
        return res;
    }

    // ── 4. Point temp files and tool caches at the scratch directory ──────
    // Without it nothing inside the sandbox can write a temporary file, and
    // tools that keep caches under $HOME (npm, pip, …) fail outright.
    // A scratch that cannot be prepared is not fatal: the sandbox just
    // behaves as it did before, with no writable temp directory.
    if (!scratch_root.empty()) {
        SandboxResult sr = sandbox_scratch_export_env(scratch_root, cfg);
        if (!sr.ok) {
            std::fprintf(stderr,
                "boxsh: sandbox scratch directory unavailable (%s); "
                "commands that need a writable temp directory will fail\n",
                sr.error.c_str());
        }
    }

    // ── 5. Redirect CWD ──────────────────────────────────────────────────
    // Use the saved_cwd captured before sandbox_init.  If the old CWD was
    // within a COW source, redirect into the clone (dst).  Otherwise,
    // restore the original CWD — chdir() is used directly instead of
    // getcwd() because the sandbox may block getcwd()'s directory-tree
    // walk even for whitelisted paths.  Fall back to "/" only if the
    // restore fails (e.g. CWD is outside whitelisted paths with no bind).
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

        if (!redirected && !saved_cwd.empty()) {
            // Try to restore the pre-sandbox CWD.  chdir() alone sets the
            // kernel's cwd, but getcwd() may still fail inside the sandbox
            // for paths outside the whitelist (e.g. /Users).  Use getcwd()
            // as a gate: if it succeeds the path is fully accessible to
            // child processes (dash, python, etc.); if not, fall back to /.
            if (chdir(saved_cwd.c_str()) == 0) {
                char *check = getcwd(nullptr, 0);
                if (!check) {
                    chdir("/");
                } else {
                    free(check);
                }
            } else {
                chdir("/");
            }
        }
    }

    res.ok = true;
    return res;
}

} // namespace boxsh
