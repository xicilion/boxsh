#include "rpc.h"
#include "worker_pool.h"
#include "sandbox.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <unistd.h>
#include <getopt.h>
#include <signal.h>
#include <cerrno>
#include <sys/stat.h>
#include <pwd.h>

// Bring in dash's main() under a renamed symbol so we can call it directly
// when running in normal (non-RPC) mode.
extern "C" int dash_main(int argc, char **argv);

namespace boxsh {
namespace {

void print_usage(const char *prog) {
    std::fprintf(stderr,
        "Usage: %s [OPTIONS] [-- shell-args...]\n"
        "\n"
        "Modes:\n"
        "  (default)      Run as an ordinary POSIX shell (delegates to dash).\n"
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
        "                 is hidden unless explicitly exposed with --bind or --overlay.\n"
        "  --no-user-ns   Do not create a new user namespace (requires root for other ns).\n"
        "  --new-net-ns   Create a new network namespace (disables outbound network).\n"
        "  --new-pid-ns   Create a new PID namespace.\n"
        "  --bind SRC:DST[:ro]  Bind-mount SRC to DST inside the sandbox.\n"
        "                       Append ':ro' to make it read-only.\n"
        "  --overlay LOWER:UPPER:WORK:DST\n"
        "                       Mount overlayfs at DST.  LOWER is the read-only\n"
        "                       base layer (host path); UPPER and WORK are the\n"
        "                       writable/work directories managed by the caller\n"
        "                       (must exist; writes persist between commands).\n"
        "  --proc DST           Mount procfs at DST inside the sandbox.\n"
        "  --tmpfs DST[:OPTS]   Mount an empty tmpfs at DST (OPTS: e.g. size=128m).\n"
        "\n"
        "Quick-try mode:\n"
        "  --try          Launch a sandboxed shell on the current directory.\n"
        "                 Mounts the current directory as a copy-on-write overlay so all\n"
        "                 writes are captured in a temporary upper layer.  When the shell\n"
        "                 exits the temp dir path is printed to stderr — inspect upper/\n"
        "                 to see what changed, then discard when done.\n"
        "\n",
        prog);
}

struct Cli {
    bool rpc_mode      = false;
    bool try_mode      = false;  // --try: ephemeral COW shell on CWD
    int  num_workers   = 4;
    std::string shell_path = "/bin/sh";

