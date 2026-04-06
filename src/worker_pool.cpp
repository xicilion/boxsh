#include "worker_pool.h"

#include <nlohmann/json.hpp>

#include <cassert>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <climits>
#include <ctime>
#include <algorithm>
#include <chrono>

#include <unistd.h>
#include <signal.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <poll.h>
#include <fcntl.h>

// Bring in dash's main() under a renamed symbol so we can use the
// embedded shell directly instead of exec'ing an external /bin/sh.
extern "C" int dash_main(int argc, char **argv);

namespace boxsh {

// ---------------------------------------------------------------------------
// Simple wire protocol over the socketpair:
//
//  Coordinator → Worker:  4-byte little-endian payload_len, then JSON bytes
//  Worker → Coordinator:  4-byte little-endian payload_len, then JSON bytes
//
// The JSON payload for request/response reuses RpcRequest / RpcResponse
// serialized as JSON strings (cmd, timeout, sandbox_json_raw / exit_code, etc.)
// ---------------------------------------------------------------------------

static bool write_msg(int fd, const std::string &msg) {
    uint32_t len = (uint32_t)msg.size();
    // Write length prefix.
    if (write(fd, &len, 4) != 4) return false;
    if (write(fd, msg.c_str(), len) != (ssize_t)len) return false;
    return true;
}

static bool read_msg(int fd, std::string &out, int timeout_ms = -1) {
    // Poll for data with optional timeout.
    if (timeout_ms >= 0) {
        struct pollfd pfd = {fd, POLLIN, 0};
        int r = poll(&pfd, 1, timeout_ms);
        if (r <= 0) return false; // timeout or error
    }

    uint32_t len = 0;
    ssize_t n = read(fd, &len, 4);
    if (n != 4) return false;
    if (len == 0 || len > 64u * 1024 * 1024) return false; // sanity guard

    out.resize(len);
    size_t received = 0;
    while (received < len) {
        n = read(fd, &out[received], len - received);
        if (n <= 0) return false;
        received += (size_t)n;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Worker main loop (runs inside the forked worker process)
// ---------------------------------------------------------------------------

// Capture all output from executing a shell command.
// Spawns a grandchild, reads stdout+stderr pipes, returns them in 'out'/'err'.
static void run_shell_command(const std::string &shell_path,
                              const std::string &cmd,
                              int timeout_sec,
                              std::string &stdout_out,
                              std::string &stderr_out,
                              int &exit_code) {
    int pfd_out[2], pfd_err[2];
    if (pipe2(pfd_out, O_CLOEXEC) != 0 || pipe2(pfd_err, O_CLOEXEC) != 0) {
        exit_code = -1;
        stderr_out = "pipe2 failed: ";
        stderr_out += std::strerror(errno);
        return;
    }

    pid_t child = fork();
    if (child < 0) {
        exit_code = -1;
        stderr_out = "fork failed: ";
        stderr_out += std::strerror(errno);
        close(pfd_out[0]); close(pfd_out[1]);
        close(pfd_err[0]); close(pfd_err[1]);
        return;
    }

    if (child == 0) {
        // Grandchild: run command via the embedded dash.
        //
        // Put this child in its own process group so that kill(-pgid, SIGKILL)
        // from the parent on timeout also reaps any sub-children spawned by
        // the shell command (e.g. the two sides of a pipe like `yes | head`).
        // Without this, orphaned sub-children keep the pipe write-end open and
        // the parent's drain loop never sees EOF.
        setpgid(0, 0);

        dup2(pfd_out[1], STDOUT_FILENO);
        dup2(pfd_err[1], STDERR_FILENO);
        // Close all pipe fds (marked O_CLOEXEC handles exec, but dup2
        // targets are not, so close the originals explicitly).
        close(pfd_out[0]); close(pfd_out[1]);
        close(pfd_err[0]); close(pfd_err[1]);

        // Redirect stdin from /dev/null.
        int devnull = open("/dev/null", O_RDONLY | O_CLOEXEC);
        if (devnull >= 0) {
            dup2(devnull, STDIN_FILENO);
            close(devnull);
        }

        // Close all inherited fds above stderr (e.g. worker socketpair).
        // With execl() these would be closed by O_CLOEXEC, but since we
        // call dash_main() directly there is no exec boundary.
        for (int fd = STDERR_FILENO + 1; fd < 1024; fd++)
            close(fd);

        // Use the statically-linked dash to parse the command.
        // This handles pipes, redirects, variables, etc. without
        // depending on an external /bin/sh.
        char arg_c[] = "-c";
        char *dash_argv[] = {
            const_cast<char *>(shell_path.empty() ? "sh" : shell_path.c_str()),
            arg_c,
            const_cast<char *>(cmd.c_str()),
            nullptr
        };
        _exit(dash_main(3, dash_argv));
    }

    // Parent: close write ends, read from read ends.
    close(pfd_out[1]);
    close(pfd_err[1]);

    // Compute an absolute deadline using the monotonic clock.
    // poll() is called with the remaining milliseconds on each iteration so
    // that the timeout fires reliably regardless of when signal delivery occurs
    // — avoiding the race where alarm() fires before poll() is entered.
    struct timespec deadline = {};
    const bool has_timeout = (timeout_sec > 0);
    if (has_timeout) {
        clock_gettime(CLOCK_MONOTONIC, &deadline);
        deadline.tv_sec += timeout_sec;
    }

    // Helper: kill the child and set the timeout response fields.
    // Kill the entire process group (negative pgid) so that any sub-children
    // the shell spawned (e.g. both sides of a pipeline) are also killed.
    // This ensures every process holding the pipe write-end is gone before we
    // return, so the parent's drain loop would see EOF — but we skip the drain
    // entirely on timeout and close the fds here.
    auto handle_timeout = [&]() {
        kill(-child, SIGKILL);  // kill the whole process group
        exit_code  = -1;
        stderr_out = "timeout";
        close(pfd_out[0]); close(pfd_err[0]);
        waitpid(child, nullptr, 0);
    };

    // Read stdout and stderr with poll to avoid deadlock.
    // Cap each stream to MAX_OUTPUT_BYTES to prevent OOM and slow serialization.
    // Data beyond the limit is still drained from the pipe so the child process
    // does not block on a full pipe buffer.
    static constexpr size_t MAX_OUTPUT_BYTES = 10u * 1024u * 1024u; // 10 MiB
    std::string out_buf, err_buf;
    bool out_done = false, err_done = false;

    while (!out_done || !err_done) {
        int poll_ms = -1; // infinite when there is no timeout
        if (has_timeout) {
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            long ms = (deadline.tv_sec  - now.tv_sec)  * 1000L
                    + (deadline.tv_nsec - now.tv_nsec) / 1000000L;
            if (ms <= 0) { handle_timeout(); return; }
            poll_ms = (int)std::min<long>(ms, (long)INT_MAX);
        }

        struct pollfd pfds[2];
        int nfds = 0;
        if (!out_done) { pfds[nfds] = {pfd_out[0], POLLIN, 0}; nfds++; }
        if (!err_done)  { pfds[nfds] = {pfd_err[0], POLLIN, 0}; nfds++; }

        int r = poll(pfds, nfds, poll_ms);
        if (r == 0) { handle_timeout(); return; } // deadline reached
        if (r < 0) {
            if (errno == EINTR) continue;
            break;
        }

        for (int i = 0; i < nfds; i++) {
            if (!(pfds[i].revents & (POLLIN | POLLHUP))) continue;
            char tmp[4096];
            ssize_t n = read(pfds[i].fd, tmp, sizeof(tmp));
            if (n < 0) {
                if (errno == EINTR) continue; // retry via outer while
                // Other read error: treat as EOF on this fd.
                if (pfds[i].fd == pfd_out[0]) out_done = true;
                else                           err_done = true;
            } else if (n == 0) {
                if (pfds[i].fd == pfd_out[0]) out_done = true;
                else                           err_done = true;
            } else {
                if (pfds[i].fd == pfd_out[0]) {
                    if (out_buf.size() < MAX_OUTPUT_BYTES)
                        out_buf.append(tmp, n);
                    // else: discard — keep draining so child is not blocked
                } else {
                    if (err_buf.size() < MAX_OUTPUT_BYTES)
                        err_buf.append(tmp, n);
                }
            }
        }
    }

    close(pfd_out[0]);
    close(pfd_err[0]);

    int status = 0;
    waitpid(child, &status, 0);
    if (WIFEXITED(status))
        exit_code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status))
        exit_code = 128 + WTERMSIG(status);
    else
        exit_code = -1;

    stdout_out = std::move(out_buf);
    stderr_out = std::move(err_buf);
}

// Minimal JSON serialization for the request payload sent to the worker.
// We keep it simple: just flatten the needed fields.
static std::string serialize_req_payload(const RpcRequest &req) {
    // Build a minimal JSON object manually. cmd is the only field that needs
    // escaping; the helper below handles all ASCII control characters.
    auto escape = [](const std::string &s) -> std::string {
        std::string o;
        o.reserve(s.size());
        for (unsigned char c : s) {
            switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    o += buf;
                } else {
                    o += (char)c;
                }
                break;
            }
        }
        return o;
    };

    char buf[256];
    std::string out = "{\"id\":\"";
    out += escape(req.id);
    out += "\",\"cmd\":\"";
    out += escape(req.cmd);
    std::snprintf(buf, sizeof(buf), "\",\"timeout\":%d,\"sandbox\":", req.timeout_sec);
    out += buf;
    out += req.sandbox_json_raw.empty() ? "null" : req.sandbox_json_raw;
    out += "}";
    return out;
}

