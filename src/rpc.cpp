#include "rpc.h"
#include "file_type.h"
#include "image_resize.h"
#include "io_utils.h"
#include "sandbox.h"
#include "terminal.h"
#include "worker_pool.h"

#include <cerrno>
#include <climits>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

#include <nlohmann/json.hpp>

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#endif

using json = nlohmann::json;

namespace boxsh {

namespace {

constexpr uint32_t kMaxTransportMessageBytes = 64u * 1024u * 1024u;

// Truncate a UTF-8 string to at most max_bytes, never splitting a
// multi-byte character.  Returns the truncated string with "…" appended
// when truncation actually occurred.
static std::string utf8_safe_truncate(const std::string &s, size_t max_bytes) {
    if (s.size() <= max_bytes) return s;
    size_t i = 0;
    size_t last_valid = 0;
    while (i < s.size()) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        size_t clen;
        if ((c & 0x80) == 0)          clen = 1;
        else if ((c & 0xE0) == 0xC0)  clen = 2;
        else if ((c & 0xF0) == 0xE0)  clen = 3;
        else if ((c & 0xF8) == 0xF0)  clen = 4;
        else                          clen = 1; // invalid byte, treat as single

        if (i + clen > max_bytes) break;
        last_valid = i + clen;
        i += clen;
    }
    std::string result = s.substr(0, last_valid);
    result += "\xe2\x80\xa6"; // U+2026 HORIZONTAL ELLIPSIS "…"
    return result;
}

// Move pos backwards to the start of a UTF-8 sequence (never cuts a
// multi-byte character in half).
static size_t utf8_floor(const std::string &s, size_t pos) {
    if (pos >= s.size()) return s.size();
    while (pos > 0 && (static_cast<unsigned char>(s[pos]) & 0xC0) == 0x80)
        --pos;
    return pos;
}

// True when the buffer is valid UTF-8 (no invalid/overlong sequences, no
// stray continuation bytes).  Used to decide whether a file that looked like
// text can actually be returned as text.
static bool is_valid_utf8(const std::string &s) {
    size_t i = 0;
    while (i < s.size()) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        size_t n;
        if (c < 0x80)            n = 1;
        else if ((c & 0xE0) == 0xC0) n = 2;
        else if ((c & 0xF0) == 0xE0) n = 3;
        else if ((c & 0xF8) == 0xF0) n = 4;
        else return false;

        if (i + n > s.size()) return false;
        for (size_t k = 1; k < n; ++k) {
            if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80)
                return false;
        }
        // Reject overlong encodings and surrogate halves.
        if (n == 2 && c < 0xC2) return false;
        if (n == 3) {
            unsigned char c1 = static_cast<unsigned char>(s[i + 1]);
            if (c == 0xE0 && c1 < 0xA0) return false;
            if (c == 0xED && c1 >= 0xA0) return false;
        }
        if (n == 4) {
            unsigned char c1 = static_cast<unsigned char>(s[i + 1]);
            if (c == 0xF0 && c1 < 0x90) return false;
            if (c == 0xF4 && c1 >= 0x90) return false;
            if (c > 0xF4) return false;
        }
        i += n;
    }
    return true;
}

// Model-facing text budget for shell command output.  The structured payload
// keeps the full streams; only the readable text is reduced.
constexpr size_t kTextHeadBytes = 24u * 1024u;
constexpr size_t kTextTailBytes = 24u * 1024u;

// Set from a signal handler (SIGTERM/SIGINT/SIGHUP) to ask the RPC event loop
// for an orderly shutdown: stop reading requests, kill everything this
// process owns, exit.  Read/written across the signal boundary, so it is only
// ever touched through the two helpers below.
volatile sig_atomic_t g_shutdown_requested = 0;

// Reduce s to head_bytes + tail_bytes, snapping both cuts to line boundaries
// and joining the halves with a single marker line.
static std::string head_tail_reduce(const std::string &s,
                                    size_t head_bytes, size_t tail_bytes) {
    if (s.size() <= head_bytes + tail_bytes) return s;

    size_t head_end = utf8_floor(s, head_bytes);
    auto nl = s.rfind('\n', head_end);
    if (nl != std::string::npos && nl + 1 <= head_end) head_end = nl + 1;

    size_t tail_start = utf8_floor(s, s.size() - tail_bytes);
    auto nl2 = s.find('\n', tail_start);
    // Snap the tail to the next line start, but never let a single trailing
    // newline (or a line break late in the tail) collapse the tail to nothing.
    if (nl2 != std::string::npos && nl2 + 1 < s.size()) {
        size_t snapped = nl2 + 1;
        size_t tail_floor = s.size() - tail_bytes / 2;
        if (snapped <= tail_floor) tail_start = snapped;
    }

    if (tail_start <= head_end) tail_start = head_end; // degenerate inputs

    size_t omitted = tail_start - head_end;
    std::string marker = "\n\xe2\x80\xa6 [truncated: " +
        std::to_string(omitted) + " bytes of " + std::to_string(s.size()) +
        " omitted] \xe2\x80\xa6\n";
    return s.substr(0, head_end) + marker + s.substr(tail_start);
}

// Format a shell command result as model-facing text:
//   stdout (labelled when stderr follows) / [stderr] section / markers.
static std::string bash_result_text(int exit_code, const std::string &out,
                                    const std::string &err, bool timed_out,
                                    bool out_truncated, bool err_truncated,
                                    int timeout_sec = 0,
                                    bool timeout_from_default = false) {
    std::string body;
    if (!out.empty()) {
        if (!err.empty()) body += "[stdout]\n";
        body += out;
        if (body.back() != '\n') body += '\n';
    }
    if (!err.empty()) {
        body += "[stderr]\n";
        body += err;
        if (body.back() != '\n') body += '\n';
    }
    if (out_truncated) body += "[stdout truncated at 10 MiB by boxsh]\n";
    if (err_truncated) body += "[stderr truncated at 10 MiB by boxsh]\n";
    if (timed_out) {
        // Distinguish the server's safety-net timeout from a timeout the
        // caller asked for: only the former is worth retrying with `timeout`.
        // Both say what happened and how long it ran, so the two cases read the
        // same way instead of one being a bare marker.
        if (timeout_sec > 0 && timeout_from_default)
            body += "[timeout: killed after the server default of " +
                    std::to_string(timeout_sec) +
                    "s \xe2\x80\x94 pass `timeout` to allow a longer command]\n";
        else if (timeout_sec > 0)
            body += "[timeout: killed after " + std::to_string(timeout_sec) +
                    "s (the `timeout` this request passed)]\n";
        else
            body += "[timeout]\n";
    }
    if (exit_code != 0) body += "[exit code: " + std::to_string(exit_code) + "]\n";
    if (body.empty()) body = "(no output)\n";
    return head_tail_reduce(body, kTextHeadBytes, kTextTailBytes);
}

// Detect animation for the formats we decode: GIF frames and PNG (APNG acTL).
static bool image_is_animated(const std::string &raw, const std::string &mime);

// GIF frame count — a GIF is animated when it holds more than one image
// descriptor.  Parses block structure so pixel data cannot be mistaken for a
// descriptor.
static int gif_frame_count(const std::string &s) {
    if (s.size() < 13 || s.compare(0, 3, "GIF") != 0) return 0;
    size_t p = 6;                          // header
    unsigned char packed = static_cast<unsigned char>(s[p + 4]);
    p += 7;                                // logical screen descriptor
    if (packed & 0x80) p += 3u * (1u << ((packed & 0x07) + 1)); // global color table
    int frames = 0;
    auto skip_sub_blocks = [&](size_t &q) {
        while (q < s.size()) {
            size_t n = static_cast<unsigned char>(s[q++]);
            if (n == 0) return true;
            q += n;
        }
        return false;
    };
    while (p < s.size()) {
        unsigned char b = static_cast<unsigned char>(s[p]);
        if (b == 0x3B) break;              // trailer
        if (b == 0x21) {                   // extension
            p += 2;                        // introducer + label
            if (!skip_sub_blocks(p)) break;
        } else if (b == 0x2C) {            // image descriptor
            if (p + 10 > s.size()) break;
            ++frames;
            unsigned char lp = static_cast<unsigned char>(s[p + 9]);
            p += 10;
            if (lp & 0x80) p += 3u * (1u << ((lp & 0x07) + 1)); // local color table
            if (p >= s.size()) break;
            p += 1;                        // LZW minimum code size
            if (!skip_sub_blocks(p)) break;
        } else {
            break;                         // unknown block — stop parsing
        }
    }
    return frames;
}

// APNG: an acTL chunk appearing before IDAT marks an animated PNG.
static bool png_is_apng(const std::string &s) {
    if (s.size() < 8 || s.compare(0, 8, "\x89PNG\r\n\x1a\n") != 0) return false;
    size_t p = 8;
    while (p + 8 <= s.size()) {
        std::string type = s.substr(p + 4, 4);
        uint32_t len = (static_cast<unsigned char>(s[p]) << 24) |
                       (static_cast<unsigned char>(s[p + 1]) << 16) |
                       (static_cast<unsigned char>(s[p + 2]) << 8) |
                        static_cast<unsigned char>(s[p + 3]);
        if (type == "acTL") return true;
        if (type == "IDAT" || type == "IEND") return false;

        // Advance past this chunk (length + type + data + crc).  The length is
        // attacker-controlled: bail out instead of wrapping the offset (a
        // wrapped offset would spin forever in this loop).
        const size_t remaining = s.size() - p;
        if (remaining < 12u || len > remaining - 12u) break;
        p += 12u + static_cast<size_t>(len);
    }
    return false;
}

// WebP: a VP8X chunk with the ANIMATION flag set, or an ANIM chunk, marks an
// animated file.  Pure byte inspection, so it also works when the build has no
// WebP decoder.
static bool webp_is_animated(const std::string &s) {
    if (s.size() < 12 || s.compare(0, 4, "RIFF") != 0 ||
        s.compare(8, 4, "WEBP") != 0)
        return false;
    size_t p = 12;
    while (p + 8 <= s.size()) {
        uint32_t len = static_cast<unsigned char>(s[p + 4]) |
                       (static_cast<unsigned char>(s[p + 5]) << 8) |
                       (static_cast<unsigned char>(s[p + 6]) << 16) |
                       (static_cast<unsigned char>(s[p + 7]) << 24);
        if (s.compare(p, 4, "ANIM") == 0) return true;
        if (s.compare(p, 4, "VP8X") == 0 && len >= 10 && p + 10 <= s.size())
            return (static_cast<unsigned char>(s[p + 8]) & 0x02) != 0;
        if (s.compare(p, 4, "VP8 ") == 0 || s.compare(p, 4, "VP8L") == 0)
            return false;                  // still image data comes first

        // Advance past this chunk (id + length + even-padded payload).  The
        // length is attacker-controlled: bail out instead of wrapping the
        // offset (a wrapped offset would spin forever in this loop).
        const size_t remaining = s.size() - p;
        if (len > remaining - 8u) break;
        size_t adv = 8u + static_cast<size_t>(len);
        if ((len & 1u) != 0) {
            if (adv + 1u > remaining) break;
            adv += 1u;
        }
        p += adv;
    }
    return false;
}

static bool image_is_animated(const std::string &raw, const std::string &mime) {
    if (mime == "image/gif")  return gif_frame_count(raw) > 1;
    if (mime == "image/png")  return png_is_apng(raw);
    if (mime == "image/webp") return webp_is_animated(raw);
    return false;
}

// Image formats this build can decode (kept in sync with image_resize.cpp).
static std::string supported_image_formats() {
    return "png, jpeg, gif, bmp, tiff"
#ifdef BOXSH_HAVE_WEBP
           ", webp"
#endif
        ;
}

// MIME types this build can actually decode.  Drives the "corrupt file" vs
// "format not in the decode set" distinction in view_image errors
// (contract §2.3): both keep E_UNSUPPORTED_FORMAT, only the former gets
// detail.reason = "decode_failed".
static bool mime_is_decodable(const std::string &mime) {
    static const char *const kMimes[] = {
        "image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff",
#ifdef BOXSH_HAVE_WEBP
        "image/webp",
#endif
        nullptr
    };
    for (int i = 0; kMimes[i]; ++i)
        if (mime == kMimes[i]) return true;
    return false;
}

// Formats multimodal models ingest natively.  view_image may return these
// as-is (re-encoded only when the source is animated); every other decodable
// format (bmp, tiff, …) is converted to PNG/JPEG so the client model can
// actually see the image.
static bool mime_is_model_native(const std::string &mime) {
    return mime == "image/jpeg" || mime == "image/png" ||
           mime == "image/gif"  || mime == "image/webp";
}

} // namespace

// ---------------------------------------------------------------------------
// Orderly shutdown
// ---------------------------------------------------------------------------

// Async-signal-safe: assigns the flag and nothing else.
void rpc_request_shutdown() {
    g_shutdown_requested = 1;
}

bool rpc_shutdown_requested() {
    return g_shutdown_requested != 0;
}

