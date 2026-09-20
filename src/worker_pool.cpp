#include "worker_pool.h"
#include "io_utils.h"

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
#include <thread>

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

namespace {

constexpr uint32_t kMaxWireMessageBytes = 64u * 1024u * 1024u;

// Marker the coordinator writes to a busy worker's socket to cancel its
// request.  A busy worker treats *any* activity there as "stop" (that is also
// how a disappearing coordinator is noticed), so it never parses this; an idle
// worker can still receive one when the command finished just before the cancel
// arrived, and skips it by exact value.
constexpr const char *kCancelPayload = "{\"method\":\"cancel\"}";

// A worker's own result budget exists only to keep its reply readable: the
// coordinator refuses a wire message above kMaxWireMessageBytes and would
// report that as "worker crash, respawned", losing the command's output.  Raw
// streams (2 x 10 MiB) can escape to six times their size, so without this a
// binary-heavy output could break the channel.  The *client* budget
// (--max-result-bytes) is applied by the coordinator, which is the only place
// that knows what is being written to the client.
constexpr size_t kWorkerWireBudget = 48u * 1024u * 1024u;

} // namespace

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
    if (!write_all(fd, &len, sizeof(len))) return false;
    if (!write_all(fd, msg.data(), len)) return false;
    return true;
}

static bool read_msg(int fd, std::string &out, int timeout_ms = -1) {
    // Poll for data with optional timeout.
    if (timeout_ms >= 0) {
        while (true) {
            struct pollfd pfd = {fd, POLLIN, 0};
            int r = poll(&pfd, 1, timeout_ms);
            if (r > 0) break;
            if (r == 0) return false;
            if (errno == EINTR) continue;
            return false;
        }
    }

    uint32_t len = 0;
    if (!read_all(fd, &len, sizeof(len))) return false;
    if (len == 0 || len > kMaxWireMessageBytes) return false; // sanity guard

    out.resize(len);
    return read_all(fd, &out[0], len);
}

// ---------------------------------------------------------------------------
// Worker main loop (runs inside the forked worker process)
// ---------------------------------------------------------------------------