static void worker_loop(int sock_fd, const std::string &shell_path) {
    while (true) {
        std::string payload;
        if (!read_msg(sock_fd, payload)) break; // coordinator closed

        // Minimal parse: extract id, cmd, timeout from the simple JSON above.
        // Re-use rpc_parse_request.
        RpcRequest req;
        std::string err;
        // rpc_parse_request is in rpc.cpp — we call it via the public header.
        extern bool rpc_parse_request(const std::string &, RpcRequest &,
                                      std::string &);
        if (!rpc_parse_request(payload, req, err)) {
            RpcResponse resp;
            resp.id    = req.id;
            resp.error = "worker_parse_error: " + err;
            extern std::string rpc_serialize_response(const RpcResponse &);
            std::string r = rpc_serialize_response(resp);
            write_msg(sock_fd, r);
            continue;
        }

        auto t0 = std::chrono::steady_clock::now();

        std::string out, serr;
        int code = -1;
        run_shell_command(shell_path, req.cmd, req.timeout_sec, out, serr, code);

        auto t1 = std::chrono::steady_clock::now();
        uint64_t ms = (uint64_t)std::chrono::duration_cast<
                          std::chrono::milliseconds>(t1 - t0).count();

        RpcResponse resp;
        resp.id          = req.id;
        resp.exit_code   = code;
        resp.stdout_data = std::move(out);
        resp.stderr_data = std::move(serr);
        resp.duration_ms = ms;

        extern std::string rpc_serialize_response(const RpcResponse &);
        std::string r = rpc_serialize_response(resp);
        if (!write_msg(sock_fd, r)) break;
    }
    close(sock_fd);
    _exit(0);
}