// Convenience constructor for a failed tool result.
ToolResult tool_error_result(const std::string &code,
                             const std::string &message,
                             std::optional<json> detail) {
    ToolResult tr;
    tr.error = ToolError{code, message, std::move(detail)};
    tr.text  = code + ": " + message;
    return tr;
}

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

    // JSON-RPC 2.0: preserve id exactly (string, number, or null).
    if (j.contains("id"))
        req.id = j["id"];

    // JSON-RPC 2.0: require "method" field.
    if (!j.contains("method") || !j["method"].is_string()) {
        parse_error = "missing or non-string field: method";
        return false;
    }
    const std::string method = j["method"].get<std::string>();

    // Extract params (default to empty object).
    const json params = j.contains("params") && j["params"].is_object()
        ? j["params"] : json::object();

    // MCP protocol methods: initialize, tools/list — handled synchronously.
    if (method == "initialize" || method == "tools/list") {
        req.cmd = method;        // sentinel: handled in event loop
        req.tool = ToolKind::None;
        req.timeout_sec = -1;    // flag for protocol methods
        // Stash client protocolVersion for initialize response.
        if (method == "initialize" && params.contains("protocolVersion")
            && params["protocolVersion"].is_string()) {
            req.sandbox_json_raw = params["protocolVersion"].get<std::string>();
        }
        return true;
    }

    // MCP notifications: no response needed, and per the spec a notification
    // never gets one - answering is what used to make clients log schema errors
    // ({"id":null} is neither a request id nor valid for a response).
    if (method.rfind("notifications/", 0) == 0) {
        req.cmd  = method;
        req.tool = ToolKind::None;
        req.timeout_sec = -2;    // flag for notifications
        if (method == "notifications/cancelled") {
            // The client gave up on a request (SDK: request timeout).  Acting on
            // it is what stops the command instead of letting it run until the
            // server-side default timeout.
            if (params.contains("requestId"))
                req.cancel_id   = params["requestId"];
            req.timeout_sec = -3; // flag for cancellation
        }
        return true;
    }

    // MCP tools/call: dispatch to the named tool.
    if (method == "tools/call") {
        if (!params.contains("name") || !params["name"].is_string()) {
            parse_error = "tools/call missing string field: params.name";
            return false;
        }
        const std::string tool_name = params["name"].get<std::string>();
        const json args = params.contains("arguments") && params["arguments"].is_object()
            ? params["arguments"] : json::object();

        if (tool_name == "bash") {
            if (!args.contains("command") || !args["command"].is_string()) {
                parse_error = "bash tool missing string field: command";
                return false;
            }
            req.cmd = args["command"].get<std::string>();
            if (args.contains("timeout")) {
                if (!args["timeout"].is_number() || args["timeout"].get<double>() < 0) {
                    parse_error = "bash tool timeout must be a non-negative number of seconds";
                    return false;
                }
                req.timeout_sec = (int)args["timeout"].get<double>();
            }
            return true;
        }
        if (tool_name == "read" || tool_name == "write" || tool_name == "edit") {
            if (!args.contains("path") || !args["path"].is_string()) {
                parse_error = tool_name + " tool missing string field: path";
                return false;
            }
            req.path = args["path"].get<std::string>();
            // An empty path is a caller mistake, not a missing file: report it
            // through the same channel as offset/limit (contract §2.2).
            if (req.path.empty()) {
                parse_error = tool_name + " tool path must not be empty";
                return false;
            }

            if (tool_name == "read") {
                req.tool = ToolKind::Read;
                if (args.contains("offset")) {
                    if (!args["offset"].is_number_integer() ||
                        args["offset"].get<int>() < 1) {
                        parse_error = "read tool offset must be an integer >= 1";
                        return false;
                    }
                    req.offset = args["offset"].get<int>();
                }
                if (args.contains("limit")) {
                    if (!args["limit"].is_number_integer() ||
                        args["limit"].get<int>() < 1) {
                        parse_error = "read tool limit must be an integer >= 1";
                        return false;
                    }
                    req.limit = args["limit"].get<int>();
                }
            } else if (tool_name == "write") {
                req.tool = ToolKind::Write;
                if (!args.contains("content") || !args["content"].is_string()) {
                    parse_error = "write tool missing string field: content";
                    return false;
                }
                req.content = args["content"].get<std::string>();
                if (args.contains("encoding") && args["encoding"].is_string()) {
                    std::string enc = args["encoding"].get<std::string>();
                    if (enc != "text" && enc != "base64") {
                        parse_error = "write tool encoding must be 'text' or 'base64'";
                        return false;
                    }
                    req.encoding = enc;
                }
            } else { // edit
                req.tool = ToolKind::Edit;
                if (!args.contains("edits") || !args["edits"].is_array()) {
                    parse_error = "edit tool missing array field: edits";
                    return false;
                }
                for (const auto &op : args["edits"]) {
                    if (!op.contains("oldText") || !op["oldText"].is_string() ||
                        !op.contains("newText") || !op["newText"].is_string()) {
                        parse_error = "each edit must have string fields oldText and newText";
                        return false;
                    }
                    req.edits.push_back({op["oldText"].get<std::string>(),
                                         op["newText"].get<std::string>()});
                }
            }
            return true;
        }
        if (tool_name == "view_image") {
            req.tool = ToolKind::ViewImage;
            if (!args.contains("path") || !args["path"].is_string()) {
                parse_error = "view_image tool missing string field: path";
                return false;
            }
            req.path = args["path"].get<std::string>();
            if (req.path.empty()) {
                parse_error = "view_image tool path must not be empty";
                return false;
            }
            if (args.contains("detail")) {
                if (!args["detail"].is_string()) {
                    parse_error = "view_image detail must be a string";
                    return false;
                }
                std::string detail = args["detail"].get<std::string>();
                if (detail != "auto" && detail != "low") {
                    parse_error = "view_image detail must be 'auto' or 'low'";
                    return false;
                }
                req.image_detail = detail;
            }
            return true;
        }
        // Terminal tools
        //
        // Shared optional arguments (all of them also accepted by
        // send_to_terminal / get_terminal_output):
        //   wait_ms N      how long to wait before returning (default 500)
        //   wait_for S     "output" (default) | "exit" | "none"
        auto parse_terminal_read_opts = [&](std::string &what) -> bool {
            if (args.contains("wait_ms")) {
                if (!args["wait_ms"].is_number_integer() && !args["wait_ms"].is_number_unsigned()) {
                    what = "wait_ms must be an integer";
                    return false;
                }
                long long v = args["wait_ms"].get<long long>();
                if (v < 0 || v > 600000) {
                    what = "wait_ms must be between 0 and 600000";
                    return false;
                }
                req.terminal_wait_ms = (int)v;
            }
            if (args.contains("wait_for")) {
                if (!args["wait_for"].is_string()) {
                    what = "wait_for must be a string";
                    return false;
                }
                std::string w = args["wait_for"].get<std::string>();
                if (w != "output" && w != "exit" && w != "none") {
                    what = "wait_for must be \"output\", \"exit\" or \"none\"";
                    return false;
                }
                req.terminal_wait_for = w;
            }
            if (args.contains("cursor")) {
                if (!args["cursor"].is_number_unsigned() && !args["cursor"].is_number_integer()) {
                    what = "cursor must be a non-negative integer";
                    return false;
                }
                long long v = args["cursor"].get<long long>();
                if (v < 0) {
                    what = "cursor must be a non-negative integer";
                    return false;
                }
                req.terminal_cursor = (uint64_t)v;
            }
            return true;
        };

        if (tool_name == "run_in_terminal") {
            req.tool = ToolKind::TerminalRun;
            if (!args.contains("command") || !args["command"].is_string()) {
                req.arg_error = "run_in_terminal: missing string field: command";
                return true;
            }
            req.terminal_command = args["command"].get<std::string>();
            if (args.contains("cols")) {
                if (!args["cols"].is_number()) {
                    req.arg_error = "run_in_terminal: cols must be a number";
                    return true;
                }
                req.terminal_cols = args["cols"].get<int>();
                if (req.terminal_cols < 20 || req.terminal_cols > 1000) {
                    req.arg_error = "run_in_terminal: cols must be between 20 and 1000";
                    return true;
                }
            }
            if (args.contains("rows")) {
                if (!args["rows"].is_number()) {
                    req.arg_error = "run_in_terminal: rows must be a number";
                    return true;
                }
                req.terminal_rows = args["rows"].get<int>();
                if (req.terminal_rows < 1 || req.terminal_rows > 1000) {
                    req.arg_error = "run_in_terminal: rows must be between 1 and 1000";
                    return true;
                }
            }
            std::string what;
            if (!parse_terminal_read_opts(what)) {
                req.arg_error = "run_in_terminal: " + what;
                return true;
            }
            return true;
        }
        if (tool_name == "send_to_terminal") {
            req.tool = ToolKind::TerminalSend;
            if (!args.contains("id") || !args["id"].is_string()) {
                req.arg_error = "send_to_terminal: missing string field: id";
                return true;
            }
            req.session_id = args["id"].get<std::string>();
            if (args.contains("signal")) {
                if (!args["signal"].is_string()) {
                    req.arg_error = "send_to_terminal: signal must be a string";
                    return true;
                }
                req.terminal_signal = args["signal"].get<std::string>();
            }
            if (args.contains("command")) {
                if (!args["command"].is_string()) {
                    req.arg_error = "send_to_terminal: command must be a string";
                    return true;
                }
                req.terminal_command = args["command"].get<std::string>();
            } else if (req.terminal_signal.empty()) {
                req.arg_error = "send_to_terminal: needs a `command` to write or a `signal` to send";
                return true;
            }
            if (args.contains("capture_status")) {
                if (!args["capture_status"].is_boolean()) {
                    req.arg_error = "send_to_terminal: capture_status must be a boolean";
                    return true;
                }
                req.terminal_capture_status = args["capture_status"].get<bool>();
            }
            std::string what;
            if (!parse_terminal_read_opts(what)) {
                req.arg_error = "send_to_terminal: " + what;
                return true;
            }
            return true;
        }
        if (tool_name == "get_terminal_output") {
            req.tool = ToolKind::TerminalOutput;
            if (!args.contains("id") || !args["id"].is_string()) {
                req.arg_error = "get_terminal_output: missing string field: id";
                return true;
            }
            req.session_id = args["id"].get<std::string>();
            std::string what;
            if (!parse_terminal_read_opts(what)) {
                req.arg_error = "get_terminal_output: " + what;
                return true;
            }
            return true;
        }
        if (tool_name == "kill_terminal") {
            req.tool = ToolKind::TerminalKill;
            if (!args.contains("id") || !args["id"].is_string()) {
                req.arg_error = "kill_terminal: missing string field: id";
                return true;
            }
            req.session_id = args["id"].get<std::string>();
            if (args.contains("cursor")) {
                if (!args["cursor"].is_number_unsigned() && !args["cursor"].is_number_integer()) {
                    req.arg_error = "kill_terminal: cursor must be a non-negative integer";
                    return true;
                }
                long long v = args["cursor"].get<long long>();
                if (v < 0) {
                    req.arg_error = "kill_terminal: cursor must be a non-negative integer";
                    return true;
                }
                req.terminal_cursor = (uint64_t)v;
            }
            return true;
        }
        if (tool_name == "list_terminals") {
            req.tool = ToolKind::TerminalList;
            if (args.contains("include_exited")) {
                if (!args["include_exited"].is_boolean()) {
                    req.arg_error = "list_terminals: include_exited must be a boolean";
                    return true;
                }
                req.terminal_include_exited = args["include_exited"].get<bool>();
            }
            return true;
        }

        parse_error = "unknown tool: " + tool_name;
        return false;
    }

    parse_error = "unknown method: " + method;
    return false;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

namespace {

// Sanitize the id: if the request carried a string id with invalid UTF-8,
// nlohmann::json::dump() will throw type_error.316.
json safe_id_value(const json &id) {
    json safe_id = id;
    if (safe_id.is_string())
        safe_id = ensure_valid_utf8(safe_id.get<std::string>());
    return safe_id;
}

// ---------------------------------------------------------------------------
// Result budget
//
// A client's stdio read buffer is a hard wall: the official MCP SDK keeps 10 MiB
// (STDIO_DEFAULT_MAX_BUFFER_SIZE) and, on overflow, clears the buffer *and*
// closes the transport - every later request then fails with "Not connected".
// So the guarantee has to be about the JSON that actually goes out, not about
// the raw output behind it: JSON escaping turns a NUL byte into "\u0000" (six
// bytes) and doubles quotes and backslashes, so 2 MB of binary output becomes a
// 12 MB message while 8 MB of plain text stays under 10 MB.
//
// escaped_len() mirrors nlohmann's compact dump() (ensure_ascii == false)
// exactly, which is what lets a payload be sized without serializing it:
//   \b \t \n \f \r \" \\ -> 2 bytes each;  other C0 controls -> \u00xx (6)
//   everything else (0x7F, valid UTF-8) -> copied verbatim
// tests/result-budget.test.mjs checks the outcome (fits the budget, both ends
// intact) against payloads built to hit every one of those cases.
// ---------------------------------------------------------------------------

size_t escaped_len(const char *data, size_t n) {
    size_t len = 0;
    for (size_t i = 0; i < n; ++i) {
        const unsigned char c = static_cast<unsigned char>(data[i]);
        switch (c) {
            case 0x08: case 0x09: case 0x0A: case 0x0C: case 0x0D:
            case 0x22: case 0x5C:
                len += 2;
                break;
            default:
                len += (c <= 0x1F) ? 6 : 1;
                break;
        }
    }
    return len;
}

size_t escaped_len(const std::string &s) { return escaped_len(s.data(), s.size()); }

// How many raw bytes fit in `budget` encoded bytes, walking from `from` in
// `dir` (+1 forwards, -1 backwards) and never crossing `limit`.  Backwards walks
// step over whole UTF-8 sequences so a multi-byte character is never split in
// half (every byte of one is copied verbatim, so escaping a sequence is just its
// length).
size_t fit_raw_bytes(const std::string &raw, size_t from, int dir, size_t budget,
                     size_t limit) {
    size_t used = 0, pos = from;
    while (true) {
        if (dir > 0) {
            if (pos >= limit) break;
            size_t add = escaped_len(raw.data() + pos, 1);
            if (used + add > budget) break;
            used += add;
            pos++;
        } else {
            if (pos <= limit) break;
            size_t p = pos - 1;
            while (p > limit && (static_cast<unsigned char>(raw[p]) & 0xC0) == 0x80) p--;
            size_t add = escaped_len(raw.data() + p, pos - p);
            if (used + add > budget) break;
            used += add;
            pos = p;
        }
    }
    return dir > 0 ? pos - from : from - pos;
}

// Cut `raw` down to `budget` *encoded* bytes, keeping both ends: what the
// command printed first and what it printed last (where the error usually is).
struct TrimmedValue {
    std::string data;
    size_t      dropped_raw_bytes = 0;
    bool        trimmed           = false;
};

TrimmedValue trim_to_encoded_budget(const std::string &raw, size_t budget) {
    TrimmedValue out;
    if (budget == 0 || escaped_len(raw) <= budget) {
        out.data = raw;
        return out;
    }
    out.trimmed = true;

    size_t head_len = fit_raw_bytes(raw, 0, +1, budget / 2, raw.size());
    size_t tail_len = fit_raw_bytes(raw, raw.size(), -1, budget - budget / 2,
                                    head_len);

    // Text: snap both cuts to line boundaries (inward only, so the budget still
    // holds) - half a line at either end reads like corruption.
    auto looks_like_text = [&]() {
        size_t probe = std::min<size_t>(raw.size(), 4096), printable = 0;
        for (size_t i = 0; i < probe; ++i) {
            unsigned char c = static_cast<unsigned char>(raw[i]);
            if (c == '\n' || c == '\t' || (c >= 0x20 && c != 0x7F)) printable++;
        }
        return probe > 0 && printable * 10 >= probe * 9;
    };
    if (looks_like_text()) {
        const size_t window = 512;
        for (size_t back = head_len; back > 0 && head_len - back < window; back--) {
            if (raw[back - 1] == '\n') { head_len = back; break; }
        }
        size_t tail_start = raw.size() - tail_len;
        const size_t limit = head_len > 0 ? head_len : 0;
        size_t fwd = tail_start, stop = std::min(raw.size(), tail_start + window);
        while (fwd < stop) {
            if (raw[fwd] == '\n' && fwd + 1 > limit) { tail_start = fwd + 1; break; }
            fwd++;
        }
        tail_len = raw.size() - tail_start;
        if (head_len + tail_len > raw.size()) {
            head_len = raw.size();
            tail_len = 0;
        }
    }

    const size_t head_end   = head_len;
    const size_t tail_start = raw.size() - tail_len;
    out.dropped_raw_bytes   = raw.size() - head_len - tail_len;
    out.data = raw.substr(0, head_end) +
               "\n\xe2\x80\xa6 [truncated: " + std::to_string(out.dropped_raw_bytes) +
               " of " + std::to_string(raw.size()) +
               " bytes omitted to fit the result budget] \xe2\x80\xa6\n" +
               (tail_len ? raw.substr(tail_start) : std::string());
    return out;
}

size_t g_result_budget = 8u * 1024u * 1024u; // --max-result-bytes (0 = unlimited)

// Percentage of the budget kept free so the bookkeeping around the payloads
// (content blocks, isError, an id, transport framing) cannot push the message
// over the edge, and so a client that buffers one more chunk still fits.
constexpr size_t kResultBudgetSlack = 32u * 1024u;

// Enforce the result budget on an already-built message.
//
// Candidates are cut in a defined order and never silently: the model-facing
// text first (a model can live with a shorter preview), then the payload fields
// the tool declared trimmable (bash stdout/stderr, terminal stream).  Small
// ones are kept whole - a 300 KiB text is not worth cutting to make room for a
// 12 MB payload - and the big ones share what is left in proportion to their
// size.  Fields are never *corrupted*: a value either fits or is cut with a
// marker.  Images are not trimmed (half an image is worthless), so a result that
// cannot carry one is reported as a tool failure instead.
void enforce_result_budget(json &j, const std::vector<std::string> &fields,
                           const std::vector<ImagePart> &images) {
    const size_t budget = g_result_budget;
    if (budget == 0) return;
    if (!j.contains("result") || !j["result"].is_object()) return;
    json &result = j["result"];

    std::string *text = nullptr;
    if (result.contains("content") && result["content"].is_array() &&
        !result["content"].empty() && result["content"][0].is_object() &&
        result["content"][0].contains("text") && result["content"][0]["text"].is_string()) {
        text = &result["content"][0]["text"].get_ref<std::string &>();
    }
    json *sc = (result.contains("structuredContent") &&
                result["structuredContent"].is_object())
                   ? &result["structuredContent"] : nullptr;

    struct Candidate {
        std::string  name;   // "" for the text block
        std::string *value;
        bool         small = false;
    };
    std::vector<Candidate> cands;
    if (text) cands.push_back({"", text, false});
    for (const auto &f : fields) {
        if (sc && sc->contains(f) && (*sc)[f].is_string())
            cands.push_back({f, &(*sc)[f].get_ref<std::string &>(), false});
    }
    if (cands.empty()) return;

    // Size the message without serializing it: an empty string costs 2 bytes,
    // and every candidate contributes its exact escaped length.
    json probe = j;
    {
        json &pr = probe["result"];
        if (text) pr["content"][0]["text"] = "";
        for (const auto &c : cands) {
            if (!c.name.empty()) pr["structuredContent"][c.name] = "";
        }
    }
    const size_t base = probe.dump().size();
    size_t payload_esc = 0;
    for (const auto &c : cands) payload_esc += escaped_len(*c.value);
    const size_t total = base + payload_esc - 2 * cands.size();
    if (total <= budget) return;                  // fits: nothing to do

    if (base >= budget) {
        // Even the empty envelope does not fit (a tiny budget, a huge id).
        // Say so instead of sending something that would break the client.
        json minimal;
        minimal["jsonrpc"] = "2.0";
        minimal["id"]      = j.value("id", json(nullptr));
        minimal["result"]  = json::object();
        minimal["result"]["content"] = json::array();
        minimal["result"]["content"].push_back({{"type", "text"},
            {"text", std::string(error_code::kTooLarge) +
                     ": result exceeds the " + std::to_string(budget) +
                     "-byte result budget before any payload was added "
                     "(raise --max-result-bytes)"}});
        minimal["result"]["structuredContent"] = {
            {"code", error_code::kTooLarge},
            {"message", "result envelope exceeds the " + std::to_string(budget) +
                        "-byte result budget"}};
        minimal["result"]["isError"] = true;
        j = std::move(minimal);
        return;
    }

    // Slack so the bookkeeping around the payloads (content blocks, isError, an
    // id, transport framing) cannot push the message over the edge, and so a
    // client that buffers one more chunk still fits.  Scaled for small budgets,
    // where a fixed 32 KiB would waste half of it.
    const size_t slack     = std::min(kResultBudgetSlack, budget / 8);
    const size_t available = budget - base > slack ? budget - base - slack
                                                   : budget - base;

    // The model-facing text comes first: a legacy client that only forwards
    // content[0].text must still see a usable preview, so it keeps a quarter of
    // the budget before the payloads compete for the rest.
    size_t text_keep = 0;
    if (text) {
        const size_t e = escaped_len(*text);
        text_keep = std::min(e, available / 4);
    }

    // Payloads: the small ones are kept whole (cutting a 2 KB stderr to make
    // room for a 12 MB stdout would be silly), the big ones share what is left
    // in proportion to their size.
    const size_t rest       = available - text_keep;
    const size_t small_limit = rest / 8;
    size_t kept = text_keep, big_total = 0;
    for (auto &c : cands) {
        if (c.name.empty()) continue;            // text, counted above
        const size_t e = escaped_len(*c.value);
        c.small = e <= small_limit;
        if (c.small) kept += e;
        else         big_total += e;
    }
    if (kept > available) {                      // everything small, still too much
        for (auto &c : cands) c.small = false;
        kept = text_keep;
        big_total = 0;
        for (const auto &c : cands)
            if (!c.name.empty()) big_total += escaped_len(*c.value);
    }
    const size_t pool = available > kept ? available - kept : 0;

    size_t dropped_total = 0;
    bool   any = false;
    for (auto &c : cands) {
        const size_t e = escaped_len(*c.value);
        const size_t share = c.name.empty()
                                 ? text_keep
                                 : (c.small ? e
                                            : (big_total ? (size_t)((double)pool *
                                                               ((double)e / (double)big_total))
                                                         : 0));
        TrimmedValue t = trim_to_encoded_budget(*c.value, share);
        if (!t.trimmed) continue;
        any = true;
        dropped_total += t.dropped_raw_bytes;
        *c.value = t.data;
        if (c.name.empty()) continue;               // text is self-describing
        if (sc) {
            (*sc)[c.name + "_truncated"]       = true;
            (*sc)[c.name + "_dropped_bytes"]   = t.dropped_raw_bytes;
        }
    }
    if (!any) return;

    if (sc) {
        (*sc)["result_truncated"]     = true;
        (*sc)["result_dropped_bytes"] = dropped_total;
        (*sc)["result_budget_bytes"]  = budget;
    }
    if (text) {
        *text += "[result truncated: " + std::to_string(dropped_total) +
                 " bytes dropped to fit the " + std::to_string(budget) +
                 "-byte result budget (--max-result-bytes)]\n";
    }

    if (j.dump().size() > budget) {
        // Should not happen (slack + proportional shares), but never emit a
        // message that could take the client's transport down with it.
        for (auto &c : cands)
            if (!c.name.empty()) *c.value = "";
    }
}

} // namespace

