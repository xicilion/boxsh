#include "rpc.h"
#include "file_type.h"
#include "image_resize.h"
#include "terminal.h"
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
#include <sys/stat.h>
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

    // MCP notifications: no response needed.
    if (method == "notifications/initialized") {
        req.cmd = method;
        req.tool = ToolKind::None;
        req.timeout_sec = -2;    // flag for notifications
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
            if (args.contains("timeout") && args["timeout"].is_number())
                req.timeout_sec = args["timeout"].get<int>();
            return true;
        }
        if (tool_name == "read" || tool_name == "write" || tool_name == "edit") {
            if (!args.contains("path") || !args["path"].is_string()) {
                parse_error = tool_name + " tool missing string field: path";
                return false;
            }
            req.path = args["path"].get<std::string>();

            if (tool_name == "read") {
                req.tool = ToolKind::Read;
                if (args.contains("offset") && args["offset"].is_number_integer())
                    req.offset = args["offset"].get<int>();
                if (args.contains("limit") && args["limit"].is_number_integer())
                    req.limit = args["limit"].get<int>();
            } else if (tool_name == "write") {
                req.tool = ToolKind::Write;
                if (!args.contains("content") || !args["content"].is_string()) {
                    parse_error = "write tool missing string field: content";
                    return false;
                }
                req.content = args["content"].get<std::string>();
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
        // Terminal tools
        if (tool_name == "run_in_terminal") {
            req.tool = ToolKind::TerminalRun;
            if (!args.contains("command") || !args["command"].is_string()) {
                parse_error = "run_in_terminal missing string field: command";
                return false;
            }
            req.terminal_command = args["command"].get<std::string>();
            if (args.contains("cols") && args["cols"].is_number())
                req.terminal_cols = args["cols"].get<int>();
            if (args.contains("rows") && args["rows"].is_number())
                req.terminal_rows = args["rows"].get<int>();
            return true;
        }
        if (tool_name == "send_to_terminal") {
            req.tool = ToolKind::TerminalSend;
            if (!args.contains("id") || !args["id"].is_string()) {
                parse_error = "send_to_terminal missing string field: id";
                return false;
            }
            req.session_id = args["id"].get<std::string>();
            if (!args.contains("command") || !args["command"].is_string()) {
                parse_error = "send_to_terminal missing string field: command";
                return false;
            }
            req.terminal_command = args["command"].get<std::string>();
            return true;
        }
        if (tool_name == "kill_terminal") {
            req.tool = ToolKind::TerminalKill;
            if (!args.contains("id") || !args["id"].is_string()) {
                parse_error = "kill_terminal missing string field: id";
                return false;
            }
            req.session_id = args["id"].get<std::string>();
            return true;
        }
        if (tool_name == "list_terminals") {
            req.tool = ToolKind::TerminalList;
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

std::string rpc_serialize_response(const RpcResponse &resp) {
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = resp.id;

    if (resp.is_protocol_error && !resp.error.empty()) {
        // JSON-RPC 2.0 protocol error (parse error, unknown method, etc.).
        j["error"] = {{"code", resp.error_code}, {"message", resp.error}};
    } else {
        // MCP CallToolResult format.
        json result;
        bool is_error = !resp.error.empty();

        if (resp.tool == ToolKind::None) {
            // Bash command result.
            if (is_error) {
                result["content"] = json::array({{{"type", "text"}, {"text", resp.error}}});
            } else {
                json sc = {
                    {"exit_code",   resp.exit_code},
                    {"stdout",      resp.stdout_data},
                    {"stderr",      resp.stderr_data},
                    {"duration_ms", resp.duration_ms}
                };
                if (resp.stdout_truncated)
                    sc["stdout_truncated"] = true;
                if (resp.stderr_truncated)
                    sc["stderr_truncated"] = true;
                result["content"] = json::array({{{"type", "text"}, {"text", sc.dump()}}});
                result["structuredContent"] = sc;
                if (resp.exit_code != 0)
                    is_error = true;
            }
        } else if (resp.tool == ToolKind::Write) {
            std::string text = is_error ? resp.error : resp.tool_content;
            result["content"] = json::array({{{"type", "text"}, {"text", text}}});
        } else if (resp.tool == ToolKind::Edit) {
            std::string text = is_error ? resp.error : "OK";
            result["content"] = json::array({{{"type", "text"}, {"text", text}}});
            if (!is_error) {
                result["structuredContent"] = {
                    {"diff", resp.diff},
                    {"firstChangedLine", resp.first_changed_line}
                };
            }
        }

        if (is_error)
            result["isError"] = true;
        j["result"] = result;
    }

    return j.dump();
}

static std::string mcp_initialize_response(const json &id,
                                            const std::string &client_version) {
    // Echo the client's protocolVersion so the handshake succeeds.
    // Fall back to a known baseline if the client didn't supply one.
    std::string version = client_version.empty() ? "2024-11-05" : client_version;
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = id;
    j["result"] = {
        {"protocolVersion", version},
        {"capabilities", {
            {"tools", json::object()}
        }},
        {"serverInfo", {
            {"name", "boxsh"},
            {"version", BOXSH_VERSION}
        }}
    };
    return j.dump();
}

static std::string mcp_tools_list_response(const json &id) {
    json tools = json::array();

    // bash tool
    tools.push_back({
        {"name", "bash"},
        {"description",
         "Execute a bash command in the sandbox. "
         "Returns stdout and stderr. Output is truncated to 10MB per stream."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"command", {{"type", "string"}, {"description", "Bash command to execute"}}},
                {"timeout", {{"type", "number"}, {"description", "Timeout in seconds (optional)"}}}
            }},
            {"required", json::array({"command"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"exit_code", {{"type", "integer"}, {"description", "Process exit code (0 = success)"}}},
                {"stdout",    {{"type", "string"},  {"description", "Standard output"}}},
                {"stderr",    {{"type", "string"},  {"description", "Standard error"}}},
                {"duration_ms", {{"type", "integer"}, {"description", "Execution time in milliseconds"}}}
            }},
            {"required", json::array({"exit_code", "stdout", "stderr", "duration_ms"})}
        }},
        {"annotations", {
            {"title", "Bash"},
            {"readOnlyHint", false},
            {"destructiveHint", true}
        }}
    });

    // read tool
    tools.push_back({
        {"name", "read"},
        {"description",
         "Read the contents of a file. Binary files are returned as base64. "
         "Use offset/limit for large text files."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"description", "Path to the file to read (relative or absolute)"}}},
                {"offset", {{"type", "number"}, {"description", "Line number to start reading from (1-indexed, text files only)"}}},
                {"limit", {{"type", "number"}, {"description", "Maximum number of lines to read (text files only)"}}}
            }},
            {"required", json::array({"path"})}
        }},
        {"outputSchema", {
            {"type", "object"},
            {"properties", {
                {"content",   {{"type", "string"}, {"description", "File content (text or base64-encoded binary)"}}},
                {"encoding",  {{"type", "string"}, {"description", "\"text\" or \"base64\""}}},
                {"mime_type", {{"type", "string"}, {"description", "Detected MIME type"}}},
                {"line_count", {{"type", "integer"}, {"description", "Number of lines returned (text only)"}}},
                {"truncated", {{"type", "boolean"}, {"description", "Whether the output was truncated (text only)"}}},
                {"size",      {{"type", "integer"}, {"description", "File size in bytes (binary only)"}}}
            }},
            {"required", json::array({"content", "encoding", "mime_type"})}
        }},
        {"annotations", {
            {"title", "Read File"},
            {"readOnlyHint", true},
            {"destructiveHint", false}
        }}
    });

    // write tool
    tools.push_back({
        {"name", "write"},
        {"description",
         "Create a new file with the given content. "
         "Fails if the file already exists — use the edit tool to modify existing files."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"description", "Path to the file to write (relative or absolute)"}}},
                {"content", {{"type", "string"}, {"description", "Content to write to the file"}}}
            }},
            {"required", json::array({"path", "content"})}
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
        {"description",
         "Edit a file using exact text replacement. "
         "Every edits[].oldText must match a unique, non-overlapping region of the original file."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"description", "Path to the file to edit (relative or absolute)"}}},
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
                {"diff", {{"type", "string"}, {"description", "Unified diff of the changes made"}}},
                {"firstChangedLine", {{"type", "integer"}, {"description", "Line number of the first change (1-indexed)"}}}
            }},
            {"required", json::array({"diff", "firstChangedLine"})}
        }},
        {"annotations", {
            {"title", "Edit File"},
            {"readOnlyHint", false},
            {"destructiveHint", false}
        }}
    });

    // run_in_terminal tool
    tools.push_back({
        {"name", "run_in_terminal"},
        {"description",
         "Start a persistent PTY session running the given command (e.g. \"bash\"). "
         "Returns a session id and initial screen output. "
         "Use send_to_terminal to send further input, kill_terminal to close."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"command",     {{"type", "string"}, {"description", "Command to run in the PTY (e.g. bash)"}}},
                {"explanation", {{"type", "string"}, {"description", "Why this terminal is needed"}}},
                {"goal",        {{"type", "string"}, {"description", "What you intend to accomplish"}}}
            }},
            {"required", json::array({"command"})}
        }},
        {"annotations", {
            {"title", "Run in Terminal"},
            {"readOnlyHint", false},
            {"destructiveHint", false}
        }}
    });

    // send_to_terminal tool
    tools.push_back({
        {"name", "send_to_terminal"},
        {"description",
         "Send a command or text to an existing terminal session's stdin. "
         "Append \\n to execute as a shell command."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"id",      {{"type", "string"}, {"description", "Terminal session id"}}},
                {"command", {{"type", "string"}, {"description", "Text to write to the PTY stdin"}}}
            }},
            {"required", json::array({"id", "command"})}
        }},
        {"annotations", {
            {"title", "Send to Terminal"},
            {"readOnlyHint", false},
            {"destructiveHint", false}
        }}
    });

    // kill_terminal tool
    tools.push_back({
        {"name", "kill_terminal"},
        {"description",
         "Kill a terminal session and free its resources. Returns the final screen snapshot."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"id", {{"type", "string"}, {"description", "Terminal session id"}}}
            }},
            {"required", json::array({"id"})}
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
        {"description", "List all active terminal sessions."},
        {"inputSchema", {
            {"type", "object"},
            {"properties", json::object()},
            {"required", json::array()}
        }},
        {"annotations", {
            {"title", "List Terminals"},
            {"readOnlyHint", true},
            {"destructiveHint", false}
        }}
    });

    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = id;
    j["result"] = {{"tools", tools}};
    return j.dump();
}

