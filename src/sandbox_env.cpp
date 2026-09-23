// sandbox_env.cpp — the sandbox scratch space and the environment pointing at it.
//
// A sandbox with no writable directory is unusable for anything that needs a
// temporary file — Chromium has to create its profile directory next to
// os.tmpdir() before it will start at all.  Linux gives every sandbox a fresh
// writable tmpfs for /tmp; the macOS backend has no writable directory at all
// unless one is bound, and --try binds $HOME read-only.
//
// Both backends therefore create a *scratch* directory and call
// sandbox_scratch_setup() on it:
//
//   <root>/    scratch root, exported as TMPDIR
//   <root>/.cache/  a conventional place for tool caches (see below)
//
// The scratch is private to the session and disposable: the sandbox owns it,
// never the host home directory, so writes cannot leak out of the sandbox.
//
// TMPDIR is the only variable boxsh sets.  Caches that tools keep under $HOME
// are left alone: a sandboxed process cannot write to them, and pointing them
// at the scratch is the caller's decision (npm_config_cache=$TMPDIR/.cache/npm,
// XDG_CACHE_HOME=$TMPDIR/.cache, CARGO_HOME=$TMPDIR/cargo, …), which keeps the
// sandbox free of per-tool policy and leaves a caller's own settings intact.

#include "sandbox.h"

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include <pwd.h>
#include <unistd.h>
#include <sys/stat.h>