void rpc_set_result_budget(size_t encoded_bytes) { g_result_budget = encoded_bytes; }
size_t rpc_result_budget() { return g_result_budget; }

// Build the unified result for a shell command (bash tool).
ToolResult tool_result_from_bash(const RpcResponse &resp) {
    std::string out = ensure_valid_utf8(resp.stdout_data);
    std::string err = ensure_valid_utf8(resp.stderr_data);

    ToolResult tr;
    tr.text = bash_result_text(resp.exit_code, out, err, resp.timed_out,
                               resp.stdout_truncated, resp.stderr_truncated,
                               resp.timeout_sec,
                               resp.timeout_from_server_default);
    tr.trimmable_fields = {"stdout", "stderr"};

    json sc = {
        {"exit_code",   resp.exit_code},
        {"stdout",      out},
        {"stderr",      err},
        {"duration_ms", resp.duration_ms}
    };
    if (resp.stdout_truncated) sc["stdout_truncated"] = true;
    if (resp.stderr_truncated) sc["stderr_truncated"] = true;
    if (resp.timed_out) {
        sc["timed_out"] = true;
        if (resp.timeout_sec > 0) {
            sc["timeout_sec"] = resp.timeout_sec;
            sc["timeout_source"] = resp.timeout_from_server_default
                                   ? "server_default" : "request";
        }
    }
    tr.structured = std::move(sc);
    return tr;
}

std::string rpc_serialize_tool_result(const json &id, const ToolResult &tr,
                                      bool is_error) {
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = safe_id_value(id);

    json result;

    if (tr.error.has_value()) {
        // Tool failure: isError + readable text + {code, message, detail?}.
        const ToolError &e = tr.error.value();
        std::string text = e.code + ": " + e.message;
        result["content"] = json::array({{{"type", "text"},
            {"text", ensure_valid_utf8(text)}}});
        json sc = {{"code", e.code}, {"message", ensure_valid_utf8(e.message)}};
        if (e.detail.has_value()) sc["detail"] = e.detail.value();
        result["structuredContent"] = std::move(sc);
        result["isError"] = true;
    } else {
        json content = json::array();
        content.push_back({{"type", "text"},
            {"text", ensure_valid_utf8(tr.text.value_or(std::string()))}});
        for (const auto &img : tr.images) {
            content.push_back({{"type", "image"}, {"data", img.data},
                               {"mimeType", img.mime_type}});
        }
        result["content"] = std::move(content);
        if (tr.structured.has_value())
            result["structuredContent"] = tr.structured.value();
        if (is_error)
            result["isError"] = true;
    }

    j["result"] = std::move(result);
    enforce_result_budget(j, tr.trimmable_fields, tr.images);
    return j.dump();
}

std::string rpc_serialize_response(const RpcResponse &resp) {
    // JSON-RPC 2.0 protocol error (parse error, unknown method, etc.).
    if (resp.is_protocol_error && !resp.error.empty()) {
        json j;
        j["jsonrpc"] = "2.0";
        j["id"] = safe_id_value(resp.id);
        j["error"] = {{"code", resp.error_code},
                      {"message", ensure_valid_utf8(resp.error)}};
        return j.dump();
    }

    // Shell command result (bash) — every other tool goes through
    // rpc_serialize_tool_result().
    if (!resp.error.empty())
        return rpc_serialize_tool_result(
            resp.id,
            tool_error_result(error_code::kInternal, resp.error),
            /*is_error=*/true);

    return rpc_serialize_tool_result(resp.id, tool_result_from_bash(resp),
                                     /*is_error=*/resp.exit_code != 0);
}

static std::string mcp_initialize_response(const json &id,
                                            const std::string &client_version) {
    // Protocol version negotiation (README.md "MCP server"):
    //  - client sent nothing        → our baseline (2025-06-18, the revision
    //                                  that standardizes structuredContent)
    //  - client sent a known older
    //    revision                   → echo it back, the added result fields
    //                                  (structuredContent/outputSchema) are
    //                                  additive and ignored by old clients
    //  - anything else              → our baseline
    static const char *kBaselineVersion = "2025-06-18";
    static const char *kLegacyVersions[] = {
        "2024-10-07", "2024-11-05", "2025-03-26"
    };
    std::string version = kBaselineVersion;
    for (const char *legacy : kLegacyVersions) {
        if (client_version == legacy) { version = legacy; break; }
    }

    // Sanitize id in case it contains invalid UTF-8.
    json safe_id = id;
    if (safe_id.is_string())
        safe_id = ensure_valid_utf8(safe_id.get<std::string>());

    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = safe_id;
    j["result"] = {
        {"protocolVersion", version},
        {"capabilities", {
            // The tool list is static (compiled in), so no
            // notifications/tools/list_changed is ever sent; restart the
            // server to pick up new tool definitions.
            {"tools", {{"listChanged", false}}}
        }},
        {"serverInfo", {
            {"name", "boxsh"},
            {"version", BOXSH_VERSION}
        }}
    };
    return j.dump();
}