// ---------------------------------------------------------------------------
// Terminal tool handlers
// ---------------------------------------------------------------------------

static std::string tool_terminal_run(const RpcRequest &req) {
    auto result = terminal_create(req.terminal_command,
                                  req.terminal_cols, req.terminal_rows);
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = req.id;
    json r;
    json sc = {{"id", result.id}, {"output", result.output}};
    r["content"] = json::array({{{"type", "text"}, {"text", sc.dump()}}});
    r["structuredContent"] = sc;
    j["result"] = r;
    return j.dump();
}

static std::string tool_terminal_send(const RpcRequest &req) {
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = req.id;
    json r;
    try {
        terminal_send(req.session_id, req.terminal_command);
        json sc = {{"ok", true}};
        r["content"] = json::array({{{"type", "text"}, {"text", sc.dump()}}});
        r["structuredContent"] = sc;
    } catch (const std::exception &e) {
        r["content"] = json::array({{{"type", "text"}, {"text", e.what()}}});
        r["isError"] = true;
    }
    j["result"] = r;
    return j.dump();
}

static std::string tool_terminal_kill(const RpcRequest &req) {
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = req.id;
    json r;
    try {
        std::string snap = terminal_kill(req.session_id);
        json sc = {{"output", snap}};
        r["content"] = json::array({{{"type", "text"}, {"text", sc.dump()}}});
        r["structuredContent"] = sc;
    } catch (const std::exception &e) {
        r["content"] = json::array({{{"type", "text"}, {"text", e.what()}}});
        r["isError"] = true;
    }
    j["result"] = r;
    return j.dump();
}