namespace boxsh {

namespace {

std::string errno_str(const char *context) {
    return std::string(context) + ": " + std::strerror(errno);
}

// True if path equals prefix or starts with prefix + '/'.
bool path_is_under(const std::string &path, const std::string &prefix) {
    if (prefix.empty()) return false;
    return path == prefix ||
           (path.size() > prefix.size() &&
            path[prefix.size()] == '/' &&
            path.compare(0, prefix.size(), prefix) == 0);
}

std::string strip_trailing_slashes(const std::string &path) {
    std::string result = path;
    while (result.size() > 1 && result.back() == '/') result.pop_back();
    return result;
}

// Canonicalize a path that may not exist yet: resolve the longest existing
// ancestor and re-append the missing components.  Needed because a comparison
// such as "/tmp/proj/cache" against a bind of "/tmp/proj" must not fail just
// because macOS maps /tmp to /private/tmp.
std::string canonicalize_path(const std::string &path) {
    std::string current = strip_trailing_slashes(path);
    std::string tail;

    while (true) {
        char buf[PATH_MAX];
        if (const char *resolved = realpath(current.c_str(), buf))
            return std::string(resolved) + tail;
        if (current.empty() || current == "/") return path;
        size_t slash = current.rfind('/');
        if (slash == std::string::npos) return path;  // relative path
        tail = current.substr(slash) + tail;
        current = (slash == 0) ? "/" : current.substr(0, slash);
    }
}

std::string user_home_dir() {
    const char *home_env = getenv("HOME");
    if (home_env && home_env[0] != '\0') return home_env;
    struct passwd *pw = getpwuid(getuid());
    return (pw && pw->pw_dir) ? std::string(pw->pw_dir) : std::string();
}

// Expand a leading "~" against the caller's home directory, the way tools
// read cache locations.  Values without a leading "~" are returned as-is.
std::string expand_home(const std::string &value, const std::string &home) {
    if (home.empty() || value.empty() || value[0] != '~') return value;
    if (value.size() == 1) return home;
    if (value[1] == '/') return home + value.substr(1);
    return value;  // ~user — not expanded
}

bool mkdir_one(const std::string &path, mode_t mode, std::string &error) {
    if (mkdir(path.c_str(), mode) == 0) return true;
    if (errno == EEXIST) {
        struct stat st;
        if (stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) return true;
    }
    error = errno_str(("mkdir: " + path).c_str());
    return false;
}

bool mkdir_p(const std::string &path, mode_t mode, std::string &error) {
    std::string full = strip_trailing_slashes(path);
    if (full.empty() || full[0] != '/') {
        error = "mkdir -p: not an absolute path: " + path;
        return false;
    }
    if (mkdir_one(full, mode, error)) return true;

    // Walk down from the top, creating each missing component.
    std::string current;
    size_t pos = 1;
    while (pos <= full.size()) {
        size_t slash = full.find('/', pos);
        std::string part = (slash == std::string::npos)
            ? full.substr(pos) : full.substr(pos, slash - pos);
        if (!part.empty()) {
            current += "/" + part;
            if (!mkdir_one(current, mode, error)) return false;
        }
        if (slash == std::string::npos) break;
        pos = slash + 1;
    }
    return true;
}

// Export 'name' = 'value' unless the caller already pointed it at a location
// the sandbox can write to - an explicit setting inside a writable bind is
// theirs to keep.
void redirect_env(const char *name,
                  const std::string &value,
                  const SandboxConfig &cfg,
                  const std::string &home) {
    const char *current = getenv(name);
    if (current && current[0] != '\0') {
        std::string path = expand_home(current, home);
        if (!path.empty() && path[0] == '/' &&
            sandbox_path_writable(cfg, path)) {
            return;
        }
    }
    setenv(name, value.c_str(), 1);
}

} // namespace

bool sandbox_path_writable(const SandboxConfig &cfg, const std::string &path) {
    if (path.empty()) return false;
    std::string target = canonicalize_path(path);

    for (const auto &bm : cfg.bind_mounts) {
        // RO grants read access only.  RW binds are path grants, and COW
        // writes land in the destination directory, so both make their
        // destination writable.
        if (bm.mode == BindMount::Mode::RO) continue;
        if (path_is_under(target, canonicalize_path(bm.dst))) return true;
    }
    return false;
}

SandboxResult sandbox_scratch_prepare(const std::string &root) {
    SandboxResult res;

    if (root.empty()) {
        res.error = "sandbox scratch: no directory given";
        return res;
    }

    // Creates the whole layout.  Callers on macOS run this *before* the
    // process is confined: creating a directory requires write access to its
    // parent, which the profile grants only for the scratch subtree itself.
    std::string error;
    std::string scratch = canonicalize_path(root);
    if (!mkdir_p(scratch, 0700, error)) {
        res.error = error;
        return res;
    }
    chmod(scratch.c_str(), 0700);  // mkdir_p leaves pre-existing dirs alone

    const std::string cache = scratch + "/.cache";
    const std::string npm_cache = cache + "/npm";
    if (!mkdir_p(cache, 0700, error)) {
        res.error = error;
        return res;
    }
    if (!mkdir_p(npm_cache, 0700, error)) {
        res.error = error;
        return res;
    }

    res.ok = true;
    return res;
}

SandboxResult sandbox_scratch_export_env(const std::string &root,
                                         const SandboxConfig &cfg) {
    SandboxResult res;

    if (root.empty()) {
        res.error = "sandbox scratch: no directory given";
        return res;
    }

    const std::string scratch = canonicalize_path(root);
    struct stat st;
    if (stat(scratch.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) {
        res.error = "sandbox scratch directory is missing: " + scratch;
        return res;
    }

    const std::string home = user_home_dir();

    // Temporary files: the scratch directory is the one location every
    // sandbox is guaranteed to write to (on macOS there is no writable /tmp
    // at all).  A $TMPDIR that the caller exposed as writable is kept.
    redirect_env("TMPDIR", scratch, cfg, home);

    res.ok = true;
    return res;
}

SandboxResult sandbox_scratch_setup(const std::string &root,
                                    const SandboxConfig &cfg) {
    SandboxResult res = sandbox_scratch_prepare(root);
    if (!res.ok) return res;
    return sandbox_scratch_export_env(root, cfg);
}

} // namespace boxsh