// ---------------------------------------------------------------------------
// WorkerPool implementation
// ---------------------------------------------------------------------------

WorkerPool::WorkerPool(WorkerPoolConfig cfg) : cfg_(std::move(cfg)) {}

WorkerPool::~WorkerPool() {
    shutdown();
}

void WorkerPool::spawn_worker(Worker &w) {
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv) != 0) {
        std::perror("socketpair");
        return;
    }

    pid_t pid = fork();
    if (pid < 0) {
        std::perror("fork worker");
        close(sv[0]); close(sv[1]);
        return;
    }

    if (pid == 0) {
        // Worker child.
        close(sv[0]); // close coordinator side

        // The coordinator has already applied the sandbox before forking, so
        // no sandbox_apply() call is needed here.
        worker_loop(sv[1], cfg_.shell_path);
        _exit(0);
    }

    // Coordinator side.
    close(sv[1]); // close worker side
    w.pid = pid;
    w.fd  = sv[0];
}

bool WorkerPool::init(std::string &error) {
    workers_.resize(cfg_.num_workers);
    for (auto &w : workers_) {
        spawn_worker(w);
        if (w.pid < 0) {
            error = "failed to spawn worker";
            return false;
        }
    }
    return true;
}

// Parse a worker response JSON payload into an RpcResponse.
static RpcResponse parse_worker_response(const std::string &payload,
                                         const std::string &fallback_id) {
    RpcResponse resp;
    resp.id = fallback_id;

    nlohmann::json j;
    try { j = nlohmann::json::parse(payload); }
    catch (...) {
        resp.error = "failed to parse worker response JSON";
        return resp;
    }
    if (!j.is_object()) {
        resp.error = "worker response is not a JSON object";
        return resp;
    }

    resp.exit_code   = j.value("exit_code", -1);
    resp.stdout_data = j.value("stdout",    "");
    resp.stderr_data = j.value("stderr",    "");
    resp.duration_ms = j.value("duration_ms", (uint64_t)0);
    if (j.contains("error") && j["error"].is_string())
        resp.error = j["error"].get<std::string>();
    return resp;
}

bool WorkerPool::try_dispatch(const RpcRequest &req) {
    // Find the first idle worker.
    for (auto &w : workers_) {
        if (w.busy) continue;

        std::string payload = serialize_req_payload(req);
        if (!write_msg(w.fd, payload)) return false;

        w.busy        = true;
        w.inflight_id = req.id;
        return true;
    }
    return false; // no free worker
}

size_t WorkerPool::idle_count() const {
    size_t n = 0;
    for (const auto &w : workers_)
        if (!w.busy) n++;
    return n;
}

std::vector<WorkerPool::BusyEntry> WorkerPool::busy_entries() const {
    std::vector<BusyEntry> out;
    for (size_t i = 0; i < workers_.size(); i++) {
        if (workers_[i].busy)
            out.push_back({workers_[i].fd, i});
    }
    return out;
}

RpcResponse WorkerPool::collect(size_t idx) {
    Worker &w = workers_[idx];

    std::string payload;
    if (!read_msg(w.fd, payload)) {
        // Worker crashed: respawn and return an error.
        std::string inflight = w.inflight_id;
        close(w.fd);
        waitpid(w.pid, nullptr, WNOHANG);
        w = Worker{};
        spawn_worker(w);

        RpcResponse resp;
        resp.id    = inflight;
        resp.error = "worker crash, respawned";
        return resp;
    }

    std::string inflight = w.inflight_id;
    w.busy        = false;
    w.inflight_id.clear();

    return parse_worker_response(payload, inflight);
}

void WorkerPool::shutdown() {
    for (auto &w : workers_) {
        if (w.pid > 0) {
            kill(w.pid, SIGTERM);
            w.pid = -1;
        }
        if (w.fd >= 0) {
            close(w.fd);
            w.fd = -1;
        }
    }
    // Reap all.
    while (waitpid(-1, nullptr, WNOHANG) > 0) {}
    workers_.clear();
}

} // namespace boxsh