// Capture all output from executing a shell command.
// Spawns a grandchild, reads stdout+stderr pipes, returns them in 'out'/'err'.
//
// 'cancel_fd' is the worker's socket back to the coordinator.  A worker never
// receives work while a command runs, so anything arriving on that fd (EOF
// included) means "the coordinator is gone or wants this command to stop".
// Watching it inside the poll loop is what keeps a killed or disconnected
// coordinator from leaving the command's process group behind.
static void run_shell_command(const std::string &shell_path,
                              const std::string &cmd,
                              int timeout_sec,
                              std::string &stdout_out,
                              std::string &stderr_out,
                              int &exit_code,
                              bool &stdout_truncated,
                              bool &stderr_truncated,
                              bool &timed_out,
                              int cancel_fd = -1,
                              bool *cancelled_out = nullptr) {
    stdout_truncated = false;
    stderr_truncated = false;
    timed_out = false;
    if (cancelled_out) *cancelled_out = false;
    int pfd_out[2], pfd_err[2];
    if (pipe(pfd_out) != 0 || pipe(pfd_err) != 0) {
        exit_code = -1;
        stderr_out = "pipe failed: ";
        stderr_out += std::strerror(errno);
        return;
    }
    fcntl(pfd_out[0], F_SETFD, FD_CLOEXEC); fcntl(pfd_out[1], F_SETFD, FD_CLOEXEC);
    fcntl(pfd_err[0], F_SETFD, FD_CLOEXEC); fcntl(pfd_err[1], F_SETFD, FD_CLOEXEC);

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

    // Read stdout and stderr with poll to avoid deadlock.
    // Cap each stream to MAX_OUTPUT_BYTES to prevent OOM and slow serialization.
    // Data beyond the limit is still drained from the pipe so the child process
    // does not block on a full pipe buffer.
    static constexpr size_t MAX_OUTPUT_BYTES = 10u * 1024u * 1024u; // 10 MiB
    std::string out_buf, err_buf;
    bool out_done = false, err_done = false;

    // Helper: kill the child and set the timeout response fields.
    // Kill the entire process group (negative pgid) so that any sub-children
    // the shell spawned (e.g. both sides of a pipeline) are also killed.
    // This ensures every process holding the pipe write-end is gone before we
    // return, so the parent's drain loop would see EOF — but we skip the drain
    // entirely on timeout and close the fds here.
    //
    // What the command had already written is still collected first: a long
    // command that printed progress before being killed used to come back with
    // empty streams, which threw away the most interesting part of its output.
    // After SIGKILL the write ends are gone, so a bounded drain reads what is
    // left in the pipes and stops at EOF.
    auto drain_after_kill = [&]() {
        // The process group is gone, so the write ends are gone too: read what
        // is left.  poll() with a short deadline guards against a grandchild
        // that escaped the group (a daemonised process) still holding a write
        // end - the drain must never block the worker.
        std::string *bufs[2]  = {&out_buf, &err_buf};
        bool        *truncs[2] = {&stdout_truncated, &stderr_truncated};
        int          fds[2]   = {pfd_out[0], pfd_err[0]};
        bool         open_fd[2] = {true, true};
        const auto deadline = std::chrono::steady_clock::now() +
                              std::chrono::milliseconds(200);
        for (int i = 0; i < 2; ++i) {
            while (open_fd[i] && std::chrono::steady_clock::now() < deadline) {
                struct pollfd p = {fds[i], POLLIN, 0};
                int r = poll(&p, 1, 50);
                if (r <= 0) break;                       // drained (or gone)
                char tmp[4096];
                ssize_t n = read(fds[i], tmp, sizeof(tmp));
                if (n > 0) {
                    if (bufs[i]->size() < MAX_OUTPUT_BYTES) bufs[i]->append(tmp, (size_t)n);
                    else                                    *truncs[i] = true;
                } else if (n == 0) {
                    open_fd[i] = false;                  // EOF: writer gone
                } else if (errno != EINTR) {
                    open_fd[i] = false;
                }
            }
        }
        for (int i = 0; i < 2; ++i)
            if (open_fd[i]) close(fds[i]);
    };

    auto handle_timeout = [&]() {
        kill(-child, SIGKILL);  // kill the whole process group
        waitpid(child, nullptr, 0);
        drain_after_kill();     // everything the command managed to print first
        exit_code  = -1;
        stdout_out = std::move(out_buf);
        // stderr keeps the command's own last words and the marker, so a caller
        // can still tell "killed by the timeout" from a normal failure.  The
        // machine-readable signal stays `timed_out`.
        if (!err_buf.empty() && err_buf.back() != '\n') err_buf += '\n';
        err_buf += "timeout";
        stderr_out = std::move(err_buf);
        timed_out  = true;
    };

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

        struct pollfd pfds[3];
        int nfds = 0;
        int cancel_slot = -1;
        if (!out_done) { pfds[nfds].fd = pfd_out[0]; pfds[nfds].events = POLLIN;
                         pfds[nfds].revents = 0; nfds++; }
        if (!err_done) { pfds[nfds].fd = pfd_err[0]; pfds[nfds].events = POLLIN;
                         pfds[nfds].revents = 0; nfds++; }
        if (cancel_fd >= 0) {
            cancel_slot = nfds;
            pfds[nfds].fd = cancel_fd;
            pfds[nfds].events = POLLIN;
            pfds[nfds].revents = 0;
            nfds++;
        }

        int r = poll(pfds, nfds, poll_ms);
        if (r == 0) { handle_timeout(); return; } // deadline reached
        if (r < 0) {
            if (errno == EINTR) continue;
            break;
        }

        // Coordinator gone (socket closed, or a cancel arrived): kill the
        // whole process group so nothing survives the caller.  This must be
        // checked before draining output so the kill is immediate.
        if (cancel_slot >= 0 &&
            (pfds[cancel_slot].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) {
            if (cancelled_out) *cancelled_out = true;
            kill(-child, SIGKILL);
            exit_code = -1;
            close(pfd_out[0]); close(pfd_err[0]);
            waitpid(child, nullptr, 0);
            return;
        }

        for (int i = 0; i < nfds; i++) {
            if (i == cancel_slot) continue;
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
                    else
                        stdout_truncated = true;
                } else {
                    if (err_buf.size() < MAX_OUTPUT_BYTES)
                        err_buf.append(tmp, n);
                    else
                        stderr_truncated = true;
                }
            }
        }
    }

    close(pfd_out[0]);
    close(pfd_err[0]);

    int status = 0;
    // waitpid() must own this child: if it fails (ECHILD — e.g. another
    // SIGCHLD reaper got there first) the status is unknown, so report -1
    // instead of silently claiming success (exit code 0).
    if (waitpid(child, &status, 0) < 0) {
        exit_code = -1;
        stdout_out = std::move(out_buf);
        stderr_out = std::move(err_buf);
        return;
    }
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
// JSON-RPC 2.0 format: {"jsonrpc":"2.0","id":"...","method":"exec","params":{...}}
static std::string serialize_req_payload(const RpcRequest &req) {
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
    std::string out = "{\"jsonrpc\":\"2.0\",\"id\":";
    out += req.id.dump();
    out += ",\"method\":\"tools/call\",\"params\":{\"name\":\"bash\",\"arguments\":{\"command\":\"";
    out += escape(req.cmd);
    std::snprintf(buf, sizeof(buf), "\",\"timeout\":%d", req.timeout_sec);
    out += buf;
    out += "}}}";
    return out;
}

