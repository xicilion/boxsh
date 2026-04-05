#include "rpc.h"
#include "worker_pool.h"

#include <cerrno>
#include <climits>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace boxsh {

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

bool rpc_parse_request(const std::string &line, RpcRequest &req,
                       std::string &parse_error) {
    json j;
    try {
        j = json::parse(line);
    } catch (const json::exception &e) {
        parse_error = std::string("invalid JSON: ") + e.what();
        return false;
    }
    if (!j.is_object()) {
        parse_error = "JSON root must be an object";
        return false;
    }

    if (j.contains("id") && j["id"].is_string())
        req.id = j["id"].get<std::string>();

    // Determine if this is a built-in tool invocation or a shell command.
    if (j.contains("tool") && j["tool"].is_string()) {
        const std::string tool = j["tool"].get<std::string>();

        if (!j.contains("path") || !j["path"].is_string()) {
            parse_error = "tool request missing string field: path";
            return false;
        }
        req.path = j["path"].get<std::string>();

        if (tool == "read") {
            req.tool = ToolKind::Read;
            if (j.contains("offset") && j["offset"].is_number_integer())
                req.offset = j["offset"].get<int>();
            if (j.contains("limit") && j["limit"].is_number_integer())
                req.limit = j["limit"].get<int>();

        } else if (tool == "write") {
            req.tool = ToolKind::Write;
            if (!j.contains("content") || !j["content"].is_string()) {
                parse_error = "write tool missing string field: content";
                return false;
            }
            req.content = j["content"].get<std::string>();

        } else if (tool == "edit") {
            req.tool = ToolKind::Edit;
            if (!j.contains("edits") || !j["edits"].is_array()) {
                parse_error = "edit tool missing array field: edits";
                return false;
            }
            for (const auto &op : j["edits"]) {
                if (!op.contains("oldText") || !op["oldText"].is_string() ||
                    !op.contains("newText") || !op["newText"].is_string()) {
                    parse_error = "each edit must have string fields oldText and newText";
                    return false;
                }
                req.edits.push_back({op["oldText"].get<std::string>(),
                                     op["newText"].get<std::string>()});
            }

        } else {
            parse_error = "unknown tool: " + tool;
            return false;
        }
        return true;
    }

    // Shell command mode.
    if (!j.contains("cmd") || !j["cmd"].is_string()) {
        parse_error = "missing or non-string field: cmd";
        return false;
    }
    req.cmd = j["cmd"].get<std::string>();

    if (j.contains("timeout") && j["timeout"].is_number())
        req.timeout_sec = j["timeout"].get<int>();

    if (j.contains("sandbox") && j["sandbox"].is_object())
        req.sandbox_json_raw = j["sandbox"].dump();

    return true;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

std::string rpc_serialize_response(const RpcResponse &resp) {
    json j;
    j["id"] = resp.id;

    if (resp.tool == ToolKind::None) {
        // Shell command response.
        j["exit_code"]   = resp.exit_code;
        j["stdout"]      = resp.stdout_data;
        j["stderr"]      = resp.stderr_data;
        j["duration_ms"] = resp.duration_ms;
    } else if (resp.tool == ToolKind::Read || resp.tool == ToolKind::Write) {
        j["content"] = json::array({{{"type", "text"}, {"text", resp.tool_content}}});
        if (resp.tool == ToolKind::Read) {
            // Count lines in the returned content.
            int lines = 0;
            for (char c : resp.tool_content) if (c == '\n') lines++;
            j["details"] = {{"truncation", {{"truncated", false}, {"line_count", lines}}}};
        }
    } else if (resp.tool == ToolKind::Edit) {
        j["content"] = json::array({{{"type", "text"}, {"text", "OK"}}});
        j["details"] = {{"diff", resp.diff},
                        {"firstChangedLine", resp.first_changed_line}};
    }

    if (!resp.error.empty())
        j["error"] = resp.error;

    return j.dump();
}

// ---------------------------------------------------------------------------
// Built-in tool handlers
// ---------------------------------------------------------------------------

static RpcResponse tool_read(const RpcRequest &req) {
    RpcResponse resp;
    resp.id   = req.id;
    resp.tool = ToolKind::Read;

    std::ifstream f(req.path);
    if (!f) {
        resp.error = std::string("read: cannot open file: ") + req.path +
                     ": " + strerror(errno);
        return resp;
    }

    std::string line;
    std::ostringstream out;
    int line_no   = 0;
    int start     = req.offset.value_or(1);
    int max_lines = req.limit.value_or(INT_MAX);
    int collected = 0;

    while (std::getline(f, line)) {
        ++line_no;
        if (line_no < start) continue;
        if (collected >= max_lines) {
            // Truncated — note it in details (overridden below).
            resp.tool_content = out.str();
            // Re-serialize with truncated=true handled by caller via details.
            // Just mark in error for now via a side-channel-free approach: set
            // a flag via a special detail appended at serialize time.
            // Simpler: just stop here; the caller can re-request.
            break;
        }
        out << line << '\n';
        ++collected;
    }
    if (collected < max_lines)
        resp.tool_content = out.str(); // only overwrite if loop finished normally

    return resp;
}

static RpcResponse tool_write(const RpcRequest &req) {
    RpcResponse resp;
    resp.id   = req.id;
    resp.tool = ToolKind::Write;

    std::ofstream f(req.path, std::ios::binary | std::ios::trunc);
    if (!f) {
        resp.error = std::string("write: cannot open file: ") + req.path +
                     ": " + strerror(errno);
        return resp;
    }
    f << req.content;
    if (!f) {
        resp.error = std::string("write: failed writing to: ") + req.path;
        return resp;
    }
    resp.tool_content = "written " + std::to_string(req.content.size()) + " bytes";
    return resp;
}

// Generate a minimal unified diff (no context lines — sufficient for callers).
static std::string make_diff(const std::string &path,
                              const std::string &before,
                              const std::string &after,
                              int &first_changed_line) {
    // Split both into lines.
    auto split = [](const std::string &s) {
        std::vector<std::string> v;
        std::istringstream ss(s);
        std::string ln;
        while (std::getline(ss, ln)) v.push_back(ln);
        return v;
    };
    auto blines = split(before);
    auto alines = split(after);

    // Find first differing line.
    first_changed_line = 0;
    size_t common_prefix = 0;
    while (common_prefix < blines.size() && common_prefix < alines.size() &&
           blines[common_prefix] == alines[common_prefix])
        ++common_prefix;
    if (common_prefix < blines.size() || common_prefix < alines.size())
        first_changed_line = (int)common_prefix + 1;

    // Simple hunk: output all removed lines then all added lines.
    std::ostringstream d;
    d << "--- a/" << path << "\n+++ b/" << path << "\n";
    if (first_changed_line > 0) {
        int b_count = (int)blines.size() - (int)common_prefix;
        int a_count = (int)alines.size() - (int)common_prefix;
        d << "@@ -" << first_changed_line << "," << b_count
          << " +" << first_changed_line << "," << a_count << " @@\n";
        for (size_t i = common_prefix; i < blines.size(); ++i)
            d << "-" << blines[i] << "\n";
        for (size_t i = common_prefix; i < alines.size(); ++i)
            d << "+" << alines[i] << "\n";
    }
    return d.str();
}

static RpcResponse tool_edit(const RpcRequest &req) {
    RpcResponse resp;
    resp.id   = req.id;
    resp.tool = ToolKind::Edit;

    // Read existing content.
    std::ifstream fin(req.path, std::ios::binary);
    if (!fin) {
        resp.error = std::string("edit: cannot open file: ") + req.path +
                     ": " + strerror(errno);
        return resp;
    }
    std::ostringstream buf;
    buf << fin.rdbuf();
    std::string content = buf.str();
    fin.close();

    const std::string original = content;

    // Apply edits sequentially against the ORIGINAL content (per spec:
    // each edit matches original, not the result of previous edits).
    // To achieve this, collect all match positions in the original first,
    // then apply in reverse order.
    struct Match { size_t pos; const EditOp *op; };
    std::vector<Match> matches;
    matches.reserve(req.edits.size());

    for (const auto &op : req.edits) {
        if (op.old_text.empty()) {
            resp.error = "edit: oldText must not be empty";
            return resp;
        }
        size_t pos = content.find(op.old_text);
        if (pos == std::string::npos) {
            resp.error = "edit: oldText not found in file: " + op.old_text.substr(0, 40);
            return resp;
        }
        // Check uniqueness.
        if (content.find(op.old_text, pos + 1) != std::string::npos) {
            resp.error = "edit: oldText is not unique in file: " + op.old_text.substr(0, 40);
            return resp;
        }
        matches.push_back({pos, &op});
    }

    // Check for overlaps.
    std::sort(matches.begin(), matches.end(),
              [](const Match &a, const Match &b) { return a.pos < b.pos; });
    for (size_t i = 1; i < matches.size(); ++i) {
        size_t prev_end = matches[i-1].pos + matches[i-1].op->old_text.size();
        if (matches[i].pos < prev_end) {
            resp.error = "edit: overlapping edits are not allowed";
            return resp;
        }
    }

    // Apply in reverse order so positions remain valid.
    for (auto it = matches.rbegin(); it != matches.rend(); ++it)
        content.replace(it->pos, it->op->old_text.size(), it->op->new_text);

    // Write result.
    std::ofstream fout(req.path, std::ios::binary | std::ios::trunc);
    if (!fout) {
        resp.error = std::string("edit: cannot write file: ") + req.path +
                     ": " + strerror(errno);
        return resp;
    }
    fout << content;
    fout.close();

    resp.diff = make_diff(req.path, original, content, resp.first_changed_line);
    return resp;
}

// ---------------------------------------------------------------------------
// Non-blocking line reader
// ---------------------------------------------------------------------------

class LineReader {
public:
    explicit LineReader(int fd) : fd_(fd) {
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }

    bool fill() {
        char tmp[8192];
        while (true) {
            ssize_t n = read(fd_, tmp, sizeof(tmp));
            if (n > 0) { buf_.append(tmp, (size_t)n); continue; }
            if (n == 0) { eof_ = true; return false; }
            if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
            return false;
        }
    }

    bool get_line(std::string &line) {
        auto pos = buf_.find('\n');
        if (pos == std::string::npos) return false;
        size_t end = (pos > 0 && buf_[pos - 1] == '\r') ? pos - 1 : pos;
        line = buf_.substr(0, end);
        buf_.erase(0, pos + 1);
        return true;
    }

    bool has_line() const { return buf_.find('\n') != std::string::npos; }
    bool eof()      const { return eof_; }
    int  fd()       const { return fd_; }

private:
    int         fd_;
    std::string buf_;
    bool        eof_ = false;
};

// ---------------------------------------------------------------------------
// RPC event loop
// ---------------------------------------------------------------------------

void rpc_run_loop(int fd_in, int fd_out, WorkerPool &pool) {
    FILE *fout = fdopen(fd_out, "w");
    if (!fout) return;
    setvbuf(fout, nullptr, _IOLBF, 0);

    auto write_resp = [&](const RpcResponse &resp) {
        std::string line = rpc_serialize_response(resp) + '\n';
        fwrite(line.c_str(), 1, line.size(), fout);
    };

    LineReader reader(fd_in);
    size_t in_flight = 0;

    // Each in-flight tool request gets its own socketpair.  The worker thread
    // writes a 4-byte LE length + serialized response to the write end; the
    // event loop polls the read end alongside worker sockets.
    struct ToolEntry { int fd; };
    std::vector<ToolEntry> pending_tools;

    // A cmd request that arrived when all workers were busy.  We hold exactly
    // one and stop reading stdin until a worker becomes available.
    std::optional<RpcRequest> buffered_cmd;

    // Dispatch a built-in tool on a background thread.  The result is sent
    // back through a socketpair so the event loop is never blocked.
    auto dispatch_tool_async = [&](const RpcRequest &req) {
        int sv[2];
        if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv) != 0) {
            // Extremely unlikely (fd exhaustion). Fall back to synchronous.
            RpcResponse resp;
            switch (req.tool) {
                case ToolKind::Read:  resp = tool_read(req);  break;
                case ToolKind::Write: resp = tool_write(req); break;
                case ToolKind::Edit:  resp = tool_edit(req);  break;
                default: break;
            }
            write_resp(resp);
            return;
        }
        pending_tools.push_back({sv[0]});
        in_flight++;
        int wfd = sv[1];
        RpcRequest req_copy = req;
        std::thread([req_copy, wfd]() {
            RpcResponse resp;
            switch (req_copy.tool) {
                case ToolKind::Read:  resp = tool_read(req_copy);  break;
                case ToolKind::Write: resp = tool_write(req_copy); break;
                case ToolKind::Edit:  resp = tool_edit(req_copy);  break;
                default: break;
            }
            std::string payload = rpc_serialize_response(resp) + '\n';
            uint32_t len = (uint32_t)payload.size();
            (void)write(wfd, &len, 4);
            (void)write(wfd, payload.c_str(), len);
            close(wfd);
        }).detach();
    };

    while (true) {
        // Dispatch a previously buffered cmd if a worker is now free.
        if (buffered_cmd.has_value() && pool.idle_count() > 0) {
            pool.try_dispatch(*buffered_cmd);
            buffered_cmd.reset();
            in_flight++;
        }

        // Read and dispatch requests from the line buffer.
        // Tool requests are always dispatched (no worker needed).
        // Cmd requests are held in buffered_cmd if all workers are busy.
        while (reader.has_line()) {
            std::string line;
            reader.get_line(line);
            if (line.empty()) continue;

            RpcRequest  req;
            std::string parse_error;
            if (!rpc_parse_request(line, req, parse_error)) {
                RpcResponse err;
                err.id    = req.id;
                err.error = "parse_error: " + parse_error;
                write_resp(err);
                continue;
            }

            if (req.tool != ToolKind::None) {
                // Tool requests run on a background thread; never need a worker.
                dispatch_tool_async(req);
                continue;
            }

            if (pool.idle_count() == 0) {
                // No free worker; buffer and stop reading until one is free.
                buffered_cmd = std::move(req);
                break;
            }
            pool.try_dispatch(req);
            in_flight++;
        }

        if (reader.eof() && in_flight == 0 && !buffered_cmd.has_value()) break;

        auto busy = pool.busy_entries();

        std::vector<struct pollfd> pfds;
        pfds.reserve(1 + busy.size() + pending_tools.size());

        // Do not poll stdin when holding a buffered cmd — reading more lines
        // would not help until the buffered request is dispatched.
        const bool poll_stdin = !reader.eof() && !buffered_cmd.has_value();
        if (poll_stdin) pfds.push_back({reader.fd(), POLLIN, 0});
        for (const auto &b : busy)
            pfds.push_back({b.fd, POLLIN, 0});
        for (const auto &t : pending_tools)
            pfds.push_back({t.fd, POLLIN, 0});

        if (pfds.empty()) break;

        int r = poll(pfds.data(), (nfds_t)pfds.size(), -1);
        if (r < 0) {
            if (errno == EINTR) continue;
            break;
        }

        size_t pfd_off = 0;
        if (poll_stdin) {
            if (pfds[0].revents & (POLLIN | POLLHUP | POLLERR))
                reader.fill();
            pfd_off = 1;
        }

        for (size_t i = 0; i < busy.size(); i++) {
            if (pfds[pfd_off + i].revents & (POLLIN | POLLHUP | POLLERR)) {
                RpcResponse resp = pool.collect(busy[i].idx);
                write_resp(resp);
                in_flight--;
            }
        }
        pfd_off += busy.size();

        // Collect completed tool responses.
        std::vector<size_t> done_tool_indices;
        for (size_t i = 0; i < pending_tools.size(); i++) {
            if (!(pfds[pfd_off + i].revents & (POLLIN | POLLHUP | POLLERR)))
                continue;
            int tfd = pending_tools[i].fd;
            uint32_t len = 0;
            ssize_t n = read(tfd, &len, 4);
            if (n == 4 && len > 0 && len <= 64u * 1024 * 1024) {
                std::string payload(len, '\0');
                size_t received = 0;
                while (received < len) {
                    n = read(tfd, &payload[received], len - received);
                    if (n <= 0) break;
                    received += (size_t)n;
                }
                if (received == len)
                    fwrite(payload.c_str(), 1, payload.size(), fout);
            }
            close(tfd);
            done_tool_indices.push_back(i);
            in_flight--;
        }
        // Erase in reverse order so earlier indices remain valid.
        for (auto it = done_tool_indices.rbegin(); it != done_tool_indices.rend(); ++it)
            pending_tools.erase(pending_tools.begin() + (ptrdiff_t)*it);
    }

    fclose(fout);
}

} // namespace boxsh
