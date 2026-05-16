#include "rpc.h"
#include "worker_pool.h"
#include "sandbox.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <climits>
#include <filesystem>
#include <string>
#include <vector>

#include <unistd.h>
#include <getopt.h>
#include <signal.h>
#include <cerrno>
#include <sys/stat.h>
#include <sys/wait.h>
#include <pwd.h>

// Bring in dash's main() under a renamed symbol so we can call it directly
// when running in normal (non-RPC) mode.
extern "C" int dash_main(int argc, char **argv);

namespace boxsh {
namespace {

void print_version() {
    std::fprintf(stderr, "boxsh version %s\n", BOXSH_VERSION);
}

void print_usage(const char *prog) {
    print_version();
    std::fprintf(stderr,
        "\nUsage: %s [OPTIONS] [-- shell-args...]\n"
        "\n"
        "Modes:\n"
        "  (default)      Run as an ordinary POSIX shell (delegates to dash).\n"
        "  --interactive  Force interactive shell mode even when stdin is not a tty.\n"
        "  --rpc          Read JSON-line requests from stdin, write responses to stdout.\n"
        "\n"
        "RPC options:\n"
        "  --workers N    Number of pre-forked worker processes (default: 4).\n"
        "  --shell PATH   Shell binary to use for executing commands (default: /bin/sh).\n"
        "\n"
        "Sandbox options (applied to every worker at fork time):\n"
        "  --sandbox      Enable the sandbox.  Builds an isolated root from a fresh\n"
        "                 tmpfs with read-only system directories (/usr, /proc, /dev,\n"
        "                 selected /etc files) automatically mounted.  Everything else\n"
        "                 is hidden unless explicitly exposed with --bind.\n"
        "  --new-net-ns   Create a new network namespace (disables outbound network).\n"
        "  --bind ro:PATH       Expose PATH read-only inside the sandbox.\n"
        "  --bind wr:PATH       Expose PATH read-write inside the sandbox.\n"
        "  --bind cow:SRC:DST   Mount an overlayfs at DST with SRC as the read-only\n"
        "                       base.  Writes go to DST (the upper layer); SRC is\n"
        "                       never modified.  DST must exist before launch.\n"
        "\n"
        "Quick-try mode:\n"
        "  --try          Launch a sandboxed shell on the current directory.\n"
        "                 Mounts the current directory as a copy-on-write overlay so\n"
        "                 all writes are captured in a temporary directory.  When the\n"
        "                 shell exits the temp dir path is printed to stderr — inspect\n"
        "                 it to see what changed, then discard when done.\n"
        "\n",
        prog);
}

struct Cli {
    bool rpc_mode      = false;
    bool force_interactive = false;
    bool try_mode      = false;  // --try: ephemeral COW shell on CWD
    int  num_workers   = 4;
    std::string shell_path = "/bin/sh";