static void worker_loop(int sock_fd, const std::string &shell_path) {
    while (true) {
        std::string payload;
        if (!read_msg(sock_fd, payload)) break; // coordinator closed

        // A cancel marker can land here when the previous command finished right
        // before the client's cancellation arrived: it is not a request, and the
        // coordinator is not waiting for an answer, so it must not be parsed (or
        // answered) as one.
        if (payload == kCancelPayload) continue;

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
            resp.is_protocol_error = true;
            extern std::string rpc_serialize_response(const RpcResponse &);
            std::string r = rpc_serialize_response(resp);
            write_msg(sock_fd, r);
            continue;
        }

        auto t0 = std::chrono::steady_clock::now();

        std::string out, serr;
        int code = -1;
        bool out_trunc = false, err_trunc = false, timed_out = false;
        bool cancelled = false;
        run_shell_command(shell_path, req.cmd, req.timeout_sec,
                          out, serr, code, out_trunc, err_trunc, timed_out,
                          sock_fd, &cancelled);

        if (cancelled) {
            // Nobody is waiting for this response: the coordinator is gone or
            // dropped the request (JSON-RPC cancellation sends no reply at
            // all).  Exit so the worker does not linger as an orphan itself.
            break;
        }

        auto t1 = std::chrono::steady_clock::now();
        uint64_t ms = (uint64_t)std::chrono::duration_cast<
                          std::chrono::milliseconds>(t1 - t0).count();

        RpcResponse resp;
        resp.id                = req.id;
        resp.exit_code         = code;
        resp.stdout_data       = std::move(out);
        resp.stderr_data       = std::move(serr);
        resp.duration_ms       = ms;
        resp.stdout_truncated  = out_trunc;
        resp.stderr_truncated  = err_trunc;
        resp.timed_out         = timed_out;

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
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
        std::perror("socketpair");
        return;
    }
    fcntl(sv[0], F_SETFD, FD_CLOEXEC);
    fcntl(sv[1], F_SETFD, FD_CLOEXEC);

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
        //
        // Reset SIGCHLD to the default disposition.  In sandbox mode the
        // coordinator runs as PID 1 of the new PID namespace and installs a
        // SIGCHLD handler that reaps every finished child (sandbox.cpp
        // "As PID 1, we must reap orphaned child processes").  Signal
        // dispositions are inherited across fork(), so without this reset the
        // worker's own waitpid() in run_shell_command() would race with that
        // handler, lose the child status (ECHILD) and report exit code 0 for
        // every sandboxed command.
        signal(SIGCHLD, SIG_DFL);

        // The client-facing result budget is not this process's business: a
        // worker only has to keep its wire message readable (see
        // kWorkerWireBudget).
        rpc_set_result_budget(kWorkerWireBudget);

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

// Parse a worker response (JSON-RPC 2.0) payload into an RpcResponse.
static RpcResponse parse_worker_response(const std::string &payload,
                                         const nlohmann::json &fallback_id) {
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

    // JSON-RPC 2.0 error response.
    if (j.contains("error") && j["error"].is_object()) {
        resp.error = j["error"].value("message", "unknown error");
        return resp;
    }

    auto result = j.value("result", nlohmann::json::object());
    auto sc = result.value("structuredContent", nlohmann::json::object());
    if (sc.contains("exit_code")) {
        // Command ran — extract from structuredContent.
        resp.exit_code   = sc.value("exit_code", -1);
        resp.stdout_data = sc.value("stdout",    "");
        resp.stderr_data = sc.value("stderr",    "");
        resp.duration_ms = sc.value("duration_ms", (uint64_t)0);
        resp.stdout_truncated = sc.value("stdout_truncated", false);
        resp.stderr_truncated = sc.value("stderr_truncated", false);
        resp.timed_out = sc.value("timed_out", false);
    } else if (result.value("isError", false)) {
        // Tool error without structuredContent (e.g. worker internal error).
        auto content = result.value("content", nlohmann::json::array());
        if (!content.empty() && content[0].contains("text"))
            resp.error = content[0]["text"].get<std::string>();
    }
    return resp;
}