static std::string mcp_tools_list_response(const json &id,
                                           int default_command_timeout) {
    json tools = json::array();

    // Shared outputSchema for the terminal tools: the rendered screen plus the
    // session's live/exited state, and — when the caller reads the raw-log
    // channel (cursor / wait_for:"exit" / capture_status) — the byte delta.
    auto terminal_output_schema = []() {
        return json{
            {"type", "object"},
            {"properties", {
                {"id",        {{"type", "string"},  {"description", "Terminal session id"}}},
                {"output",    {{"type", "string"},  {"description", "Rendered screen snapshot (a view of the last `rows` lines)"}}},
                {"exited",    {{"type", "boolean"}, {"description", "Whether the process has exited"}}},
                {"exit_code", {{"type", json::array({"integer", "null"})},
                               {"description", "Exit code when exited, null while it is still running"}}},
                {"total_bytes", {{"type", "integer"}, {"description", "Raw bytes received from the PTY since the session started"}}},
                {"screen_partial", {{"type", "boolean"}, {"description", "The session produced more lines than the screen shows, so `output` is a partial view — read the stream for everything"}}},
                {"stream",    {{"type", "string"},  {"description", "Raw output bytes (escape sequences included) received since the previous read or the given cursor"}}},
                {"first_cursor", {{"type", "integer"}, {"description", "Cursor the returned stream starts at"}}},
                {"next_cursor",  {{"type", "integer"}, {"description", "Pass as `cursor` to read only what comes after this result"}}},
                {"truncated_before", {{"type", "boolean"}, {"description", "Bytes before first_cursor were dropped from the log and cannot be recovered"}}},
                {"dropped_bytes", {{"type", "integer"}, {"description", "Bytes dropped from the front of the raw log so far"}}},
                {"result_truncated", {{"type", "boolean"}, {"description", "The payload was cut to fit the result budget (--max-result-bytes)"}}},
                {"result_dropped_bytes", {{"type", "integer"}, {"description", "Raw bytes dropped to fit the result budget"}}},
                {"result_budget_bytes", {{"type", "integer"}, {"description", "Budget that was in force when the payload was cut"}}},
                {"command_exit_code", {{"type", "integer"}, {"description", "Exit code of the command just submitted (capture_status only)"}}}
            }},
            {"required", json::array({"id", "output", "exited", "exit_code"})}
        };
    };

    // Options every terminal read accepts.
    auto terminal_read_args = [](json props) {
        props["wait_ms"]  = {{"type", "number"},
            {"description", "How long to wait before returning, in ms (default 500; up to 600000). With wait_for=\"exit\" or capture_status the default is 60000."}};
        props["wait_for"] = {{"type", "string"}, {"enum", json::array({"output", "exit", "none"})},
            {"description", "What to wait for: \"output\" (default; new output, then until it settles), \"exit\" (the process exits; also returns the complete raw stream), \"none\" (return immediately)."}};
        return props;
    };

    // bash tool
    std::string bash_desc =
        "Execute a shell command in the sandbox. Returns the exit code plus the "
        "command's stdout and stderr (each capped at 10 MiB). ";
    if (default_command_timeout > 0) {
        bash_desc += "Commands are killed after " +
                     std::to_string(default_command_timeout) +
                     " seconds by default (server-side safety net); pass a larger "
                     "`timeout` for commands that legitimately run longer "
                     "(builds, test suites, downloads). `timeout: 0` means \"use "
                     "the server default\". ";
    } else {
        bash_desc += "Pass `timeout` to kill the command after N seconds. ";
    }
    bash_desc +=
        "For large output, narrow the command (head/tail/grep/sed) instead of "
        "relying on truncation.";
    tools.push_back({
        {"name", "bash"},
        {"title", "Bash"},
        {"description", bash_desc},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"command", {{"type", "string"}, {"description", "Bash command to execute"}}},
                {"timeout", {{"type", "number"}, {"description", "Timeout in seconds (optional; overrides the server default, 0 = use the server default)"}}}
            }},
            {"required", json::array({"command"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"exit_code", {{ "type", "integer"}, {"description", "Process exit code (0 = success; -1 when timed out or killed)"}}},
                {"stdout",    {{ "type", "string"},  {"description", "Standard output (up to 10 MiB)"}}},
                {"stderr",    {{ "type", "string"},  {"description", "Standard error (up to 10 MiB)"}}},
                {"duration_ms", { {"type", "integer"}, {"description", "Wall-clock execution time in milliseconds"}}},
                {"stdout_truncated", { {"type", "boolean"}, {"description", "stdout lost bytes: the 10 MiB stream cap or the result budget cut it, and the text says which"}}},
                {"stderr_truncated", { {"type", "boolean"}, {"description", "stderr lost bytes: the 10 MiB stream cap or the result budget cut it"}}},
                {"stdout_dropped_bytes", { {"type", "integer"}, {"description", "Raw stdout bytes dropped to fit the result budget"}}},
                {"stderr_dropped_bytes", { {"type", "integer"}, {"description", "Raw stderr bytes dropped to fit the result budget"}}},
                {"result_truncated", { {"type", "boolean"}, {"description", "The result was cut to fit the result budget (--max-result-bytes)"}}},
                {"result_dropped_bytes", { {"type", "integer"}, {"description", "Raw bytes dropped to fit the result budget"}}},
                {"result_budget_bytes", { {"type", "integer"}, {"description", "Budget that was in force when the result was cut"}}},
                {"timed_out", { {"type", "boolean"}, {"description", "The command was killed after its timeout expired"}}},
                {"timeout_sec", { {"type", "integer"}, {"description", "Timeout that was in force when the command was killed (only with timed_out)"}}},
                {"timeout_source", { {"type", "string"}, {"enum", json::array({"request", "server_default"})},
                                     {"description", "Whether that timeout came from the request or from the server default (only with timed_out)"}}}
            }},
            {"required", json::array({"exit_code", "stdout", "stderr", "duration_ms"})}
        }},
        {"annotations", {
            {"title", "Bash"},
            {"readOnlyHint", false},
            {"destructiveHint", true}
        }}
    });

    // read tool — text files only (images go to view_image).
    tools.push_back({
        {"name", "read"},
        {"title", "Read File"},
        {"description",
         "Read a text file. Returns the file's text, capped at 2000 lines or 50 KiB "
         "per call; use offset/limit to page through larger files. Binary files "
         "(including images) cannot be read as text and return an error — use "
         "view_image for images and bash (file/xxd/strings) for other binaries. "
         "Targets must be regular files: FIFOs and sockets are rejected. An empty "
         "result explains itself through empty_reason."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"minLength", 1}, {"description", "Path to the file to read (relative or absolute)"}}},
                {"offset", {{"type", "number"}, {"description", "Line number to start reading from (1-indexed, default 1)"}}},
                {"limit", {{"type", "number"}, {"description", "Maximum number of lines to read (default 2000)"}}}
            }},
            {"required", json::array({"path"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"encoding",  {{"type", "string"}, {"enum", json::array({"text"})}, {"description", "Always \"text\" — read only serves text output"}}},
                {"mime_type", {{"type", "string"}, {"description", "Detected MIME type of the text file (e.g. text/plain)"}}},
                {"line_count", {{ "type", "integer"}, {"description", "Number of lines returned"}}},
                {"truncated", {{"type", "boolean"}, {"description", "Whether the output was truncated"}}},
                {"file_size", {{ "type", "integer"}, {"description", "Size of the file in bytes (always present)"}}},
                {"total_lines", {{"type", "integer"}, {"description", "Total lines in the file (only when truncated, or when offset is past the end)"}}},
                {"next_offset", {{"type", "integer"}, {"description", "Offset to pass to continue reading (only when a further line exists)"}}},
                {"empty_reason", {{"type", "string"}, {"enum", json::array({"empty_file", "offset_beyond_eof"})},
                                   {"description", "Why the body is empty (only when line_count is 0)"}}}
            }},
            {"required", json::array({"encoding", "mime_type", "line_count", "truncated", "file_size"})}
        }},
        {"annotations", {
            {"title", "Read File"},
            {"readOnlyHint", true},
            {"destructiveHint", false}
        }}
    });

    // view_image tool — the only way to get image content.
    tools.push_back({
        {"name", "view_image"},
        {"title", "View Image"},
        {"description",
         std::string("View an image file (") + supported_image_formats() +
         "). Returns the image itself plus its metadata; oversized images are "
         "downscaled to a 2000px longest edge. Use detail=\"low\" for a 512px "
         "preview. Animated sources return their first frame only. Formats "
         "outside the model-native set (jpeg/png/gif/webp) are converted to "
         "PNG/JPEG, so the payload is always something a multimodal model can "
         "ingest. Other image formats (avif, heic, jxl, psd, \xe2\x80\xa6) are "
         "reported as unsupported. The target must be a regular image file; "
         "files above 100 MP are rejected without being decoded."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"minLength", 1}, {"description", "Path to the image file (relative or absolute)"}}},
                {"detail", {{"type", "string"}, {"enum", json::array({"auto", "low"})},
                            {"description", "\"auto\" (default, up to 2000px) or \"low\" (up to 512px, fewer tokens)"}}}
            }},
            {"required", json::array({"path"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"encoding",  {{"type", "string"}, {"enum", json::array({"image"})}}},
                {"mime_type", {{"type", "string"}, {"description", "MIME type of the returned image (may differ from the file after re-encoding)"}}},
                {"width",     {{"type", "integer"}, {"description", "Width of the returned image"}}},
                {"height",    {{"type", "integer"}, {"description", "Height of the returned image"}}},
                {"original_width",  {{"type", "integer"}, {"description", "Width of the file's image before resizing"}}},
                {"original_height", {{"type", "integer"}, {"description", "Height of the file's image before resizing"}}},
                {"was_resized", {{"type", "boolean"}, {"description", "Whether the image was downscaled"}}},
                {"size", {{"type", "integer"}, {"description", "Size of the original file in bytes"}}},
                {"animated", {{"type", "boolean"}, {"description", "Animated source — only the first frame is returned"}}},
                {"converted", {{"type", "boolean"}, {"description", "Source format was outside the model-native set (jpeg/png/gif/webp) and was re-encoded to PNG/JPEG"}}}
            }},
            {"required", json::array({"encoding", "mime_type", "width", "height",
                                     "original_width", "original_height", "was_resized", "size"})}
        }},
        {"annotations", {
            {"title", "View Image"},
            {"readOnlyHint", true},
            {"destructiveHint", false}
        }}
    });

    // write tool
    tools.push_back({
        {"name", "write"},
        {"title", "Write File"},
        {"description",
         "Create or overwrite a file with the given content. "
         "Parent directories are created automatically if needed. "
         "Use encoding=base64 for binary content. "
         "The write is in place: existing permissions, hard links and symlinks "
         "are preserved. Targets must not be directories, FIFOs or sockets."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"minLength", 1}, {"description", "Path to the file to write (relative or absolute)"}}},
                {"content", {{"type", "string"}, {"description", "Content to write to the file. When encoding is base64, this is the base64-encoded binary data."}}},
                {"encoding", {{"type", "string"}, {"enum", json::array({"text", "base64"})},
                             {"description", "Content encoding: \"text\" (default) or \"base64\""}}}
            }},
            {"required", json::array({"path", "content"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"path",  {{"type", "string"},  {"description", "Path written"}}},
                {"bytes", {{"type", "integer"}, {"description", "Number of bytes written"}}},
                {"created", {{"type", "boolean"}, {"description", "True when the file did not exist before"}}}
            }},
            {"required", json::array({"path", "bytes", "created"})}
        }},
        {"annotations", {
            {"title", "Write File"},
            {"readOnlyHint", false},
            {"destructiveHint", true}
        }}
    });

    // edit tool
    tools.push_back({
        {"name", "edit"},
        {"title", "Edit File"},
        {"description",
         "Edit a file using exact text replacement. "
         "Every edits[].oldText must match a unique, non-overlapping region of the original file. "
         "The file is rewritten in place only when the bytes actually change (a no-op "
         "edit leaves the file untouched); targets above 16 MiB are rejected."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"minLength", 1}, {"description", "Path to the file to edit (relative or absolute)"}}},
                {"edits", {
                    {"type", "array"},
                    {"items", {
                        {"type", "object"},
                        {"properties", {
                            {"oldText", {{"type", "string"}, {"description", "Exact text to find (must be unique)"}}},
                            {"newText", {{"type", "string"}, {"description", "Replacement text"}}}
                        }},
                        {"required", json::array({"oldText", "newText"})}
                    }},
                    {"description", "One or more targeted replacements"}
                }}
            }},
            {"required", json::array({"path", "edits"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"description", "Path edited"}}},
                {"lines_added", {{"type", "integer"}, {"description", "Lines added"}}},
                {"lines_removed", {{"type", "integer"}, {"description", "Lines removed"}}},
                {"first_changed_line", {{"type", "integer"}, {"description", "1-indexed line of the first change"}}}
            }},
            {"required", json::array({"path", "lines_added", "lines_removed", "first_changed_line"})}
        }},
        {"annotations", {
            {"title", "Edit File"},
            {"readOnlyHint", false},
            {"destructiveHint", true}
        }}
    });

    // run_in_terminal tool
    tools.push_back({
        {"name", "run_in_terminal"},
        {"title", "Run in Terminal"},
        {"description",
         "Start a persistent PTY session running the given command (e.g. \"bash\"). "
         "The command runs on a real terminal: it can be interactive (prompts, REPLs, "
         "pagers) and keeps state (cwd, environment) across calls. "
         "Returns the session id, the rendered screen, the raw output received so far "
         "(with `next_cursor` for the position after it) and the amount of bytes received. "
         "For a command whose output must be complete pass wait_for:\"exit\" (with a "
         "`wait_ms` budget): one call then returns everything plus the exit code. "
         "Use send_to_terminal to type into the session and kill_terminal to end it. "
         "For a plain non-interactive command prefer the bash tool: it returns separate "
         "stdout/stderr and no terminal rendering."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", terminal_read_args(json{
                {"command",     {{"type", "string"}, {"description", "Command to run in the PTY (e.g. bash)"}}},
                {"explanation", {{"type", "string"}, {"description", "Why this terminal is needed"}}},
                {"goal",        {{"type", "string"}, {"description", "What you intend to accomplish"}}},
                {"cols",        {{"type", "number"}, {"description", "Terminal columns, 20-1000 (default 220). Set on the PTY itself, so programs see the real size."}}},
                {"rows",        {{"type", "number"}, {"description", "Terminal rows, 1-1000 (default 50). Only the screen snapshot is this tall; the raw log is not limited by it."}}}
            })},
            {"required", json::array({"command"})}
        }},
        {"outputSchema", terminal_output_schema()},
        {"annotations", {
            {"title", "Run in Terminal"},
            {"readOnlyHint", false},
            {"destructiveHint", true}
        }}
    });

    // send_to_terminal tool
    tools.push_back({
        {"name", "send_to_terminal"},
        {"title", "Send to Terminal"},
        {"description",
         "Write text to a session's PTY stdin and return what came back. Append \\n to "
         "run it as a shell command line (text without a trailing newline only reaches the "
         "program as keystrokes). The result holds the output produced since the previous "
         "read, so nothing repeats and nothing is lost. "
         "With capture_status:true the text is submitted as a shell command line and the "
         "result carries command_exit_code, so a persistent shell session can be driven "
         "like a command runner (shell sessions only — the probe line is input, so do not "
         "use it on a REPL or a pager). "
         "With signal the session's process group is signalled instead of (or after) the "
         "write: it goes to the foreground job *and* to the shell itself, which is how you "
         "ask a session to stop what it is doing (a raw ETX byte, 0x03, only reaches the "
         "foreground job). \"KILL\" ends the session; interactive shells ignore "
         "SIGTERM/SIGQUIT by POSIX, so use kill_terminal to end one of those."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", terminal_read_args(json{
                {"id",      {{"type", "string"}, {"description", "Terminal session id"}}},
                {"command", {{"type", "string"}, {"description", "Text to write to the PTY stdin (optional when signal is given)"}}},
                {"signal",  {{"type", "string"},
                             {"enum", json::array({"INT", "TERM", "KILL", "HUP", "QUIT", "USR1", "USR2", "STOP", "CONT"})},
                             {"description", "Signal to deliver to the session's process group"}}},
                {"capture_status", {{"type", "boolean"},
                    {"description", "Submit `command` as a shell command line and report its exit code (default false)"}}}
            })},
            {"required", json::array({"id"})}
        }},
        {"outputSchema", terminal_output_schema()},
        {"annotations", {
            {"title", "Send to Terminal"},
            {"readOnlyHint", false},
            {"destructiveHint", true}
        }}
    });

    // get_terminal_output tool
    tools.push_back({
        {"name", "get_terminal_output"},
        {"title", "Get Terminal Output"},
        {"description",
         "Wait for output from a session and return it. The result always carries both "
         "views: `output` is the rendered screen (the last `rows` lines — what an "
         "interactive program is showing) and `stream` is the raw bytes received since "
         "the previous read, the position after which is `next_cursor`; the text shows "
         "whichever is complete, so nothing repeats and nothing is lost. "
         "Pass `cursor` to read from an explicit position instead (0 = everything still "
         "retained) and wait_for:\"exit\" to wait for the process to finish and collect "
         "the complete output in one call. When the log wrapped, truncated_before and "
         "dropped_bytes say which bytes are gone."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", terminal_read_args(json{
                {"id",     {{"type", "string"}, {"description", "Terminal session id"}}},
                {"cursor", {{"type", "number"}, {"description", "Absolute byte cursor: read from here instead of the session's read position (0 = oldest retained byte)"}}}
            })},
            {"required", json::array({"id"})}
        }},
        {"outputSchema", terminal_output_schema()},
        {"annotations", {
            {"title", "Get Terminal Output"},
            {"readOnlyHint", true},
            {"destructiveHint", false}
        }}
    });

    // kill_terminal tool
    tools.push_back({
        {"name", "kill_terminal"},
        {"title", "Kill Terminal"},
        {"description",
         "Kill a terminal session and free its resources. Signals the session's whole "
         "process group (SIGHUP, escalating to SIGKILL) and returns the final screen plus "
         "the complete raw output still retained (from `cursor` when given), so nothing "
         "printed before the kill is lost."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"id",     {{"type", "string"}, {"description", "Terminal session id"}}},
                {"cursor", {{"type", "number"}, {"description", "Absolute byte cursor: return the raw stream from here (0 = oldest retained byte)"}}}
            }},
            {"required", json::array({"id"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"id",       {{"type", "string"},  {"description", "Terminal session id"}}},
                {"killed",   {{"type", "boolean"}, {"description", "True when the session was still running and had to be signalled (false when it had already exited)"}}},
                {"exit_code", {{"type", json::array({"integer", "null"})},
                               {"description", "Exit code of the session's process (-1 when it was signalled)"}}},
                {"output",   {{"type", "string"},  {"description", "Final screen snapshot"}}},
                {"stream",   {{"type", "string"},  {"description", "Raw output bytes in [first_cursor, next_cursor)"}}},
                {"first_cursor", {{"type", "integer"}}},
                {"next_cursor",  {{"type", "integer"}}},
                {"total_bytes",  {{"type", "integer"}}},
                {"truncated_before", {{"type", "boolean"}}},
                {"dropped_bytes",    {{"type", "integer"}}}
            }},
            {"required", json::array({"id", "killed", "output", "exit_code"})}
        }},
        {"annotations", {
            {"title", "Kill Terminal"},
            {"readOnlyHint", false},
            {"destructiveHint", true}
        }}
    });

    // list_terminals tool
    tools.push_back({
        {"name", "list_terminals"},
        {"title", "List Terminals"},
        {"description",
         "List the terminal sessions this server owns. Exited sessions are hidden by "
         "default (they stay addressable until they are reaped); pass include_exited:true "
         "to see them too, and kill_terminal to release one."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"include_exited", {{"type", "boolean"},
                    {"description", "Also list sessions whose process has exited (default false)"}}}
            }},
            {"required", json::array()}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"sessions", {
                    {"type", "array"},
                    {"items", {
                        {"type", "object"},
                        {"properties", {
                            {"id",      {{"type", "string"},  {"description", "Terminal session id"}}},
                            {"command", {{"type", "string"},  {"description", "Command the session runs"}}},
                            {"alive",   {{"type", "boolean"}, {"description", "Whether the session is still alive"}}},
                            {"exited",  {{"type", "boolean"}, {"description", "Whether the process has exited"}}},
                            {"exit_code", {{"type", json::array({"integer", "null"})}}},
                            {"cols",    {{"type", "integer"}}},
                            {"rows",    {{"type", "integer"}}},
                            {"total_bytes", {{"type", "integer"}, {"description", "Raw bytes received so far"}}},
                            {"retained_bytes", {{"type", "integer"}, {"description", "Bytes still readable from the raw log"}}},
                            {"truncated", {{"type", "boolean"}, {"description", "Some output was dropped from the raw log"}}},
                            {"age_ms",  {{"type", "integer"}, {"description", "Age of the session in milliseconds"}}},
                            {"idle_ms", {{"type", "integer"}, {"description", "Time since the last output (or the exit)"}}}
                        }},
                        {"required", json::array({"id", "command", "alive", "exited", "exit_code"})}
                    }}
                }}
            }},
            {"required", json::array({"sessions"})}
        }},
        {"annotations", {
            {"title", "List Terminals"},
            {"readOnlyHint", true},
            {"destructiveHint", false}
        }}
    });

    // Sanitize id in case it contains invalid UTF-8.
    json safe_id = id;
    if (safe_id.is_string())
        safe_id = ensure_valid_utf8(safe_id.get<std::string>());

    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = safe_id;
    j["result"] = {{"tools", tools}};
    return j.dump();
}

// ---------------------------------------------------------------------------
// Tool handlers
//
// Every handler returns a ToolResult; serialization happens in exactly one
// place (rpc_serialize_tool_result).
// ---------------------------------------------------------------------------

// One-line state header for terminal results.  The tool-contract test pins the
// "terminal <id> (<command>)" prefix, so extra state goes after it.
static std::string terminal_state_line(const std::string &id,
                                       const std::string &command,
                                       bool exited, int exit_code) {
    std::string line = "terminal " + id;
    if (!command.empty()) line += " (" + command + ")";
    if (!exited)                    line += ", running";
    else if (exit_code < 0)         line += ", exited (killed by a signal)";
    else                            line += ", exited, code " + std::to_string(exit_code);
    return line;
}

static size_t count_lines(const std::string &s) {
    return (size_t)std::count(s.begin(), s.end(), '\n');
}