    SandboxConfig sandbox;
};

static bool normalize_bind_path(std::string &path) {
    if (path.empty()) return false;

    std::filesystem::path fs_path(path);
    if (fs_path.is_relative()) {
        char *cwd_buf = getcwd(nullptr, 0);
        if (!cwd_buf) return false;
        fs_path = std::filesystem::path(cwd_buf) / fs_path;
        free(cwd_buf);
    }

    path = fs_path.lexically_normal().string();
    while (path.size() > 1 && path.back() == '/') {
        path.pop_back();
    }
    return !path.empty();
}

// Parse --bind ro:PATH | wr:PATH | cow:SRC:DST
static bool parse_bind(const char *arg, BindMount &bm) {
    std::string s(arg);
    size_t colon = s.find(':');
    if (colon == std::string::npos) return false;

    std::string mode_str = s.substr(0, colon);
    std::string rest     = s.substr(colon + 1);

    if (mode_str == "ro") {
        bm.mode = BindMount::Mode::RO;
        bm.src  = rest;
        bm.dst  = rest;
        return normalize_bind_path(bm.src) && normalize_bind_path(bm.dst);
    } else if (mode_str == "wr") {
        bm.mode = BindMount::Mode::RW;
        bm.src  = rest;
        bm.dst  = rest;
        return normalize_bind_path(bm.src) && normalize_bind_path(bm.dst);
    } else if (mode_str == "cow") {
        size_t p2 = rest.find(':');
        if (p2 == std::string::npos) return false;
        bm.mode = BindMount::Mode::COW;
        bm.src  = rest.substr(0, p2);
        bm.dst  = rest.substr(p2 + 1);
        return normalize_bind_path(bm.src) && normalize_bind_path(bm.dst);
    }
    return false;
}

static Cli parse_cli(int argc, char **argv, int &remaining_argc,
                     char **&remaining_argv) {
    Cli cli;

    static const struct option opts[] = {
        {"interactive", no_argument,       nullptr, 'i'},
        {"rpc",         no_argument,       nullptr, 'R'},
        {"workers",     required_argument, nullptr, 'W'},
        {"shell",       required_argument, nullptr, 'S'},
        {"sandbox",     no_argument,       nullptr, 'X'},
        {"new-net-ns",  no_argument,       nullptr, 'N'},
        {"bind",        required_argument, nullptr, 'b'},
        {"try",         no_argument,       nullptr, 'y'},
        {"version",     no_argument,       nullptr, 'v'},
        {"help",        no_argument,       nullptr, 'h'},
        {nullptr, 0, nullptr, 0}
    };

    // Suppress getopt's own error messages; we handle unknown options ourselves.
    opterr = 0;

    int c;
    bool stop_parsing = false;
    while (!stop_parsing &&
           (c = getopt_long(argc, argv, "+h", opts, nullptr)) != -1) {
        switch (c) {
        case 'i': cli.force_interactive = true; break;
        case 'R': cli.rpc_mode = true; break;
        case 'W': cli.num_workers = std::atoi(optarg); break;
        case 'S': cli.shell_path  = optarg; break;
        case 'X': cli.sandbox.enabled = true; break;
        case 'N': cli.sandbox.new_net_ns  = true; break;
        case 'b': {
            BindMount bm;
            if (!parse_bind(optarg, bm)) {
                std::fprintf(stderr,
                    "boxsh: invalid --bind argument: %s\n"
                    "  expected: ro:PATH | wr:PATH | cow:SRC:DST\n",
                    optarg);
                std::exit(1);
            }
            cli.sandbox.bind_mounts.push_back(std::move(bm));
            break;
        }
        case 'y': cli.try_mode = true; break;
        case 'v':
            print_version();
            std::exit(0);
        case 'h':
            print_usage(argv[0]);
            std::exit(0);
        default:
            // Unknown option: belongs to dash, not boxsh.
            // Back up optind so this option stays in the remaining args.
            optind--;
            stop_parsing = true;
            break;
        }
    }

    remaining_argc = argc - optind;
    remaining_argv = argv + optind;
    return cli;
}

} // namespace
} // namespace boxsh