bool WorkerPool::try_dispatch(const RpcRequest &req) {
    // Find the first idle worker.
    for (auto &w : workers_) {
        if (w.busy) continue;

        // Resolve the timeout actually used: a request that carries none
        // inherits the server default (--command-timeout).  The default is a
        // fallback, not a ceiling — an explicit value always wins, so a
        // caller can still ask for a longer-running command.
        RpcRequest effective = req;
        bool from_default = false;
        if (effective.timeout_sec <= 0 && cfg_.default_timeout_sec > 0) {
            effective.timeout_sec = cfg_.default_timeout_sec;
            from_default = true;
        }

        std::string payload = serialize_req_payload(effective);
        if (!write_msg(w.fd, payload)) return false;

        w.busy                     = true;
        w.inflight_id              = req.id;
        w.inflight_timeout_sec     = effective.timeout_sec;
        w.inflight_timeout_default = from_default;
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

bool WorkerPool::cancel(const nlohmann::json &id) {
    for (auto &w : workers_) {
        if (!w.busy || w.inflight_id != id) continue;
        w.inflight_cancelled = true;
        // The worker kills the command's whole process group and exits without
        // replying (see run_shell_command's cancel_fd handling); the reply that
        // never comes is the crash path below, which respawns the worker.
        write_msg(w.fd, kCancelPayload);
        return true;
    }
    return false;
}

RpcResponse WorkerPool::collect(size_t idx) {
    Worker &w = workers_[idx];
    const bool was_cancelled = w.inflight_cancelled;

    std::string payload;
    if (!read_msg(w.fd, payload)) {
        // Worker crashed - or stopped because the request was cancelled, which
        // its machinery does by exiting after killing the command's group.
        nlohmann::json inflight = w.inflight_id;
        close(w.fd);
        if (w.pid > 0) {
            if (kill(w.pid, SIGKILL) != 0 && errno != ESRCH) {
                // Best effort: waitpid below still handles already-exited workers.
            }
            while (waitpid(w.pid, nullptr, 0) < 0) {
                if (errno == EINTR) continue;
                break;
            }
        }
        w = Worker{};
        spawn_worker(w);

        RpcResponse resp;
        resp.id        = inflight;
        resp.error     = "worker crash, respawned";
        resp.suppressed = was_cancelled;   // nobody is waiting for this one
        return resp;
    }

    nlohmann::json inflight = w.inflight_id;
    int  timeout_sec     = w.inflight_timeout_sec;
    bool timeout_default = w.inflight_timeout_default;
    w.busy        = false;
    w.inflight_id = nullptr;
    w.inflight_cancelled = false;

    RpcResponse resp = parse_worker_response(payload, inflight);
    resp.timeout_sec                 = timeout_sec;
    resp.timeout_from_server_default = timeout_default;
    resp.suppressed                  = was_cancelled;
    return resp;
}

void WorkerPool::shutdown() {
    if (workers_.empty()) return;

    // Close our end of every worker socket first.  A worker running a command
    // polls that socket, so closing it tells the worker "stop": it kills the
    // command's process group before exiting.  Waiting for the workers to go
    // away on their own is what makes this a cleanup instead of a leak.
    for (auto &w : workers_) {
        if (w.fd >= 0) {
            close(w.fd);
            w.fd = -1;
        }
    }

    auto wait_pid = [](pid_t pid, int grace_ms) {
        const auto deadline = std::chrono::steady_clock::now() +
                              std::chrono::milliseconds(grace_ms);
        while (std::chrono::steady_clock::now() < deadline) {
            int status = 0;
            pid_t r = waitpid(pid, &status, WNOHANG);
            if (r == pid) return;         // exited and reaped
            if (r < 0 && errno != EINTR) return; // ECHILD: already reaped
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    };

    // Grace period: long enough for a worker to kill its command and exit.
    for (auto &w : workers_) {
        if (w.pid > 0) wait_pid(w.pid, 3000);
    }

    // Escalate for stragglers (a worker wedged in the kernel keeps its
    // command's process group alive, so only kill workers that are still here).
    for (auto &w : workers_) {
        if (w.pid > 0 && kill(w.pid, 0) == 0) kill(w.pid, SIGTERM);
    }
    for (auto &w : workers_) {
        if (w.pid > 0 && kill(w.pid, 0) == 0) {
            kill(w.pid, SIGKILL);
            while (waitpid(w.pid, nullptr, 0) < 0 && errno == EINTR) {}
        }
        w.pid = -1;
    }
    workers_.clear();
}

} // namespace boxsh
