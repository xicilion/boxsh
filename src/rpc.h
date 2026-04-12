#pragma once

#include <string>
#include <cstdint>
#include <vector>
#include <optional>

#include "../third_party/nlohmann/json.hpp"

namespace boxsh {

// ---------------------------------------------------------------------------
// Built-in tool types
// ---------------------------------------------------------------------------

enum class ToolKind { None, Read, Write, Edit,
    TerminalRun, TerminalSend, TerminalKill, TerminalList };

struct EditOp {
    std::string old_text;
    std::string new_text;
};

// ---------------------------------------------------------------------------
// RpcRequest
// ---------------------------------------------------------------------------

// A parsed RPC request from a single JSON line on stdin.
struct RpcRequest {
    nlohmann::json id;    // caller-assigned request id (echoed back, preserves type)
    std::string cmd;      // shell command string (only when tool == None)
    int timeout_sec = 0;  // 0 = no timeout

    // Optional per-request sandbox overrides (JSON key "sandbox").
    std::string sandbox_json_raw;

    // Built-in tool fields (non-None when "tool" key is present).
    ToolKind tool = ToolKind::None;

    // tool = "read"
    std::string path;
    std::optional<int> offset; // 1-indexed start line
    std::optional<int> limit;  // max lines to return

    // tool = "write"
    std::string content; // file content to write

    // tool = "edit"
    std::vector<EditOp> edits;

    // tool = terminal_*
    std::string session_id;
    std::string terminal_command;
    int         terminal_cols = 220;
    int         terminal_rows = 50;
};

// ---------------------------------------------------------------------------
// RpcResponse
// ---------------------------------------------------------------------------

// Result to be serialized as a single JSON line to stdout.
struct RpcResponse {
    nlohmann::json id;
    ToolKind tool = ToolKind::None;

    // Shell command result (tool == None)
    int exit_code = -1;
    std::string stdout_data;
    std::string stderr_data;
    uint64_t duration_ms = 0;
    bool stdout_truncated = false;
    bool stderr_truncated = false;

    // Built-in tool result
    std::string tool_content; // read: file text; write: confirmation

    // edit details
    std::string diff;
    int first_changed_line = 0;

    // Present on any failure (shell crash or tool error)
    int error_code = -32000; // JSON-RPC 2.0 error code
    std::string error;

    // When true, error is a protocol-level error (parse_error, unknown method)
    // and should be serialized as a JSON-RPC error response.
    // When false and error is set, it is a tool execution error and should be
    // serialized as MCP CallToolResult with isError=true.
    bool is_protocol_error = false;
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Serialize a response to a single JSON line (no trailing newline).
std::string rpc_serialize_response(const RpcResponse &resp);

// Parse one JSON line into an RpcRequest.
// Returns false and sets parse_error on failure.
bool rpc_parse_request(const std::string &line, RpcRequest &req,
                       std::string &parse_error);

// Forward declaration — avoids circular include with worker_pool.h.
class WorkerPool;

// Run the concurrent RPC event loop.
void rpc_run_loop(int fd_in, int fd_out, WorkerPool &pool);

} // namespace boxsh