int main(int argc, char **argv) {
    int shell_argc = 0;
    char **shell_argv = nullptr;

    boxsh::Cli cli = boxsh::parse_cli(argc, argv, shell_argc, shell_argv);

    // --try: auto-configure sandbox + COW bind on CWD, then fall through
    // to the normal shell or RPC path unchanged.
    std::string try_cwd;
    if (cli.try_mode) {
        char *cwd_buf = getcwd(nullptr, 0);
        if (!cwd_buf) {
            std::fprintf(stderr, "boxsh: --try: cannot get cwd: %s\n",
                         strerror(errno));
            return 1;
        }
        try_cwd = cwd_buf;
        free(cwd_buf);

        // Create the temp directory on the same volume as CWD when possible.
        // clonefile(2) requires src and dst to reside on the same APFS
        // volume; using /tmp would fail when CWD is on another volume.
        std::string try_tmpdir;
        {
            // Try CWD's parent directory first (same volume guaranteed).
            std::string cwd_parent = try_cwd;
            size_t slash = cwd_parent.rfind('/');
            if (slash != std::string::npos && slash > 0)
                cwd_parent.resize(slash);
            else
                cwd_parent = "/tmp";

            std::string tmpl_str = cwd_parent + "/.boxsh-try-XXXXXX";
            std::vector<char> tmpl_buf(tmpl_str.begin(), tmpl_str.end());
            tmpl_buf.push_back('\0');

            if (!mkdtemp(tmpl_buf.data())) {
                // Fall back to /tmp (may fail later if cross-volume).
                char fallback[] = "/tmp/boxsh-try-XXXXXX";
                if (!mkdtemp(fallback)) {
                    std::fprintf(stderr, "boxsh: --try: mkdtemp failed: %s\n",
                                 strerror(errno));
                    return 1;
                }
                tmpl_str = fallback;
            } else {
                tmpl_str.assign(tmpl_buf.data());
            }

            // Canonicalize /tmp -> /private/tmp (and similar symlinks) so
            // the printed path matches what getcwd() reports inside the
            // sandbox.
            char real_path[PATH_MAX];
            const char *rp = realpath(tmpl_str.c_str(), real_path);
            try_tmpdir = rp ? std::string(rp) : tmpl_str;
        }
        std::string dst = try_tmpdir + "/work";
        if (mkdir(dst.c_str(), 0700) != 0) {
            std::fprintf(stderr, "boxsh: --try: failed to create work dir: %s\n",
                         strerror(errno));
            rmdir(try_tmpdir.c_str());
            return 1;
        }

        std::fprintf(stderr, "boxsh: changes will be saved in %s\n",
                     dst.c_str());

        cli.sandbox.enabled = true;

        // Determine the user's home directory.  Prefer $HOME; fall back to
        // the passwd entry so we work correctly even when $HOME is unset.
        std::string home_dir;
        const char *home_env = getenv("HOME");
        if (home_env && home_env[0] != '\0') {
            home_dir = home_env;
        } else {
            struct passwd *pw = getpwuid(getuid());
            if (pw && pw->pw_dir) home_dir = pw->pw_dir;
        }

        // $HOME: bind-mount read-only so it is accessible inside the sandbox
        // without exposing writes to the host.
        if (!home_dir.empty()) {
            boxsh::BindMount hbm;
            hbm.mode = boxsh::BindMount::Mode::RO;
            hbm.src  = home_dir;
            hbm.dst  = home_dir;
            cli.sandbox.bind_mounts.push_back(std::move(hbm));
        }

        // COW overlay on CWD: process works in dst (the overlay merged view).
        {
            boxsh::BindMount bm;
            bm.mode = boxsh::BindMount::Mode::COW;
            bm.src  = try_cwd;
            bm.dst  = dst;
            cli.sandbox.bind_mounts.push_back(std::move(bm));
        }
    }

    if (!cli.rpc_mode) {
        // Capture user info before entering sandbox (passwd/hostname may
        // become unavailable inside the namespace).
        std::string prompt_user = "user";
        char prompt_host[256] = "localhost";
        {
            struct passwd *pw = getpwuid(getuid());
            if (pw && pw->pw_name) prompt_user = pw->pw_name;
            gethostname(prompt_host, sizeof(prompt_host));
            prompt_host[sizeof(prompt_host) - 1] = '\0';
        }

        // Normal shell mode: apply sandbox (if requested) then run dash.
        if (cli.sandbox.enabled) {
            boxsh::SandboxResult sr = boxsh::sandbox_apply(cli.sandbox);
            if (!sr.ok) {
                std::fprintf(stderr, "boxsh: sandbox_apply failed: %s\n",
                             sr.error.c_str());
                return 1;
            }
        }

        bool stdin_is_tty = isatty(STDIN_FILENO);
        // In sandbox mode with non-tty stdin, forcing dash -i can fail with
        // tty process-group errors. Keep forced-interactive semantics for the
        // normal shell path, but avoid -i in this sandboxed pipe case.
        bool force_dash_interactive = cli.force_interactive &&
                          (stdin_is_tty || !cli.sandbox.enabled);
        bool interactive = force_dash_interactive ||
               (shell_argc == 0 && stdin_is_tty);

        // Build a dash-friendly PS1 that mimics the user's bash prompt.
        // dash does not support bash PS1 escapes (\u, \h, \w), so we
        // bake in user/host and use command substitution for ~ in $PWD.
        // ANSI escapes are wrapped in \001..\001 for libedit (EL_PROMPT_ESC).
        if (interactive) {
            const char *esc_on  = "\001\033[";
            const char *esc_off = "\001";
            const char *green_bold = "01;32m";
            const char *blue_bold  = "01;34m";
            const char *reset      = "00m";

            // Replace $HOME prefix with ~ using inline case statement
            const char *path_expr =
                "$(case \"$PWD\" in "
                "\"$HOME\") echo '~';; "
                "\"$HOME\"/*) echo \"~${PWD#\"$HOME\"}\";; "
                "*) echo \"$PWD\";; esac)";

            std::string ps1;
            if (cli.try_mode)
                ps1 += "[boxsh:try] ";
            else
                ps1 += "[boxsh] ";
            ps1 += esc_on; ps1 += green_bold; ps1 += esc_off;
            ps1 += prompt_user; ps1 += "@"; ps1 += prompt_host;
            ps1 += esc_on; ps1 += reset; ps1 += esc_off;
            ps1 += ":";
            ps1 += esc_on; ps1 += blue_bold; ps1 += esc_off;
            ps1 += path_expr;
            ps1 += esc_on; ps1 += reset; ps1 += esc_off;
            ps1 += "$ ";
            setenv("PS1", ps1.c_str(), 1);
        }

        // Reconstruct argv for dash: argv[0] is the shell binary name.
        std::vector<char *> dash_args;
        dash_args.push_back(argv[0]);
        static char interactive_flag[] = "-i";
        if (force_dash_interactive)
            dash_args.push_back(interactive_flag);
        for (int i = 0; i < shell_argc; i++)
            dash_args.push_back(shell_argv[i]);
        dash_args.push_back(nullptr);

        // Without sandbox, run dash directly in the current process.
        if (!cli.sandbox.enabled) {
            return dash_main((int)dash_args.size() - 1, dash_args.data());
        }

        // Interactive sandbox shells need to keep the existing terminal
        // session/foreground ownership. Trying to hand off the TTY to a
        // separate helper process is not reliable across macOS terminals.
        if (interactive) {
            return dash_main((int)dash_args.size() - 1, dash_args.data());
        }

        // With sandbox enabled, fork a child and run dash in a new process
        // group.  When the shell exits the parent kills the entire process
        // group, cleaning up any backgrounded jobs that would otherwise
        // become orphans.
        signal(SIGTTOU, SIG_IGN);
        pid_t child = fork();
        if (child < 0) {
            std::fprintf(stderr, "boxsh: fork: %s\n", strerror(errno));
            return 1;
        }
        if (child == 0) {
            // Child: create its own process group and run the shell.
            setpgid(0, 0);
            signal(SIGTTOU, SIG_DFL);
            _exit(dash_main((int)dash_args.size() - 1, dash_args.data()));
        }

        // Parent: hand terminal to child, wait, then clean up.
        setpgid(child, child);  // race-free: both sides call setpgid

        // Ignore job-control signals while the shell owns the terminal.
        signal(SIGINT,  SIG_IGN);
        signal(SIGQUIT, SIG_IGN);
        signal(SIGTSTP, SIG_IGN);
        signal(SIGTTIN, SIG_IGN);

        int status = 0;
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}

        // Kill any orphaned processes in the child's process group.
        kill(-child, SIGKILL);

        // Reclaim the terminal before exiting.
        if (interactive)
            tcsetpgrp(STDIN_FILENO, getpgrp());

        if (WIFEXITED(status))    return WEXITSTATUS(status);
        if (WIFSIGNALED(status))  return 128 + WTERMSIG(status);
        return 1;
    }

    // -------------------------------------------------------------------
    // RPC mode
    // -------------------------------------------------------------------
    if (cli.num_workers < 1) cli.num_workers = 1;

    boxsh::WorkerPoolConfig pool_cfg;
    pool_cfg.num_workers    = (size_t)cli.num_workers;
    pool_cfg.shell_path     = cli.shell_path;
    pool_cfg.global_sandbox = cli.sandbox;

    // Ignore SIGPIPE so writes to a crashed worker's socket return EPIPE
    // instead of killing the coordinator process.
    signal(SIGPIPE, SIG_IGN);

    // Apply the sandbox once in the coordinator process.  All subsequently
    // forked workers inherit the restricted namespace, and tool threads share
    // it automatically (threads share the same mount/pid/user namespace).
    if (cli.sandbox.enabled) {
        boxsh::SandboxResult sr = boxsh::sandbox_apply(cli.sandbox);
        if (!sr.ok) {
            std::fprintf(stderr, "boxsh: sandbox_apply failed: %s\n",
                         sr.error.c_str());
            return 1;
        }
    }

    int rpc_fd_in = dup(STDIN_FILENO);
    if (rpc_fd_in < 0 && errno != EBADF) {
        std::fprintf(stderr, "boxsh: failed to duplicate stdin: %s\n",
                     std::strerror(errno));
        return 1;
    }

    boxsh::WorkerPool pool(std::move(pool_cfg));
    std::string err;
    if (!pool.init(err)) {
        if (rpc_fd_in >= 0)
            close(rpc_fd_in);
        std::fprintf(stderr, "boxsh: failed to initialize worker pool: %s\n",
                     err.c_str());
        return 1;
    }

    boxsh::rpc_run_loop(rpc_fd_in, STDOUT_FILENO, pool);

    pool.shutdown();
    if (rpc_fd_in >= 0)
        close(rpc_fd_in);
    return 0;
}