// Map a terminal_* failure to its stable error code.  TerminalError carries the
// code; anything else is an internal error.
static ToolResult terminal_exception_result(const std::exception &e) {
    if (const auto *te = dynamic_cast<const TerminalError *>(&e))
        return tool_error_result(te->code(), e.what());
    if (const std::string what = e.what();
        what.rfind("unknown terminal session", 0) == 0 ||
        what.rfind("terminal session has exited", 0) == 0)
        return tool_error_result(error_code::kNotFound, what);
    return tool_error_result(error_code::kInternal, e.what());
}

// Best-effort plain-text view of a raw PTY stream: escape sequences are
// dropped and the CR / backspace edits that line-oriented output relies on
// (progress bars, spinners) are applied.  Cursor-addressed (full-screen) output
// still needs the rendered screen — this is only a readable approximation of a
// byte stream, which is exactly what a command runner wants.
static std::string clean_stream(const std::string &raw) {
    std::string out;
    std::string line;
    size_t i = 0;
    const size_t n = raw.size();

    while (i < n) {
        unsigned char c = static_cast<unsigned char>(raw[i]);

        if (c == 0x1b) {                       // ESC
            size_t j = i + 1;
            if (j < n && raw[j] == '[') {      // CSI … final byte
                j++;
                while (j < n && static_cast<unsigned char>(raw[j]) < 0x40) j++;
                if (j < n) j++;
                i = j;
                continue;
            }
            if (j < n && raw[j] == ']') {      // OSC … BEL | ST
                j++;
                bool closed = false;
                while (j < n) {
                    if (static_cast<unsigned char>(raw[j]) == 0x07) { j++; closed = true; break; }
                    if (static_cast<unsigned char>(raw[j]) == 0x1b && j + 1 < n && raw[j+1] == '\\') {
                        j += 2; closed = true; break;
                    }
                    j++;
                }
                (void)closed;
                i = j;
                continue;
            }
            i = (j < n) ? j + 1 : n;           // ESC + one char
            continue;
        }

        if (c == '\n') { out += line; out += '\n'; line.clear(); i++; continue; }
        if (c == '\r') {
            if (i + 1 < n && raw[i+1] == '\n') {   // CRLF is a line ending
                out += line; out += '\n'; line.clear(); i += 2; continue;
            }
            line.clear();                          // bare CR rewrites the line
            i++;
            continue;
        }
        if (c == '\b') { if (!line.empty()) line.pop_back(); i++; continue; }
        if (c == '\t' || c >= 0x20) { line += static_cast<char>(c); i++; continue; }
        i++;                                       // other control bytes
    }
    out += line;                                   // trailing partial line
    return out;
}

// Read options shared by every terminal tool.  `run_to_completion` marks the
// two forms whose whole point is "run this and give me the result"
// (wait_for:"exit" and capture_status): they wait much longer by default.
static int terminal_wait_ms_for(const RpcRequest &req, bool run_to_completion) {
    if (req.terminal_wait_ms >= 0) return req.terminal_wait_ms;
    return run_to_completion ? 60000 : 500;
}

static TerminalWait terminal_wait_kind(const RpcRequest &req) {
    if (req.terminal_wait_for == "exit") return TerminalWait::Exit;
    if (req.terminal_wait_for == "none") return TerminalWait::None;
    return TerminalWait::Output;
}

static TerminalReadOptions terminal_read_options(const RpcRequest &req,
                                                 bool run_to_completion) {
    TerminalReadOptions opts;
    opts.wait_ms  = terminal_wait_ms_for(req, run_to_completion);
    opts.wait_for = terminal_wait_kind(req);
    opts.cursor   = req.terminal_cursor;
    return opts;
}

// Structured payload shared by every terminal read result.
static json terminal_structured(const std::string &id,
                                const TerminalOutputResult &r) {
    json sc = {
        {"id",        id},
        {"output",    ensure_valid_utf8(r.output)},
        {"exited",    r.exited},
        {"exit_code", r.exited ? json(r.exit_code) : json(nullptr)},
        {"total_bytes", r.total_bytes},
        {"stream",           ensure_valid_utf8(r.stream)},
        {"first_cursor",     r.first_cursor},
        {"next_cursor",      r.next_cursor},
        {"truncated_before", r.truncated},
    };
    if (r.dropped_bytes > 0) sc["dropped_bytes"] = r.dropped_bytes;
    if (r.screen_partial) sc["screen_partial"] = true;
    return sc;
}

// Body of a terminal result.
//
//   delta mode  — the caller asked for the stream (explicit cursor) or the new
//                 output is taller than the screen, so it would be shown as a
//                 lossy view: the cleaned raw delta is the body.
//   screen mode — the screen contains everything new (small deltas), so it is
//                 both readable and complete; no duplicated text.
static std::string terminal_body(const TerminalOutputResult &r, bool use_delta,
                                 const std::string &cleaned_delta) {
    if (use_delta) {
        std::string body = cleaned_delta;
        if (r.truncated)
            body = "[earlier output was dropped: " + std::to_string(r.dropped_bytes) +
                   " bytes no longer retained]\n" + body;
        if (body.empty()) body = "(no new output)\n";
        return head_tail_reduce(body, kTextHeadBytes, kTextTailBytes);
    }
    std::string body = r.output;
    if (body.empty()) body = "(no new output)\n";
    return body;
}

// Screen-mode trailer: the screen holds the last `rows` lines only, and with
// several readers of one session the earlier bytes may not have been read by
// this caller at all.
static std::string terminal_stream_hint(const TerminalOutputResult &r) {
    if (!r.screen_partial) return std::string();
    return "[screen shows the last lines only \xe2\x80\x94 the complete output is "
           "in the stream: pass cursor:" + std::to_string(r.first_cursor) +
           ", or run with wait_for:\"exit\"]\n";
}

// Full text for a read result: state line, body, hint.
static std::string terminal_result_text(const std::string &id,
                                        const std::string &command,
                                        const TerminalOutputResult &r,
                                        bool use_delta,
                                        const std::string &cleaned_delta,
                                        bool has_status, int status,
                                        const std::string &suffix_state) {
    std::string line = terminal_state_line(id, command, r.exited, r.exit_code);
    if (has_status) line += ", command exit code " + std::to_string(status);
    if (!suffix_state.empty()) line += suffix_state;
    // The byte count is the width of the cursor span (next_cursor - first_cursor),
    // which is what the cursor arithmetic means; `stream` can be a little shorter
    // because boxsh's own capture_status probe bytes are removed from it.
    const size_t span = r.next_cursor >= r.first_cursor
                            ? (size_t)(r.next_cursor - r.first_cursor) : 0;
    line += ", " + std::to_string(span) + " bytes";
    if (span > r.stream.size())
        line += " (" + std::to_string(r.stream.size()) +
                " after removing boxsh's status probe)";
    line += ", cursor \xe2\x86\x92 " + std::to_string(r.next_cursor);
    std::string text = line + "\n\n" + terminal_body(r, use_delta, cleaned_delta);
    if (!use_delta) text += terminal_stream_hint(r);
    return text;
}

// Does this read want the raw delta as its text?  YES when the caller pinned a
// cursor; otherwise when the new output is taller than the screen (the screen
// would silently drop its head - the exact failure the stream exists to fix).
static bool terminal_use_delta(const RpcRequest &req, const TerminalOutputResult &r,
                               const std::string &cleaned_delta) {
    if (req.terminal_cursor.has_value()) return true;
    return count_lines(cleaned_delta) > count_lines(r.output);
}

static ToolResult tool_terminal_run(const RpcRequest &req) {
    try {
        const bool run_to_completion = req.terminal_wait_for == "exit";
        auto result = terminal_create(req.terminal_command,
                                      req.terminal_cols, req.terminal_rows,
                                      terminal_read_options(req, run_to_completion));
        const std::string cleaned = clean_stream(result.out.stream);
        ToolResult tr;
        tr.text = terminal_result_text(result.id, req.terminal_command, result.out,
                                       terminal_use_delta(req, result.out, cleaned),
                                       cleaned, false, 0, std::string());
        tr.structured = terminal_structured(result.id, result.out);
        tr.trimmable_fields = {"stream"};
        return tr;
    } catch (const std::exception &e) {
        return terminal_exception_result(e);
    }
}

static ToolResult tool_terminal_send(const RpcRequest &req) {
    try {
        TerminalSendOptions opts;
        opts.read           = terminal_read_options(
            req, req.terminal_capture_status || req.terminal_wait_for == "exit");
        opts.capture_status = req.terminal_capture_status;
        opts.signal         = req.terminal_signal;

        auto r = terminal_send(req.session_id, req.terminal_command, opts);
        const std::string cleaned = clean_stream(r.out.stream);
        ToolResult tr;
        tr.text = terminal_result_text(req.session_id, std::string(), r.out,
                                       terminal_use_delta(req, r.out, cleaned),
                                       cleaned,
                                       r.has_command_exit_code, r.command_exit_code,
                                       std::string());
        tr.structured = terminal_structured(req.session_id, r.out);
        tr.trimmable_fields = {"stream"};
        if (r.has_command_exit_code)
            tr.structured.value()["command_exit_code"] = r.command_exit_code;
        return tr;
    } catch (const std::exception &e) {
        return terminal_exception_result(e);
    }
}

static ToolResult tool_terminal_output(const RpcRequest &req) {
    try {
        const bool run_to_completion = req.terminal_wait_for == "exit";
        auto r = terminal_read(req.session_id,
                               terminal_read_options(req, run_to_completion));
        const std::string cleaned = clean_stream(r.stream);
        ToolResult tr;
        tr.text = terminal_result_text(req.session_id, std::string(), r,
                                       terminal_use_delta(req, r, cleaned),
                                       cleaned, false, 0, std::string());
        tr.structured = terminal_structured(req.session_id, r);
        tr.trimmable_fields = {"stream"};
        return tr;
    } catch (const std::exception &e) {
        return terminal_exception_result(e);
    }
}

// Adapt a kill result to the shared renderer.  A kill always reads the stream:
// the point of the call is the final output, not the last screen.
static TerminalOutputResult terminal_out_from_kill(const TerminalKillResult &k) {
    TerminalOutputResult r;
    r.output        = k.output;
    r.exited        = true;
    r.exit_code     = k.exit_code;
    r.stream        = k.stream;
    r.first_cursor  = k.first_cursor;
    r.next_cursor   = k.next_cursor;
    r.total_bytes   = k.next_cursor;
    r.truncated     = k.truncated;
    r.dropped_bytes = k.dropped_bytes;
    return r;
}

static ToolResult tool_terminal_kill(const RpcRequest &req) {
    try {
        auto r   = terminal_kill(req.session_id, req.terminal_cursor);
        auto out = terminal_out_from_kill(r);

        // The kill text keeps its historical shape ("terminal <id> killed"),
        // with the exit status added after it.
        std::string line = "terminal " + req.session_id + " killed";
        if (!r.killed) line += " (already exited)";
        if (r.exit_code < 0) line += ", killed by a signal";
        else                 line += ", exit code " + std::to_string(r.exit_code);
        line += ", cursor \xe2\x86\x92 " + std::to_string(r.next_cursor);

        ToolResult tr;
        tr.text = line + "\n\n" + terminal_body(out, true, clean_stream(out.stream));
        tr.structured = terminal_structured(req.session_id, out);
        tr.structured.value()["killed"] = r.killed;
        tr.trimmable_fields = {"stream"};
        return tr;
    } catch (const std::exception &e) {
        return terminal_exception_result(e);
    }
}

static ToolResult tool_terminal_list(const RpcRequest &req) {
    auto sessions = terminal_list();
    json arr = json::array();
    std::string text;
    for (auto &s : sessions) {
        // Exited sessions stay addressable until they are reaped, but they are
        // not what "list my terminals" means, so they are opt-in.
        if (!s.alive && !req.terminal_include_exited) continue;
        std::string id      = ensure_valid_utf8(s.id);
        std::string command = ensure_valid_utf8(s.command);
        arr.push_back({
            {"id", id}, {"command", command}, {"alive", s.alive},
            {"exited", !s.alive},
            {"exit_code", s.alive ? json(nullptr) : json(s.exit_code)},
            {"cols", s.cols}, {"rows", s.rows},
            {"total_bytes", s.total_bytes},
            {"retained_bytes", s.retained_bytes},
            {"truncated", s.truncated},
            {"age_ms", s.age_ms},
            {"idle_ms", s.idle_ms},
        });
        text += id + "  " + (s.alive ? "running" : "exited") + "  " + command +
                "  (" + std::to_string(s.total_bytes) + " bytes)\n";
    }
    if (text.empty()) text = "(no terminal sessions)\n";

    ToolResult tr;
    tr.text = std::move(text);
    tr.structured = json{{"sessions", arr}};
    return tr;
}

// ---------------------------------------------------------------------------
// macOS path normalization
// ---------------------------------------------------------------------------

// Normalize a file path for macOS compatibility.  macOS filenames may use
// NFD (decomposed) Unicode, curly apostrophe (U+2019) in screenshot names,
// and narrow no-break space (U+202F) in AM/PM timestamps.  When a path
// does not exist as-is, we try the normalized variant before giving up.

// Reduce a string to a canonical ASCII form for comparison purposes.
// Both the on-disk name and the requested name are reduced, so the match
// works regardless of which side has the Unicode variant.
static std::string normalize_to_ascii(const std::string &s) {
    std::string r = s;

    // Curly single quotes → ASCII apostrophe (U+2018 = 0xE2 0x80 0x98,
    // U+2019 = 0xE2 0x80 0x99).
    for (size_t pos = 0; (pos = r.find("\xe2\x80\x98", pos)) != std::string::npos;)
        r.replace(pos, 3, "'"), ++pos;
    for (size_t pos = 0; (pos = r.find("\xe2\x80\x99", pos)) != std::string::npos;)
        r.replace(pos, 3, "'"), ++pos;

    // Narrow no-break space → regular space (U+202F = 0xE2 0x80 0xAF).
    for (size_t pos = 0; (pos = r.find("\xe2\x80\xaf", pos)) != std::string::npos;)
        r.replace(pos, 3, " "), ++pos;

#ifdef __APPLE__
    // NFD → NFC via CoreFoundation.
    CFStringRef cf = CFStringCreateWithBytes(
        kCFAllocatorDefault,
        reinterpret_cast<const UInt8 *>(r.data()), (CFIndex)r.size(),
        kCFStringEncodingUTF8, false);
    if (cf) {
        CFMutableStringRef mut = CFStringCreateMutableCopy(
            kCFAllocatorDefault, 0, cf);
        CFRelease(cf);
        if (mut) {
            CFStringNormalize(mut, kCFStringNormalizationFormC);
            CFIndex len = CFStringGetMaximumSizeForEncoding(
                CFStringGetLength(mut), kCFStringEncodingUTF8) + 1;
            std::string nfc(len, '\0');
            if (CFStringGetCString(mut, &nfc[0], len, kCFStringEncodingUTF8))
                r = nfc.c_str();
            CFRelease(mut);
        }
    }
#endif
    return r;
}

// Try stat() with the original path first; on ENOENT, scan the parent
// directory for a filename that matches after Unicode normalization.
static int stat_normalized(const std::string &path, struct stat *st,
                           std::string &resolved) {
    if (stat(path.c_str(), st) == 0) {
        resolved = path;
        return 0;
    }
    if (errno != ENOENT) return -1;

    // Extract parent directory and base filename.
    auto slash = path.rfind('/');
    if (slash == std::string::npos) return -1;
    std::string dir = path.substr(0, slash);
    std::string base = path.substr(slash + 1);
    if (base.empty()) return -1;

    std::string norm_base = normalize_to_ascii(base);

    DIR *dp = opendir(dir.c_str());
    if (!dp) return -1;

    struct dirent *ent;
    while ((ent = readdir(dp)) != nullptr) {
        if (normalize_to_ascii(ent->d_name) == norm_base) {
            std::string candidate = dir + "/" + ent->d_name;
            if (stat(candidate.c_str(), st) == 0) {
                resolved = candidate;
                closedir(dp);
                return 0;
            }
        }
    }
    closedir(dp);
    return -1;
}

// ---------------------------------------------------------------------------
// RPC run loop
// ---------------------------------------------------------------------------