static std::string tool_terminal_list(const RpcRequest &req) {
    auto sessions = terminal_list();
    json arr = json::array();
    for (auto &s : sessions) {
        arr.push_back({{"id", s.id}, {"command", s.command},
                       {"alive", s.alive}, {"cols", s.cols}, {"rows", s.rows}});
    }
    std::string text = arr.dump();
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = req.id;
    json r;
    r["content"] = json::array({{{"type", "text"}, {"text", text}}});
    r["structuredContent"] = {{"sessions", arr}};
    j["result"] = r;
    return j.dump();
}

// ---------------------------------------------------------------------------
// RPC run loop
// ---------------------------------------------------------------------------

static std::string tool_read_json(const RpcRequest &req) {
    json j;
    j["jsonrpc"] = "2.0";
    j["id"] = req.id;
    json r;

    // Check file existence first.
    struct stat st;
    if (stat(req.path.c_str(), &st) != 0) {
        r["content"] = json::array({{{"type", "text"},
            {"text", std::string("read: cannot open file: ") + req.path +
                     ": " + strerror(errno)}}});
        r["isError"] = true;
        j["result"] = r;
        return j.dump();
    }

    // Detect binary via magic bytes.
    auto ft = detect_file_type(req.path);

    if (ft.binary) {
        bool is_image = (ft.mime.rfind("image/", 0) == 0);

        if (is_image) {
            // Image: read, resize if needed, return as MCP image content.
            std::ifstream f(req.path, std::ios::binary);
            if (!f) {
                r["content"] = json::array({{{"type", "text"},
                    {"text", std::string("read: cannot open file: ") + req.path +
                             ": " + strerror(errno)}}});
                r["isError"] = true;
                j["result"] = r;
                return j.dump();
            }
            std::string raw((std::istreambuf_iterator<char>(f)),
                             std::istreambuf_iterator<char>());

            auto img = resize_image(raw, ft.mime);
            if (img.data.empty()) {
                // Resize failed or unsupported image format — return metadata only.
                std::string text = std::string("[Image: ") + ft.mime +
                    ", " + std::to_string(raw.size()) +
                    " bytes — could not be processed for inline display]";
                json sc = {{"encoding", "metadata"}, {"mime_type", ft.mime},
                           {"size", (uint64_t)raw.size()}};
                r["content"] = json::array({{{"type", "text"}, {"text", text}}});
                r["structuredContent"] = std::move(sc);
            } else {
                // Return resized image via MCP image content block.
                std::string text = std::string("[Image: ") + img.mime_type + ", " +
                    std::to_string(img.width) + "x" + std::to_string(img.height);
                if (img.was_resized)
                    text += ", resized from " + std::to_string(img.original_width) +
                            "x" + std::to_string(img.original_height);
                text += "]";
                r["content"] = json::array({
                    {{"type", "text"}, {"text", text}},
                    {{"type", "image"}, {"data", std::move(img.data)},
                     {"mimeType", img.mime_type}},
                });
                json sc = {{"encoding", "image"}, {"mime_type", img.mime_type},
                           {"width", img.width}, {"height", img.height},
                           {"original_width", img.original_width},
                           {"original_height", img.original_height},
                           {"was_resized", img.was_resized},
                           {"size", (uint64_t)raw.size()}};
                r["structuredContent"] = std::move(sc);
            }
        } else {
            // Non-image binary: return metadata only (base64 is useless for LLMs).
            std::string text = std::string("[Binary file: ") + ft.mime +
                               ", " + std::to_string(st.st_size) + " bytes]";
            json sc = {{"encoding", "metadata"}, {"mime_type", ft.mime},
                       {"size", (uint64_t)st.st_size}};
            r["content"] = json::array({{{"type", "text"}, {"text", text}}});
            r["structuredContent"] = std::move(sc);
        }
    } else {
        // Text mode: line-based reading with offset/limit.
        // Default safety limits: 2000 lines AND 50KB, whichever triggers first.
        static constexpr int    DEFAULT_MAX_LINES = 2000;
        static constexpr size_t DEFAULT_MAX_BYTES = 50 * 1024;  // 50KB

        std::ifstream f(req.path);
        if (!f) {
            r["content"] = json::array({{{"type", "text"},
                {"text", std::string("read: cannot open file: ") + req.path +
                         ": " + strerror(errno)}}});
            r["isError"] = true;
            j["result"] = r;
            return j.dump();
        }

        std::string line;
        std::ostringstream out;
        int line_no   = 0;
        int start     = req.offset.value_or(1);
        int max_lines = req.limit.value_or(DEFAULT_MAX_LINES);
        int collected = 0;
        size_t total_bytes = 0;
        bool truncated = false;

        while (std::getline(f, line)) {
            ++line_no;
            if (line_no < start) continue;
            if (collected >= max_lines) { truncated = true; break; }
            size_t line_bytes = line.size() + 1;  // +1 for '\n'
            if (collected > 0 && total_bytes + line_bytes > DEFAULT_MAX_BYTES) {
                truncated = true;
                break;
            }
            out << line << '\n';
            total_bytes += line_bytes;
            ++collected;
        }

        // Count remaining lines to get total_lines.
        int total_lines = line_no;
        if (truncated) {
            while (std::getline(f, line))
                ++line_no;
            total_lines = line_no;
        }

        std::string text_content = out.str();
        // Validate UTF-8: nlohmann::json will reject invalid UTF-8 strings.
        // If the content is not valid UTF-8 (e.g. latin-1 detected as text
        // by libmagic), fall back to metadata only.
        try {
            json sc = {{"content", text_content}, {"encoding", "text"},
                       {"mime_type", ft.mime}, {"line_count", collected},
                       {"truncated", truncated}};
            if (truncated) {
                sc["total_lines"] = total_lines;
                sc["next_offset"] = start + collected;
            }
            // content[].text = plain text for LLM readability.
            // structuredContent carries the same content + metadata for programmatic access.
            r["content"] = json::array({{{"type", "text"}, {"text", text_content}}});
            r["structuredContent"] = std::move(sc);
        } catch (const json::exception &) {
            // Not valid UTF-8 — treat as binary, return metadata only.
            std::string summary = std::string("[Binary file: ") + ft.mime +
                                  ", " + std::to_string(st.st_size) + " bytes]";
            json sc = {{"encoding", "metadata"}, {"mime_type", ft.mime},
                       {"size", (uint64_t)st.st_size}};
            r["content"] = json::array({{{"type", "text"}, {"text", std::move(summary)}}});
            r["structuredContent"] = std::move(sc);
        }
    }

    j["result"] = r;
    return j.dump();
}