    SandboxConfig sandbox;
};

// Parse --bind SRC:DST[:ro]
static bool parse_bind(const char *arg, BindMount &bm) {
    std::string s(arg);
    size_t p1 = s.find(':');
    if (p1 == std::string::npos) return false;
    bm.host_path = s.substr(0, p1);

    size_t p2 = s.find(':', p1 + 1);
    if (p2 == std::string::npos) {
        bm.container_path = s.substr(p1 + 1);
        bm.readonly       = false;
    } else {
        bm.container_path = s.substr(p1 + 1, p2 - p1 - 1);
        std::string flag  = s.substr(p2 + 1);
        bm.readonly       = (flag == "ro");
    }
    return !bm.host_path.empty() && !bm.container_path.empty();
}

// Parse --overlay LOWER:UPPER:WORK:DST
static bool parse_overlay(const char *arg, OverlayMount &om) {
    // Format: LOWER:UPPER:WORK:DST
    // LOWER may contain colons (overlayfs multi-layer lower dirs), so we
    // parse from the right: DST, WORK, UPPER are each a single segment;
    // everything left of that is LOWER.
    std::string s(arg);
    size_t p3 = s.rfind(':');
    if (p3 == std::string::npos || p3 == 0) return false;
    size_t p2 = s.rfind(':', p3 - 1);
    if (p2 == std::string::npos || p2 == 0) return false;
    size_t p1 = s.rfind(':', p2 - 1);
    if (p1 == std::string::npos) return false;
    om.lowerdir       = s.substr(0, p1);
    om.upperdir       = s.substr(p1 + 1, p2 - p1 - 1);
    om.workdir        = s.substr(p2 + 1, p3 - p2 - 1);
    om.container_path = s.substr(p3 + 1);
    return !om.lowerdir.empty() && !om.upperdir.empty() &&
           !om.workdir.empty() && !om.container_path.empty();
}

// Parse --proc DST
static ProcMount parse_proc(const char *arg) {
    return ProcMount{arg};
}

// Parse --tmpfs DST[:OPTS]
static TmpfsMount parse_tmpfs(const char *arg) {
    std::string s(arg);
    size_t p = s.find(':');
    if (p == std::string::npos)
        return TmpfsMount{s, ""};
    return TmpfsMount{s.substr(0, p), s.substr(p + 1)};
}

static Cli parse_cli(int argc, char **argv, int &remaining_argc,
                     char **&remaining_argv) {
    Cli cli;
    cli.sandbox.host_uid = (uint32_t)getuid();
    cli.sandbox.host_gid = (uint32_t)getgid();

    static const struct option opts[] = {
        {"rpc",         no_argument,       nullptr, 'R'},
        {"workers",     required_argument, nullptr, 'W'},
        {"shell",       required_argument, nullptr, 'S'},
        {"sandbox",     no_argument,       nullptr, 'X'},
        {"no-user-ns",  no_argument,       nullptr, 'U'},
        {"new-net-ns",  no_argument,       nullptr, 'N'},
        {"new-pid-ns",  no_argument,       nullptr, 'P'},
        {"bind",        required_argument, nullptr, 'b'},
        {"overlay",     required_argument, nullptr, 'v'},
        {"proc",        required_argument, nullptr, 'F'},
        {"tmpfs",       required_argument, nullptr, 'T'},
        {"try",         no_argument,       nullptr, 'y'},
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
        case 'R': cli.rpc_mode = true; break;
        case 'W': cli.num_workers = std::atoi(optarg); break;
        case 'S': cli.shell_path  = optarg; break;
        case 'X': cli.sandbox.enabled = true; break;
        case 'U': cli.sandbox.new_user_ns = false; break;
        case 'N': cli.sandbox.new_net_ns  = true; break;
        case 'P': cli.sandbox.new_pid_ns  = true; break;
        case 'b': {
            BindMount bm;
            if (!parse_bind(optarg, bm)) {
                std::fprintf(stderr, "boxsh: invalid --bind argument: %s\n",
                             optarg);
                std::exit(1);
            }
            cli.sandbox.bind_mounts.push_back(std::move(bm));
            break;
        }
        case 'v': {
            OverlayMount om;
            if (!parse_overlay(optarg, om)) {
                std::fprintf(stderr,
                    "boxsh: --overlay requires LOWER:UPPER:WORK:DST, got: %s\n",
                    optarg);
                std::exit(1);
            }
            cli.sandbox.overlay_mounts.push_back(std::move(om));
            break;
        }
        case 'F':
            cli.sandbox.proc_mounts.push_back(parse_proc(optarg));
            break;
        case 'T':
            cli.sandbox.tmpfs_mounts.push_back(parse_tmpfs(optarg));
            break;
        case 'y': cli.try_mode = true; break;
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

    // --try: auto-configure sandbox + COW overlay on CWD, then fall through
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

        char tmpl[] = "/tmp/boxsh-try-XXXXXX";
        if (!mkdtemp(tmpl)) {
            std::fprintf(stderr, "boxsh: --try: mkdtemp failed: %s\n",
                         strerror(errno));
            return 1;
        }
        std::string try_tmpdir(tmpl);
        std::string upper = try_tmpdir + "/upper";
        std::string work  = try_tmpdir + "/work";
        if (mkdir(upper.c_str(), 0700) != 0 ||
            mkdir(work.c_str(),  0700) != 0) {
            std::fprintf(stderr, "boxsh: --try: failed to create temp dirs: %s\n",
                         strerror(errno));
            rmdir(try_tmpdir.c_str());
            return 1;
        }

        std::fprintf(stderr, "boxsh: changes will be saved in %s/upper\n",
                     try_tmpdir.c_str());

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
        // without exposing writes to the host.  We deliberately avoid using
        // $HOME as an overlayfs lower layer because /home/<user> can have an
        // XFS inode number > INT32_MAX; overlayfs copy-up then fails with
        // EOVERFLOW even with xino=off.
        if (!home_dir.empty()) {
            boxsh::BindMount hbm;
            hbm.host_path      = home_dir;
            hbm.container_path = home_dir;
            hbm.readonly       = true;
            cli.sandbox.bind_mounts.push_back(std::move(hbm));
        }

        // Always COW-overlay the CWD.  The overlay lower layer is the CWD
        // directory itself, whose inode number is always small enough to avoid
        // EOVERFLOW.  If CWD is inside $HOME the overlay at step 9 shadows the
        // read-only home bind mount applied in step 6, so writes go to upper.
        {
            boxsh::OverlayMount om;
            om.lowerdir       = try_cwd;
            om.upperdir       = upper;
            om.workdir        = work;
            om.container_path = try_cwd;
            cli.sandbox.overlay_mounts.push_back(std::move(om));
        }
    }

    if (!cli.rpc_mode) {
        // Normal shell mode: apply sandbox (if requested) then run dash.
        if (cli.sandbox.enabled) {
            boxsh::SandboxResult sr = boxsh::sandbox_apply(cli.sandbox);
            if (!sr.ok) {
                std::fprintf(stderr, "boxsh: sandbox_apply failed: %s\n",
                             sr.error.c_str());
                return 1;
            }
        }

        // Reconstruct argv for dash: argv[0] is the shell binary name.
        std::vector<char *> dash_args;
        dash_args.push_back(argv[0]);
        // Enable emacs-mode line editing when running interactively.
        // Only inject -E when stdin is a terminal and the user has not
        // supplied their own -c / script file (i.e. truly interactive).
        static char emacs_flag[] = "-E";
        if (shell_argc == 0 && isatty(STDIN_FILENO))
            dash_args.push_back(emacs_flag);
        for (int i = 0; i < shell_argc; i++)
            dash_args.push_back(shell_argv[i]);
        dash_args.push_back(nullptr);
        return dash_main((int)dash_args.size() - 1, dash_args.data());
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

    boxsh::WorkerPool pool(std::move(pool_cfg));
    std::string err;
    if (!pool.init(err)) {
        std::fprintf(stderr, "boxsh: failed to initialize worker pool: %s\n",
                     err.c_str());
        return 1;
    }

    boxsh::rpc_run_loop(STDIN_FILENO, STDOUT_FILENO, pool);

    pool.shutdown();
    return 0;
}