// Map errno to a stable error code (README.md "Error model").
static const char *errno_error_code(int err) {
    switch (err) {
        case ENOENT:  return error_code::kNotFound;
        case EISDIR:
        case ENOTDIR:
        case ENAMETOOLONG:
        case EINVAL:
        case ELOOP:   return error_code::kInvalidArgument;
        case EACCES:
        case EPERM:   return error_code::kSandbox;
        default:      return error_code::kInternal;
    }
}

// errno name for machine-readable detail payloads.
static const char *errno_name(int err) {
    switch (err) {
        case ENOENT:        return "ENOENT";
        case ELOOP:         return "ELOOP";
        case EISDIR:        return "EISDIR";
        case ENOTDIR:       return "ENOTDIR";
        case ENAMETOOLONG:  return "ENAMETOOLONG";
        case EINVAL:        return "EINVAL";
        case EACCES:        return "EACCES";
        case EPERM:         return "EPERM";
        default:            return nullptr;
    }
}

// Human-readable errno text.  The message stays human (“what happened, what to
// do next”); the raw errno travels in `detail` (contract §2.2) — so a sandbox
// denial and a plain permission problem are told apart by errno, not guessed
// from the fact that a sandbox happens to be active.
static std::string errno_message(int err) {
    switch (err) {
        case EACCES:
            return sandbox_active()
                ? "Permission denied (file permissions; a sandbox is active, so "
                  "the path may also need --bind to be writable)"
                : "Permission denied (file permissions; no sandbox is active)";
        case EPERM:
            return sandbox_active()
                ? "Operation not permitted (denied by the sandbox; expose the "
                  "path with --bind)"
                : "Operation not permitted (blocked by the OS)";
        case ELOOP:
            return "Too many levels of symbolic links (symbolic link loop)";
        default:
            return strerror(err);
    }
}

// `detail` payload for failures where the code alone is not enough.
static std::optional<json> errno_detail(int err) {
    if (err == EACCES || err == EPERM) {
        json d = {{"sandbox", sandbox_active()}, {"errno", err}};
        if (const char *name = errno_name(err)) d["errno_name"] = name;
        return d;
    }
    if (err == ELOOP) return json{{"errno", err}, {"errno_name", "ELOOP"}};
    return std::nullopt;
}

// A dangling symbolic link keeps E_NOT_FOUND (its target really is missing, as
// POSIX tools report it), but the caller must be able to tell it from a typo or
// an undeployed file — otherwise a retry policy that reads "create it" would
// follow the link and produce an unintended file.  lstat() + readlink() supply
// the missing piece (README "Error model").
static std::optional<ToolResult> broken_symlink_result(const std::string &tool,
                                                       const std::string &path) {
    struct stat lst;
    if (lstat(path.c_str(), &lst) != 0 || !S_ISLNK(lst.st_mode))
        return std::nullopt;

    char buf[4096];
    ssize_t n = readlink(path.c_str(), buf, sizeof(buf) - 1);
    if (n < 0) return std::nullopt;
    std::string target(buf, static_cast<size_t>(n));

    return tool_error_result(error_code::kNotFound,
        tool + ": cannot open file: " + path + ": " + errno_message(ENOENT) +
        " (broken symbolic link to " + target + ")",
        json{{"kind", "dangling_symlink"}, {"target", target}});
}

// File types whose open()/read() would block the tool thread forever.  A FIFO
// with no writer blocks in open(); a unix socket cannot be opened as a file.
// Both must be rejected before the open (contract §2.5).
static const char *blocking_file_kind(mode_t mode) {
    if (S_ISFIFO(mode)) return "fifo";
    if (S_ISSOCK(mode)) return "socket";
    return nullptr;
}

// Reject blocking targets.  Returns true when 'out' holds the error result.
static bool reject_blocking_target(const char *tool, const std::string &path,
                                   mode_t mode, ToolResult &out) {
    const char *kind = blocking_file_kind(mode);
    if (!kind) return false;
    out = tool_error_result(error_code::kInvalidArgument,
        std::string(tool) + ": " + path + " is a " + kind +
        "; file tools only handle regular files — use bash (cat/ls) instead",
        json{{"kind", kind}});
    return true;
}

// Best-effort rollback after a failed write (contract §四): remove the file we
// just created, or put the kept bytes back into an existing one.
static bool restore_file(const std::string &path, const std::string &previous,
                         bool existed) {
    if (!existed) return remove(path.c_str()) == 0;
    if (previous.empty()) return false;
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(previous.data(), static_cast<std::streamsize>(previous.size()));
    return static_cast<bool>(out);
}

// Read one line without ever buffering more than buf.size()-1 bytes.  A
// physical line longer than the buffer is reported via 'clipped' and the rest
// of it is discarded (so memory stays decoupled from the input's line
// length — see contract §四 “输入侧单行上限”).  Returns false at end of input.
static bool read_line_capped(std::istream &f, std::vector<char> &buf,
                             std::string &line, bool &clipped) {
    clipped = false;
    f.getline(buf.data(), static_cast<std::streamsize>(buf.size()));
    // gcount() would include the delimiter that getline extracts and discards;
    // the NUL it always writes is the unambiguous end of the stored data (text
    // lines cannot contain NUL — such files are rejected as binary).
    line.assign(buf.data());
    const bool at_eof = f.eof();
    if (f.fail() && !at_eof && line.size() + 1 == buf.size()) {
        clipped = true;   // buffer filled up: the line continues
        f.clear();
        f.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
    }
    return !line.empty() || !at_eof;
}