static RpcResponse tool_write(const RpcRequest &req) {
    RpcResponse resp;
    resp.id   = req.id;
    resp.tool = ToolKind::Write;

    // O_CREAT | O_EXCL: atomic create-only — fails if the file already exists.
    int fd = open(req.path.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (fd < 0 && errno == ENOENT) {
        // Auto-create parent directories (mkdir -p).
        std::string dir = req.path;
        auto slash = dir.rfind('/');
        if (slash != std::string::npos && slash > 0) {
            dir.resize(slash);
            // Iteratively create directories from root to leaf.
            for (size_t i = 1; i <= dir.size(); ++i) {
                if (i == dir.size() || dir[i] == '/') {
                    std::string part = dir.substr(0, i);
                    mkdir(part.c_str(), 0755);  // ignore EEXIST
                }
            }
            fd = open(req.path.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
        }
    }
    if (fd < 0) {
        if (errno == EEXIST)
            resp.error = std::string("write: file already exists: ") + req.path;
        else
            resp.error = std::string("write: cannot create file: ") + req.path +
                         ": " + strerror(errno);
        return resp;
    }

    const char *data = req.content.data();
    size_t remaining = req.content.size();
    while (remaining > 0) {
        ssize_t n = ::write(fd, data, remaining);
        if (n < 0) {
            close(fd);
            resp.error = std::string("write: failed writing to: ") + req.path +
                         ": " + strerror(errno);
            return resp;
        }
        data += n;
        remaining -= (size_t)n;
    }
    close(fd);
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
            resp.error = "edit: oldText must not be empty";
            return resp;
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
        bool fuzzy = false;

        if (pos == std::string::npos) {
            // Fuzzy: strip trailing whitespace from both, retry.
            std::string stripped_content = strip_trailing_ws(content);
            std::string stripped_old = strip_trailing_ws(old_normalized);
            size_t spos = stripped_content.find(stripped_old);
            if (spos == std::string::npos) {
                resp.error = "edit: oldText not found in file: " +
                             op.old_text.substr(0, 40);
                return resp;
            }
            // Check uniqueness in stripped space.
            if (stripped_content.find(stripped_old, spos + 1) != std::string::npos) {
                resp.error = "edit: oldText is not unique in file: " +
                             op.old_text.substr(0, 40);
                return resp;
            }
            // Map stripped position back to original content position.
            auto pos_map = build_pos_map(content, stripped_content);
            pos = pos_map[spos];
            size_t end_orig = pos_map[spos + stripped_old.size()];
            match_len = end_orig - pos;
            fuzzy = true;
        } else {
            // Check uniqueness for exact match.
            if (content.find(old_normalized, pos + 1) != std::string::npos) {
                resp.error = "edit: oldText is not unique in file: " +
                             op.old_text.substr(0, 40);
                return resp;
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
            resp.error = "edit: overlapping edits are not allowed";
            return resp;
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
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }

    bool fill() {
        char tmp[8192];
        while (true) {
            ssize_t n = read(fd_, tmp, sizeof(tmp));
            if (n > 0) {
                buf_.append(tmp, (size_t)n);
                continue;
            }
            if (n == 0) { eof_ = true; return false; }
            if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
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
        return buf_.find('\n') != std::string::npos;
    }

    bool eof()    const { return eof_; }
    int  fd()     const { return fd_; }
    bool framed() const { return framed_; }

private:
    int         fd_;
    std::string buf_;
    bool        eof_       = false;
    bool        framed_    = false;
    bool        detected_  = false;

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
        auto pos = buf_.find('\n');
        if (pos == std::string::npos) return false;
        size_t end = (pos > 0 && buf_[pos - 1] == '\r') ? pos - 1 : pos;
        line = buf_.substr(0, end);
        buf_.erase(0, pos + 1);
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
    // alongside worker sockets.
    struct ToolEntry { int fd; };
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
            RpcResponse resp;
            switch (req.tool) {
                case ToolKind::Write: resp = tool_write(req); break;
                case ToolKind::Edit:  resp = tool_edit(req);  break;
                default: break;
            }
            // Tools that produce pre-serialized JSON strings.
            std::string direct_payload;
            switch (req.tool) {
                case ToolKind::Read:         direct_payload = tool_read_json(req);     break;
                case ToolKind::TerminalRun:  direct_payload = tool_terminal_run(req);  break;
                case ToolKind::TerminalSend: direct_payload = tool_terminal_send(req); break;
                case ToolKind::TerminalKill: direct_payload = tool_terminal_kill(req); break;
                case ToolKind::TerminalList: direct_payload = tool_terminal_list(req); break;
                default: break;
            }
            if (!direct_payload.empty()) { write_msg(direct_payload); return; }
            write_resp(resp);
            return;
        }
        fcntl(sv[0], F_SETFD, FD_CLOEXEC);
        fcntl(sv[1], F_SETFD, FD_CLOEXEC);

        int write_fd = sv[1];
        std::thread([req, write_fd]() {
            // Tools that produce pre-serialized JSON.
            std::string direct_payload;
            switch (req.tool) {
                case ToolKind::Read:         direct_payload = tool_read_json(req);     break;
                case ToolKind::TerminalRun:  direct_payload = tool_terminal_run(req);  break;
                case ToolKind::TerminalSend: direct_payload = tool_terminal_send(req); break;
                case ToolKind::TerminalKill: direct_payload = tool_terminal_kill(req); break;
                case ToolKind::TerminalList: direct_payload = tool_terminal_list(req); break;
                default: break;
            }
            RpcResponse resp;
            if (direct_payload.empty()) {
                switch (req.tool) {
                    case ToolKind::Write: resp = tool_write(req); break;
                    case ToolKind::Edit:  resp = tool_edit(req);  break;
                    default: break;
                }
                direct_payload = rpc_serialize_response(resp);
            }
            std::string payload = direct_payload + '\n';
            uint32_t len = (uint32_t)payload.size();
            (void)write(write_fd, &len, 4);
            (void)write(write_fd, payload.c_str(), len);
            close(write_fd);
        }).detach();

        pending_tools.push_back({sv[0]});
        in_flight++;
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
                err.is_protocol_error = true;
                write_resp(err);
                continue;
            }

            // MCP notifications: no response.
            if (req.timeout_sec == -2) continue;

            // MCP protocol methods: respond synchronously.
            if (req.timeout_sec == -1) {
                std::string resp_body;
                if (req.cmd == "initialize")
                    resp_body = mcp_initialize_response(req.id, req.sandbox_json_raw);
                else if (req.cmd == "tools/list")
                    resp_body = mcp_tools_list_response(req.id);
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
                if (received == len) {
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
    }

    fclose(fout);
}

} // namespace boxsh