// read — text files only.  Images are view_image's job; anything binary is an
// error (README.md "Built-in file tools").
static ToolResult tool_read(const RpcRequest &req) {
    // Check file existence first, with macOS path normalization fallback.
    struct stat st;
    std::string resolved_path;
    if (stat_normalized(req.path, &st, resolved_path) != 0) {
        int err = errno;
        if (err == ENOENT) {
            if (auto broken = broken_symlink_result("read", req.path))
                return *broken;
        }
        return tool_error_result(errno_error_code(err),
            "read: cannot open file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }

    if (S_ISDIR(st.st_mode)) {
        return tool_error_result(error_code::kInvalidArgument,
            "read: " + req.path + " is a directory; use bash (ls/find) to list it");
    }
    {
        ToolResult blocked;
        if (reject_blocking_target("read", req.path, st.st_mode, blocked))
            return blocked;
    }

    // Detect binary via magic bytes.
    auto ft = detect_file_type(resolved_path);

    if (ft.binary) {
        json detail = {{"mime", ft.mime}, {"size", (uint64_t)st.st_size}};
        if (ft.mime.rfind("image/", 0) == 0) {
            return tool_error_result(error_code::kNotImage,
                "read: " + req.path + " is an image file (" + ft.mime +
                "); use view_image to view it", std::move(detail));
        }
        return tool_error_result(error_code::kNotText,
            "read: " + req.path + " is a binary file (" + ft.mime + ", " +
            std::to_string(st.st_size) +
            " bytes); use bash (file/xxd/strings) to inspect it",
            std::move(detail));
    }

    // Text mode: line-based reading with offset/limit.
    // Default safety limits: 2000 lines AND 50KB, whichever triggers first.
    static constexpr int    DEFAULT_MAX_LINES = 2000;
    static constexpr size_t DEFAULT_MAX_BYTES = 50 * 1024;  // 50KB
    // Input-side cap: a single physical line is never buffered in full, so a
    // machine-generated one-line file cannot blow up memory before the output
    // budget applies (contract §四).
    static constexpr size_t MAX_LINE_INPUT = 1024 * 1024;   // 1 MiB

    std::ifstream f(resolved_path);
    if (!f) {
        int err = errno;
        return tool_error_result(errno_error_code(err),
            "read: cannot open file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }

    std::vector<char> line_buf(MAX_LINE_INPUT);
    std::string line;
    std::ostringstream out;
    int line_no   = 0;
    int start     = req.offset.value_or(1);
    int max_lines = req.limit.value_or(DEFAULT_MAX_LINES);
    int collected = 0;
    size_t total_bytes = 0;
    bool truncated = false;
    bool line_capped = false;  // a single line exceeded the per-call byte budget

    for (;;) {
        bool clipped = false;
        if (!read_line_capped(f, line_buf, line, clipped)) break;
        ++line_no;
        if (line_no < start) continue;
        if (collected >= max_lines) { truncated = true; break; }
        size_t line_bytes = line.size() + 1;  // +1 for '\n'
        if (total_bytes + line_bytes > DEFAULT_MAX_BYTES) {
            // Lines are never split except for the first line: a single line
            // bigger than the whole byte budget (minified bundles, machine
            // generated logs) would otherwise bypass the limit entirely and
            // flood the caller.
            if (collected == 0) {
                static const size_t kReserve = 256;  // room for the hint text
                out << utf8_safe_truncate(line, DEFAULT_MAX_BYTES > kReserve
                                                ? DEFAULT_MAX_BYTES - kReserve
                                                : DEFAULT_MAX_BYTES)
                    << '\n';
                total_bytes = DEFAULT_MAX_BYTES;
                ++collected;
                line_capped = true;
            }
            truncated = true;
            break;
        }
        out << line << '\n';
        total_bytes += line_bytes;
        ++collected;
    }

    // Count remaining lines to get total_lines (bounded reader: the tail may
    // contain another huge line).
    int total_lines = line_no;
    if (truncated) {
        for (;;) {
            bool clipped = false;
            if (!read_line_capped(f, line_buf, line, clipped)) break;
            ++line_no;
        }
        total_lines = line_no;
    }

    std::string text_content = out.str();

    // The file sniffed as text but the bytes are not valid UTF-8 (e.g.
    // latin-1): it cannot be represented as JSON text.  Report it as a
    // non-text file instead of silently mangling bytes.
    if (!is_valid_utf8(text_content)) {
        return tool_error_result(error_code::kNotText,
            "read: " + req.path + " is not valid UTF-8 text; "
            "use bash (iconv/xxd/strings) to inspect it",
            json{{"mime", ft.mime}, {"size", (uint64_t)st.st_size}});
    }

    ToolResult tr;
    std::string text = text_content;
    // next_offset is only offered when a further line really exists; for a
    // capped final line the old code pointed past EOF (contract §四).
    const bool has_next_line = truncated && (start + collected <= total_lines);
    if (truncated) {
        if (!text.empty() && text.back() != '\n') text += '\n';
        if (line_capped) {
            text += "[truncated: line " + std::to_string(start) +
                    " is longer than the 50 KiB per-call limit; showing its "
                    "beginning — use bash (cut -c/sed) to read the rest";
            if (has_next_line)
                text += "; continue with offset=" + std::to_string(start + collected);
            text += "]";
        } else {
            int last_line = start + collected - 1;
            if (last_line < start) last_line = start;  // zero lines returned
            text += "[truncated: showing lines " + std::to_string(start) + "-" +
                    std::to_string(last_line) + " of " + std::to_string(total_lines) +
                    "; continue with offset=" + std::to_string(start + collected) + "]";
        }
    }
    tr.text = std::move(text);

    json sc = {{"encoding", "text"}, {"mime_type", ft.mime},
               {"line_count", collected}, {"truncated", truncated},
               {"file_size", (uint64_t)st.st_size}};
    if (truncated) {
        sc["total_lines"] = total_lines;
        if (has_next_line) sc["next_offset"] = start + collected;
    }
    if (collected == 0) {
        // An empty body must say why: an empty file and an offset past the end
        // used to be indistinguishable (contract §四).
        if (st.st_size == 0) {
            sc["empty_reason"] = "empty_file";
        } else {
            sc["empty_reason"] = "offset_beyond_eof";
            sc["total_lines"] = line_no;
        }
    }
    tr.structured = std::move(sc);
    return tr;
}

// view_image — the only tool that returns image content.
static ToolResult tool_view_image(const RpcRequest &req) {
    struct stat st;
    std::string resolved_path;
    if (stat_normalized(req.path, &st, resolved_path) != 0) {
        int err = errno;
        if (err == ENOENT) {
            if (auto broken = broken_symlink_result("view_image", req.path))
                return *broken;
        }
        return tool_error_result(errno_error_code(err),
            "view_image: cannot open file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }

    if (S_ISDIR(st.st_mode)) {
        return tool_error_result(error_code::kInvalidArgument,
            "view_image: " + req.path +
            " is a directory, not an image file; use bash (ls) to list it");
    }
    {
        ToolResult blocked;
        if (reject_blocking_target("view_image", req.path, st.st_mode, blocked))
            return blocked;
    }

    std::ifstream f(resolved_path, std::ios::binary);
    if (!f) {
        int err = errno;
        return tool_error_result(errno_error_code(err),
            "view_image: cannot read file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }
    std::string raw((std::istreambuf_iterator<char>(f)),
                     std::istreambuf_iterator<char>());

    // Type detection runs on bytes we already read, so an unreadable file is
    // reported as a permission/access problem instead of being misjudged as
    // "not an image" (contract §2.5: same root cause, same code per tool).
    const size_t probe_len = raw.size() < 8192 ? raw.size() : 8192;
    auto ft = detect_file_type(reinterpret_cast<const unsigned char *>(raw.data()),
                               probe_len);
    if (ft.mime.rfind("image/", 0) != 0) {
        return tool_error_result(error_code::kNotImage,
            "view_image: " + req.path + " is not an image file (" + ft.mime +
            "); use read for text files, or bash (file/xxd/strings) for other data",
            json{{"mime", ft.mime}});
    }

    const bool low_detail = (req.image_detail == "low");
    const int  max_edge   = low_detail ? 512 : 2000;

    // Animated sources must return their first frame only: re-encode instead
    // of handing back the original (possibly animated) file bytes.  The same
    // re-encode path is forced for formats outside the model-native set
    // (jpeg/png/gif/webp) — a small BMP or TIFF would otherwise be passed
    // through byte-for-byte in a format most multimodal models cannot ingest.
    const bool animated = image_is_animated(raw, ft.mime);
    const bool convert  = !mime_is_model_native(ft.mime);
    auto img = resize_image(raw, ft.mime, max_edge, max_edge,
                            kMaxImageBase64Bytes,
                            /*always_reencode=*/animated || convert);

    if (img.status == ImageResizeStatus::TooManyPixels) {
        // Header-declared dimensions exceeded the pixel budget; nothing was
        // decoded (contract §2.3).
        return tool_error_result(error_code::kTooLarge,
            "view_image: " + req.path + " declares " +
            std::to_string(img.declared_pixels) + " pixels, above the " +
            std::to_string(img.pixel_limit) +
            "-pixel decode limit; use bash (sips/convert) to downscale it first",
            json{{"mime", ft.mime},
                 {"pixels", img.declared_pixels},
                 {"limit", img.pixel_limit}});
    }
    if (img.status == ImageResizeStatus::TooLarge) {
        return tool_error_result(error_code::kTooLarge,
            "view_image: " + req.path + " is too large to inline (" +
            std::to_string(raw.size()) + " bytes, still over 4.5 MB after "
            "downscaling); retry with detail=\"low\"",
            json{{"mime", ft.mime}, {"size", (uint64_t)raw.size()}});
    }
    if (img.status != ImageResizeStatus::Ok || img.data.empty()) {
        // Same stable code for both cases; detail.reason separates a corrupt
        // file of a decodable format from a format outside the decode set
        // (contract §2.3).
        const bool decodable = mime_is_decodable(ft.mime);
        json detail = {{"mime", ft.mime},
                       {"supported", json::array({"image/png", "image/jpeg",
                                                   "image/gif", "image/bmp",
                                                   "image/tiff"
#ifdef BOXSH_HAVE_WEBP
                                                   , "image/webp"
#endif
                 })}};
        if (decodable) detail["reason"] = "decode_failed";
        return tool_error_result(error_code::kUnsupportedFormat,
            "view_image: cannot decode " + ft.mime + " (" + req.path + ")" +
            (decodable
                 ? "; the file looks truncated or corrupt — use bash (file/xxd) "
                   "to inspect it"
                 : "; this format is outside the decodable set — convert it "
                   "with bash (sips/convert) first") +
            "; supported formats: " + supported_image_formats(),
            std::move(detail));
    }

    ToolResult tr;
    std::string text = "[Image: " + img.mime_type + ", " +
        std::to_string(img.width) + "x" + std::to_string(img.height);
    if (img.was_resized)
        text += ", resized from " + std::to_string(img.original_width) +
                "x" + std::to_string(img.original_height);
    if (low_detail) text += ", low detail";
    if (animated)   text += ", animated, first frame";
    if (convert)    text += ", converted from " + ft.mime;
    text += "]";
    tr.text = std::move(text);

    tr.images.push_back({std::move(img.data), img.mime_type});

    json sc = {{"encoding", "image"}, {"mime_type", img.mime_type},
               {"width", img.width}, {"height", img.height},
               {"original_width", img.original_width},
               {"original_height", img.original_height},
               {"was_resized", img.was_resized},
               {"size", (uint64_t)raw.size()},
               {"animated", animated},
               {"converted", convert}};
    tr.structured = std::move(sc);
    return tr;
}

static ToolResult tool_write(const RpcRequest &req) {
    // Determine the raw bytes to write.
    std::string raw;
    if (req.encoding == "base64") {
        // Base64-decode req.content into raw.
        static const signed char kDecodeTable[128] = {
            -1,-1,-1,-1, -1,-1,-1,-1, -1,-1,-1,-1, -1,-1,-1,-1,
            -1,-1,-1,-1, -1,-1,-1,-1, -1,-1,-1,-1, -1,-1,-1,-1,
            -1,-1,-1,-1, -1,-1,-1,-1, -1,-1,-1,62, -1,-1,-1,63,
            52,53,54,55, 56,57,58,59, 60,61,-1,-1, -1,-1,-1,-1,
            -1, 0, 1, 2,  3, 4, 5, 6,  7, 8, 9,10, 11,12,13,14,
            15,16,17,18, 19,20,21,22, 23,24,25,-1, -1,-1,-1,-1,
            -1,26,27,28, 29,30,31,32, 33,34,35,36, 37,38,39,40,
            41,42,43,44, 45,46,47,48, 49,50,51,-1, -1,-1,-1,-1,
        };
        const std::string &s = req.content;
        raw.reserve(s.size() * 3 / 4);
        int acc = 0, bits = 0;
        for (unsigned char c : s) {
            if (c == '=' || c == '\n' || c == '\r') continue;
            if (c >= 128 || kDecodeTable[c] == -1) {
                return tool_error_result(error_code::kInvalidArgument,
                    "write: content is not valid base64");
            }
            acc = (acc << 6) | (unsigned char)kDecodeTable[c];
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                raw.push_back((char)(acc >> bits));
                acc &= (1 << bits) - 1;
            }
        }
    } else {
        raw = req.content;
    }

    // Did the file exist before this call?
    struct stat st;
    std::string resolved;
    bool existed = (stat_normalized(req.path, &st, resolved) == 0);
    if (existed) {
        if (S_ISDIR(st.st_mode)) {
            return tool_error_result(error_code::kInvalidArgument,
                "write: " + req.path + " is a directory; use bash to write "
                "inside it (for example " + req.path + "/file.txt)");
        }
        ToolResult blocked;
        if (reject_blocking_target("write", req.path, st.st_mode, blocked))
            return blocked;
    }

    // Keep the previous bytes so a failed write can be rolled back
    // (contract §四).  Bounded so the rollback copy cannot grow unbounded.
    static constexpr uint64_t kMaxRollbackBytes = 16ull * 1024 * 1024;  // 16 MiB
    std::string previous;
    if (existed && st.st_size > 0 && (uint64_t)st.st_size <= kMaxRollbackBytes) {
        std::ifstream in(resolved, std::ios::binary);
        if (in) previous.assign(std::istreambuf_iterator<char>(in),
                                std::istreambuf_iterator<char>());
    }
    const std::string &target = existed ? resolved : req.path;

    // A trailing slash on something that is not an existing directory is a
    // caller mistake: refuse it before creating anything (contract §四).
    if (!existed && req.path.size() > 1 && req.path.back() == '/') {
        return tool_error_result(error_code::kInvalidArgument,
            "write: " + req.path + ": trailing slash on a path that is not an "
            "existing directory; drop the slash to write a file there");
    }

    // Directories created by mkdir -p below; removed again if the write fails,
    // so a failed call leaves no side effects (contract §四).
    std::vector<std::string> created_dirs;

    std::ofstream f(req.path, std::ios::binary | std::ios::trunc);
    if (!f && errno == ENOENT) {
        // Auto-create parent directories (mkdir -p).
        std::string dir = req.path;
        auto slash = dir.rfind('/');
        if (slash != std::string::npos && slash > 0) {
            dir.resize(slash);
            for (size_t i = 1; i <= dir.size(); ++i) {
                if (i == dir.size() || dir[i] == '/') {
                    std::string part = dir.substr(0, i);
                    if (mkdir(part.c_str(), 0755) == 0)
                        created_dirs.push_back(part);
                }
            }
            f.open(req.path, std::ios::binary | std::ios::trunc);
        }
    }
    if (!f) {
        int err = errno;
        // rmdir only removes empty directories, so this cannot delete data.
        for (auto it = created_dirs.rbegin(); it != created_dirs.rend(); ++it)
            rmdir(it->c_str());
        return tool_error_result(errno_error_code(err),
            "write: cannot create file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }

    f.write(raw.data(), (std::streamsize)raw.size());
    f.close();
    if (!f) {
        int err = errno;
        const bool restored = restore_file(target, previous, existed);
        if (!existed) {
            for (auto it = created_dirs.rbegin(); it != created_dirs.rend(); ++it)
                rmdir(it->c_str());
        }
        json detail = {{"restored", restored}};
        return tool_error_result(errno_error_code(err),
            "write: failed writing to: " + req.path + ": " + errno_message(err) +
            (restored ? " (previous content restored)"
                      : " (the file may be incomplete)"),
            std::move(detail));
    }

    bool created = !existed;
    ToolResult tr;
    tr.text = "write: " + req.path + " (" +
              (created ? "created" : "overwrote existing") + ", " +
              std::to_string(raw.size()) + " bytes)";
    tr.structured = json{{"path", req.path},
                         {"bytes", (uint64_t)raw.size()},
                         {"created", created}};
    return tr;
}

static ToolResult tool_edit(const RpcRequest &req) {
    // Resolve path with macOS normalization fallback.
    struct stat st;
    std::string resolved_path = req.path;
    bool exists = (stat_normalized(req.path, &st, resolved_path) == 0);
    if (!exists) {
        int err = errno;   // ENOENT / ELOOP
        if (err == ENOENT) {
            if (auto broken = broken_symlink_result("edit", req.path))
                return *broken;
        }
        return tool_error_result(errno_error_code(err),
            "edit: cannot open file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }
    if (S_ISDIR(st.st_mode)) {
        return tool_error_result(error_code::kInvalidArgument,
            "edit: " + req.path + " is a directory; use bash (ls/find) to "
            "inspect it and pick a file to edit");
    }
    {
        ToolResult blocked;
        if (reject_blocking_target("edit", req.path, st.st_mode, blocked))
            return blocked;
    }
    // Editing reads the whole file and keeps a copy for rollback; refuse
    // targets beyond a documented bound (contract §四).
    static constexpr uint64_t kMaxEditFileBytes = 16ull * 1024 * 1024;  // 16 MiB
    if ((uint64_t)st.st_size > kMaxEditFileBytes) {
        return tool_error_result(error_code::kTooLarge,
            "edit: " + req.path + " is " + std::to_string(st.st_size) +
            " bytes, above the " + std::to_string(kMaxEditFileBytes) +
            "-byte edit limit; use bash (sed/perl) to change it in place",
            json{{"size", (uint64_t)st.st_size},
                 {"limit", kMaxEditFileBytes}});
    }

    // No edits requested: nothing to read, nothing to write (contract §四).
    if (req.edits.empty()) {
        ToolResult tr;
        tr.text = "edit: " + req.path + " (no changes)";
        tr.structured = json{{"path", req.path}, {"lines_added", 0},
                             {"lines_removed", 0}, {"first_changed_line", 0}};
        return tr;
    }

    // Read existing content (bounded by the size check above).
    std::ifstream fin(resolved_path, std::ios::binary);
    if (!fin) {
        int err = errno;
        return tool_error_result(errno_error_code(err),
            "edit: cannot open file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }
    std::ostringstream buf;
    buf << fin.rdbuf();
    const std::string original_bytes = buf.str();
    std::string content = original_bytes;
    fin.close();

    // BOM handling: strip UTF-8 BOM before matching, restore when writing.
    static const std::string utf8_bom = "\xEF\xBB\xBF";
    bool has_bom = (content.size() >= 3 && content.compare(0, 3, utf8_bom) == 0);
    if (has_bom)
        content.erase(0, 3);

    // CRLF handling: normalize to LF for matching, restore when writing.
    bool has_crlf = (content.find("\r\n") != std::string::npos);
    if (has_crlf) {
        std::string lf_content;
        lf_content.reserve(content.size());
        for (size_t i = 0; i < content.size(); ++i) {
            if (content[i] == '\r' && i + 1 < content.size() && content[i + 1] == '\n')
                continue;  // skip \r before \n
            lf_content.push_back(content[i]);
        }
        content = std::move(lf_content);
    }

    const std::string original = content;

    // Apply edits sequentially against the ORIGINAL content (per spec:
    // each edit matches original, not the result of previous edits).
    // To achieve this, collect all match positions in the original first,
    // then apply in reverse order.
    struct Match { size_t pos; size_t old_len; const EditOp *op; };
    std::vector<Match> matches;
    matches.reserve(req.edits.size());

    // Helper: strip trailing whitespace from each line.
    auto strip_trailing_ws = [](const std::string &s) -> std::string {
        std::string result;
        result.reserve(s.size());
        size_t line_start = 0;
        for (size_t i = 0; i <= s.size(); ++i) {
            if (i == s.size() || s[i] == '\n') {
                // Find end of non-whitespace in this line.
                size_t end = i;
                while (end > line_start && (s[end - 1] == ' ' || s[end - 1] == '\t'))
                    --end;
                result.append(s, line_start, end - line_start);
                if (i < s.size()) result.push_back('\n');
                line_start = i + 1;
            }
        }
        return result;
    };

    // Helper: build a mapping from positions in stripped text to positions
    // in the original text.  Each position in the stripped text corresponds
    // to a position in the original text.
    auto build_pos_map = [](const std::string &orig, const std::string &stripped)
        -> std::vector<size_t> {
        std::vector<size_t> map;
        map.reserve(stripped.size() + 1);
        size_t oi = 0;
        for (size_t si = 0; si < stripped.size(); ++si) {
            // Skip trailing whitespace that was removed.
            if (stripped[si] == '\n') {
                // In original, advance past trailing whitespace + newline.
                while (oi < orig.size() && orig[oi] != '\n')
                    ++oi;
            }
            map.push_back(oi);
            ++oi;
        }
        map.push_back(oi); // sentinel for end position
        return map;
    };

    for (const auto &op : req.edits) {
        if (op.old_text.empty()) {
            return tool_error_result(error_code::kInvalidArgument,
                "edit: oldText must not be empty");
        }
        // Normalize oldText line endings to match content (already LF-normalized).
        std::string old_normalized = op.old_text;
        if (has_crlf) {
            // Strip any \r\n → \n in oldText (LLMs may send either).
            std::string tmp;
            tmp.reserve(old_normalized.size());
            for (size_t i = 0; i < old_normalized.size(); ++i) {
                if (old_normalized[i] == '\r' && i + 1 < old_normalized.size() &&
                    old_normalized[i + 1] == '\n')
                    continue;
                tmp.push_back(old_normalized[i]);
            }
            old_normalized = std::move(tmp);
        }

        // Try exact match first.
        size_t pos = content.find(old_normalized);
        size_t match_len = old_normalized.size();

        if (pos == std::string::npos) {
            // Fuzzy: strip trailing whitespace from both, retry.
            std::string stripped_content = strip_trailing_ws(content);
            std::string stripped_old = strip_trailing_ws(old_normalized);
            size_t spos = stripped_content.find(stripped_old);
            if (spos == std::string::npos) {
                return tool_error_result(error_code::kInvalidArgument,
                    "edit: oldText not found in file: " +
                    utf8_safe_truncate(op.old_text, 40));
            }
            // Check uniqueness in stripped space.
            if (stripped_content.find(stripped_old, spos + 1) != std::string::npos) {
                return tool_error_result(error_code::kInvalidArgument,
                    "edit: oldText is not unique in file: " +
                    utf8_safe_truncate(op.old_text, 40));
            }
            // Map stripped position back to original content position.
            auto pos_map = build_pos_map(content, stripped_content);
            pos = pos_map[spos];
            size_t end_orig = pos_map[spos + stripped_old.size()];
            match_len = end_orig - pos;
        } else {
            // Check uniqueness for exact match.
            if (content.find(old_normalized, pos + 1) != std::string::npos) {
                return tool_error_result(error_code::kInvalidArgument,
                    "edit: oldText is not unique in file: " +
                    utf8_safe_truncate(op.old_text, 40));
            }
        }
        matches.push_back({pos, match_len, &op});
    }

    // Check for overlaps.
    std::sort(matches.begin(), matches.end(),
              [](const Match &a, const Match &b) { return a.pos < b.pos; });
    for (size_t i = 1; i < matches.size(); ++i) {
        size_t prev_end = matches[i-1].pos + matches[i-1].old_len;
        if (matches[i].pos < prev_end) {
            return tool_error_result(error_code::kInvalidArgument,
                "edit: overlapping edits are not allowed");
        }
    }

    // Result statistics, measured against the original text.
    auto count_lines = [](const std::string &s) -> size_t {
        if (s.empty()) return 0;
        size_t lines = 1;
        for (char c : s) if (c == '\n') ++lines;
        if (s.back() == '\n') --lines;
        return lines;
    };
    size_t lines_added = 0, lines_removed = 0, first_changed_line = 0;
    for (size_t i = 0; i < matches.size(); ++i) {
        const Match &m = matches[i];
        lines_removed += count_lines(original.substr(m.pos, m.old_len));
        lines_added   += count_lines(m.op->new_text);
        if (i == 0) {
            size_t line = 1;
            for (size_t k = 0; k < m.pos && k < original.size(); ++k)
                if (original[k] == '\n') ++line;
            first_changed_line = line;
        }
    }

    // Apply in reverse order so positions remain valid.
    // Normalize newText line endings: strip \r\n → \n (content is LF-normalized).
    for (auto it = matches.rbegin(); it != matches.rend(); ++it) {
        std::string new_text = it->op->new_text;
        if (has_crlf) {
            std::string tmp;
            tmp.reserve(new_text.size());
            for (size_t i = 0; i < new_text.size(); ++i) {
                if (new_text[i] == '\r' && i + 1 < new_text.size() &&
                    new_text[i + 1] == '\n')
                    continue;
                tmp.push_back(new_text[i]);
            }
            new_text = std::move(tmp);
        }
        content.replace(it->pos, it->old_len, new_text);
    }

    // Restore CRLF if the original file used it.
    if (has_crlf) {
        std::string crlf_content;
        crlf_content.reserve(content.size() + content.size() / 10);
        for (size_t i = 0; i < content.size(); ++i) {
            if (content[i] == '\n')
                crlf_content.push_back('\r');
            crlf_content.push_back(content[i]);
        }
        content = std::move(crlf_content);
    }

    // Restore BOM if the original file had one.
    if (has_bom)
        content.insert(0, utf8_bom);

    // Write result.  The write is in place on purpose: it keeps the inode,
    // hard links, the mode bits and the symlink itself, which callers rely on
    // (tests assert all four).  A no-op edit never reaches this point.
    if (content == original_bytes) {
        ToolResult tr;
        tr.text = "edit: " + req.path + " (no changes)";
        tr.structured = json{{"path", req.path}, {"lines_added", 0},
                             {"lines_removed", 0}, {"first_changed_line", 0}};
        return tr;
    }

    std::ofstream fout(resolved_path, std::ios::binary | std::ios::trunc);
    if (!fout) {
        int err = errno;
        return tool_error_result(errno_error_code(err),
            "edit: cannot write file: " + req.path + ": " + errno_message(err),
            errno_detail(err));
    }
    fout << content;
    fout.close();
    if (!fout) {
        int err = errno;
        const bool restored = restore_file(resolved_path, original_bytes, true);
        return tool_error_result(errno_error_code(err),
            "edit: failed writing to: " + req.path + ": " + errno_message(err) +
            (restored ? " (original content restored)"
                      : " (the file may be incomplete)"),
            json{{"restored", restored}});
    }

    ToolResult tr;
    tr.text = "edit: " + req.path + " (+" + std::to_string(lines_added) +
              " -" + std::to_string(lines_removed) +
              ", first change at line " + std::to_string(first_changed_line) + ")";
    tr.structured = json{{"path", req.path},
                         {"lines_added", (int64_t)lines_added},
                         {"lines_removed", (int64_t)lines_removed},
                         {"first_changed_line", (int64_t)first_changed_line}};
    return tr;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

// Run one built-in tool and serialize its result through the single
// result-serialization path.
static std::string run_builtin_tool(const RpcRequest &req) {
    ToolResult tr;
    if (!req.arg_error.empty()) {
        // Bad tool arguments are a tool error, not a protocol error.
        tr = tool_error_result(error_code::kInvalidArgument, req.arg_error);
        return rpc_serialize_tool_result(req.id, tr, true);
    }
    switch (req.tool) {
        case ToolKind::Read:           tr = tool_read(req);            break;
        case ToolKind::ViewImage:      tr = tool_view_image(req);      break;
        case ToolKind::Write:          tr = tool_write(req);           break;
        case ToolKind::Edit:           tr = tool_edit(req);            break;
        case ToolKind::TerminalRun:    tr = tool_terminal_run(req);    break;
        case ToolKind::TerminalSend:   tr = tool_terminal_send(req);   break;
        case ToolKind::TerminalOutput: tr = tool_terminal_output(req); break;
        case ToolKind::TerminalKill:   tr = tool_terminal_kill(req);   break;
        case ToolKind::TerminalList:   tr = tool_terminal_list(req);   break;
        default:
            tr = tool_error_result(error_code::kInvalidArgument,
                                   "unknown tool");
            break;
    }
    return rpc_serialize_tool_result(req.id, tr, tr.error.has_value());
}

// ---------------------------------------------------------------------------
// Non-blocking line reader
// ---------------------------------------------------------------------------

// Reads messages from a file descriptor.  Supports two transport formats:
//   (a) Newline-delimited JSON  — one JSON object per line terminated by '\n'.
//   (b) Content-Length framing  — "Content-Length: N\r\n\r\n" followed by N bytes.
// The mode is auto-detected from the first bytes received: if the buffer
// starts with "Content-Length:" we switch to framed mode; otherwise we use
// line mode.  Once detected the mode is fixed for the lifetime of the reader.
class LineReader {
public:
    explicit LineReader(int fd) : fd_(fd) {
        int flags = fcntl(fd, F_GETFL, 0);
        if (flags < 0) {
            eof_ = true;
            return;
        }
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }

    bool fill() {
        char tmp[8192];
        while (true) {
            ssize_t n = read(fd_, tmp, sizeof(tmp));
            if (n > 0) {
                if (buf_.size() + (size_t)n > kMaxBufferedInputBytes) {
                    overflowed_ = true;
                    eof_ = true;
                    return false;
                }
                buf_.append(tmp, (size_t)n);
                continue;
            }
            if (n == 0) { eof_ = true; return false; }
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
            // Any other read error (EBADF, EIO, fd invalidated, etc.) — treat as EOF.
            // Without this, callers see fill()==false but eof()==false and re-enter poll(),
            // which on macOS keeps returning POLLNVAL for an invalid stdin (e.g. parent
            // closed the pipe) → busy loop.
            eof_ = true;
            return false;
        }
    }

    bool get_line(std::string &line) {
        detect_mode();
        if (framed_) return get_framed(line);
        return get_newline(line);
    }

    bool has_line() {
        detect_mode();
        if (framed_) return has_framed();
        // Incremental scan: remember how much of buf_ is already known to
        // hold no newline, so a multi-MiB single line is not rescanned on
        // every poll iteration (that made the reader O(n^2)).
        if (buf_.find('\n', scanned_) == std::string::npos) {
            scanned_ = buf_.size();
            return false;
        }
        return true;
    }

    bool eof()    const { return eof_; }
    int  fd()     const { return fd_; }
    bool framed() const { return framed_; }
    bool overflowed() const { return overflowed_; }

private:
    static constexpr size_t kMaxBufferedInputBytes = kMaxTransportMessageBytes;

    int         fd_;
    std::string buf_;
    size_t      scanned_   = 0;   // bytes at the front of buf_ known to hold no '\n'
    bool        eof_       = false;
    bool        framed_    = false;
    bool        detected_  = false;
    bool        overflowed_ = false;

    void detect_mode() {
        if (detected_ || buf_.empty()) return;
        // Peek at first non-whitespace characters.
        size_t i = 0;
        while (i < buf_.size() && (buf_[i] == ' ' || buf_[i] == '\t' ||
                                    buf_[i] == '\r' || buf_[i] == '\n'))
            ++i;
        if (i >= buf_.size()) return; // not enough data yet
        static const char prefix[] = "Content-Length:";
        size_t remain = buf_.size() - i;
        size_t plen = sizeof(prefix) - 1;
        if (remain >= plen && buf_.compare(i, plen, prefix) == 0)
            framed_ = true;
        detected_ = true;
    }

    // Newline-delimited mode: return content up to '\n'.
    bool get_newline(std::string &line) {
        auto pos = buf_.find('\n', scanned_);
        if (pos == std::string::npos) {
            scanned_ = buf_.size();
            return false;
        }
        size_t end = (pos > 0 && buf_[pos - 1] == '\r') ? pos - 1 : pos;
        line = buf_.substr(0, end);
        buf_.erase(0, pos + 1);
        scanned_ = (scanned_ > pos + 1) ? scanned_ - (pos + 1) : 0;
        return true;
    }

    // Content-Length framed mode: parse header, then extract body.
    bool has_framed() const {
        auto hdr_end = buf_.find("\r\n\r\n");
        if (hdr_end == std::string::npos) return false;
        int content_length = parse_content_length(buf_, hdr_end);
        if (content_length < 0) return false;
        size_t body_start = hdr_end + 4;
        return buf_.size() >= body_start + (size_t)content_length;
    }

    bool get_framed(std::string &line) {
        auto hdr_end = buf_.find("\r\n\r\n");
        if (hdr_end == std::string::npos) return false;
        int content_length = parse_content_length(buf_, hdr_end);
        if (content_length < 0) {
            // Malformed header — skip past the header block.
            buf_.erase(0, hdr_end + 4);
            return false;
        }
        size_t body_start = hdr_end + 4;
        if (buf_.size() < body_start + (size_t)content_length) return false;
        line = buf_.substr(body_start, (size_t)content_length);
        buf_.erase(0, body_start + (size_t)content_length);
        return true;
    }

    static int parse_content_length(const std::string &buf, size_t hdr_end) {
        // Search for "Content-Length:" (case-insensitive) in the header block.
        std::string hdr = buf.substr(0, hdr_end);
        size_t pos = 0;
        while (pos < hdr.size()) {
            size_t eol = hdr.find("\r\n", pos);
            if (eol == std::string::npos) eol = hdr.size();
            std::string field = hdr.substr(pos, eol - pos);
            // "Content-Length: 123"
            size_t colon = field.find(':');
            if (colon != std::string::npos) {
                std::string name = field.substr(0, colon);
                // Case-insensitive compare.
                bool match = name.size() == 14;
                if (match) {
                    static const char cl[] = "content-length";
                    for (size_t i = 0; i < 14 && match; i++)
                        match = (std::tolower((unsigned char)name[i]) == cl[i]);
                }
                if (match) {
                    std::string val = field.substr(colon + 1);
                    // Trim whitespace.
                    size_t s = val.find_first_not_of(" \t");
                    if (s != std::string::npos) val = val.substr(s);
                    return std::atoi(val.c_str());
                }
            }
            pos = eol + 2;
        }
        return -1;
    }
};

// ---------------------------------------------------------------------------
// RPC event loop
// ---------------------------------------------------------------------------

void rpc_run_loop(int fd_in, int fd_out, WorkerPool &pool) {
    FILE *fout = fdopen(fd_out, "w");
    if (!fout) return;
    setvbuf(fout, nullptr, _IOLBF, 0);

    LineReader reader(fd_in);

    // Write a JSON-RPC message to fout.  Format depends on the transport
    // mode detected by the reader: Content-Length framed or newline-delimited.
    auto write_msg = [&](const std::string &body) {
        if (reader.framed()) {
            std::string hdr = "Content-Length: " +
                              std::to_string(body.size()) + "\r\n\r\n";
            fwrite(hdr.c_str(), 1, hdr.size(), fout);
            fwrite(body.c_str(), 1, body.size(), fout);
        } else {
            std::string line = body + '\n';
            fwrite(line.c_str(), 1, line.size(), fout);
        }
        fflush(fout);
    };

    auto write_resp = [&](const RpcResponse &resp) {
        write_msg(rpc_serialize_response(resp));
    };
    size_t in_flight = 0;

    // Each in-flight tool request gets its own socketpair.  A detached thread
    // runs the handler inside the coordinator's sandbox namespace and writes a
    // 4-byte LE length + serialized response; the event loop polls the read end
    // alongside worker sockets.  The id and the request are kept so a client
    // cancellation can be matched to it.
    struct ToolEntry {
        int          fd;
        nlohmann::json id;
        RpcRequest   req;
        bool         cancelled = false;   // client gave up: drop the response
    };
    std::vector<ToolEntry> pending_tools;

    // A cmd request that arrived when all workers were busy.  We hold exactly
    // one and stop reading stdin until a worker becomes available.
    std::optional<RpcRequest> buffered_cmd;

    // Dispatch a built-in tool on a detached background thread.  The coordinator
    // already lives inside the sandbox, so no sandbox_apply() is needed here.
    auto dispatch_tool_async = [&](const RpcRequest &req) {
        int sv[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
            // Extremely unlikely (fd exhaustion). Fall back to synchronous execution.
            try {
                write_msg(run_builtin_tool(req));
            } catch (...) {
                RpcResponse err;
                err.id = req.id;
                err.error = "internal error: tool handler crashed";
                err.is_protocol_error = true;
                write_resp(err);
            }
            return;
        }
        fcntl(sv[0], F_SETFD, FD_CLOEXEC);
        fcntl(sv[1], F_SETFD, FD_CLOEXEC);

        int write_fd = sv[1];
        std::thread([req, write_fd]() {
            try {
                std::string payload = run_builtin_tool(req) + '\n';
                uint32_t len = (uint32_t)payload.size();
                (void)write_all(write_fd, &len, sizeof(len));
                (void)write_all(write_fd, payload.data(), len);
            } catch (...) {
                // If anything above throws (e.g. nlohmann::json type_error),
                // send a synthetic error so the event loop doesn't hang.
                RpcResponse err;
                err.id = req.id;
                err.error = "internal error: tool handler crashed";
                err.is_protocol_error = true;
                std::string fallback = rpc_serialize_response(err) + '\n';
                uint32_t len = (uint32_t)fallback.size();
                (void)write_all(write_fd, &len, sizeof(len));
                (void)write_all(write_fd, fallback.data(), len);
            }
            close(write_fd);
        }).detach();

        pending_tools.push_back({sv[0], req.id, req, false});
        in_flight++;
    };

    // The client gave up on a request (notifications/cancelled; the official
    // SDK sends it when a tool call times out).  MCP gives a cancelled request
    // no reply at all, so the response is dropped - and whatever the request
    // was running is stopped, which is what keeps a runaway command from
    // outliving its caller (the server-side default timeout is only a net for
    // clients that die without saying anything).
    auto cancel_in_flight = [&](const nlohmann::json &id) {
        if (buffered_cmd.has_value() && buffered_cmd->id == id) {
            buffered_cmd.reset();          // not dispatched yet: forget it
            return;
        }
        if (pool.cancel(id))               // running in a worker: kill its group
            return;
        for (auto &t : pending_tools) {    // running on a tool thread
            if (t.id != id) continue;
            t.cancelled = true;
            // A tool thread cannot be interrupted, but a request that submitted
            // a command line to a terminal session can still stop it: the caller
            // who asked for that command is gone.  The session itself stays.
            const bool submitted_command =
                t.req.tool == ToolKind::TerminalRun ||
                (t.req.tool == ToolKind::TerminalSend && t.req.terminal_capture_status);
            if (submitted_command)
                terminal_interrupt(t.req.session_id);
        }
    };

    while (true) {
        try {
        // A signal asked us to stop (client gone, container stopping, Ctrl-C):
        // leave the loop without waiting for in-flight commands.  Callers rely
        // on cleanup (kill commands, sessions, workers) running before exit.
        if (rpc_shutdown_requested()) break;

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
                err.is_protocol_error = true;
                write_resp(err);
                continue;
            }

            // MCP notifications: no response.
            if (req.timeout_sec == -2) continue;

            // MCP cancellation: the client no longer waits for this request, so
            // stop its work and drop its response.
            if (req.timeout_sec == -3) {
                cancel_in_flight(req.cancel_id);
                continue;
            }

            // MCP protocol methods: respond synchronously.
            if (req.timeout_sec == -1) {
                std::string resp_body;
                if (req.cmd == "initialize")
                    resp_body = mcp_initialize_response(req.id, req.sandbox_json_raw);
                else if (req.cmd == "tools/list")
                    resp_body = mcp_tools_list_response(
                        req.id, pool.default_timeout_sec());
                write_msg(resp_body);
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
            // POLLNVAL must be handled too: on macOS, poll() on a non-blocking fd that
            // was redirected from /dev/null or whose pipe peer closed returns POLLNVAL.
            // Treating it like other error/eof events lets reader.fill() set eof_ and
            // breaks the busy loop.
            if (pfds[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) {
                if (!reader.fill() && reader.overflowed()) {
                    RpcResponse err;
                    err.id = nullptr;
                    err.error = "parse_error: request buffer exceeded 64 MiB";
                    err.is_protocol_error = true;
                    write_resp(err);
                }
            }
            pfd_off = 1;
        }

        for (size_t i = 0; i < busy.size(); i++) {
            if (pfds[pfd_off + i].revents & (POLLIN | POLLHUP | POLLERR)) {
                RpcResponse resp = pool.collect(busy[i].idx);
                if (!resp.suppressed) write_resp(resp);
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
            if (read_all(tfd, &len, sizeof(len)) &&
                len > 0 && len <= kMaxTransportMessageBytes) {
                std::string payload(len, '\0');
                if (read_all(tfd, &payload[0], len) && !pending_tools[i].cancelled) {
                    // payload includes trailing '\n' from the serializer;
                    // strip it so write_msg can apply the correct framing.
                    std::string body = payload;
                    if (!body.empty() && body.back() == '\n')
                        body.pop_back();
                    write_msg(body);
                }
            }
            close(tfd);
            done_tool_indices.push_back(i);
            in_flight--;
        }
        // Erase in reverse order so earlier indices remain valid.
        for (auto it = done_tool_indices.rbegin(); it != done_tool_indices.rend(); ++it)
            pending_tools.erase(pending_tools.begin() + (ptrdiff_t)*it);

        } catch (...) {
            // An unexpected exception (e.g. nlohmann::json type_error.316 from
            // dump() on a malformed id or error string) should not kill the
            // process.  Log and try to continue.
            static bool once;
            if (!once) {
                once = true;
                std::fprintf(stderr, "boxsh: unhandled exception in event loop"
                                     " — attempting to continue\n");
            }
            // Drain any pending worker completions so we don't deadlock.
            auto busy = pool.busy_entries();
            for (auto &b : busy) {
                pool.collect(b.idx);
                in_flight--;
            }
            // Close pending tool fds.
            for (auto &t : pending_tools) close(t.fd);
            pending_tools.clear();
            in_flight = 0;
            buffered_cmd.reset();
        }
    }

    fclose(fout);
}

} // namespace boxsh
