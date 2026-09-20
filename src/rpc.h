#pragma once

#include <string>
#include <cstdint>
#include <vector>
#include <optional>

#include "error_codes.h"
#include "../third_party/nlohmann/json.hpp"

namespace boxsh {

// ---------------------------------------------------------------------------
// Built-in tool types
// ---------------------------------------------------------------------------

enum class ToolKind { None, Read, ViewImage, Write, Edit,
    TerminalRun, TerminalSend, TerminalOutput, TerminalKill, TerminalList };

struct EditOp {
    std::string old_text;
    std::string new_text;
};

// ---------------------------------------------------------------------------
// Tool result contract — documented in README.md ("Error model") and enforced
// by tests/tool-contract.test.mjs + tests/file-tools-robustness.test.mjs.
//
// Stable error codes live in src/error_codes.h — do not add new ones without
// updating the contract document first.

// Tool-level failure.  Serialized as isError:true with
// structuredContent = {code, message, detail?}.
struct ToolError {
    std::string code;    // one of error_code::*
    std::string message; // self-describing: "<tool>: <what happened>"
    std::optional<nlohmann::json> detail; // optional machine-readable payload
};

// One MCP image content block (already resized/encoded, base64 payload).
struct ImagePart {
    std::string data;
    std::string mime_type;
};

// Unified tool result.  Every tool produces one of these; serialization is
// done in exactly one place (rpc_serialize_tool_result).
struct ToolResult {
    std::optional<std::string>    text;       // model-readable representation
    std::optional<nlohmann::json> structured; // MUST match the tool's outputSchema
    std::vector<ImagePart>        images;     // non-empty => text MUST be set
    std::optional<ToolError>      error;      // tool failure (isError:true)

    // Keys inside `structured` whose string values may be cut when the encoded
    // result would exceed the result budget (bash: stdout/stderr, terminal:
    // stream).  Everything else is never touched: an image or a metadata field
    // is either delivered as is or reported as a failure (see rpc.cpp
    // "result budget").
    std::vector<std::string> trimmable_fields;
};

// Convenience constructors.
ToolResult tool_error_result(const std::string &code,
                             const std::string &message,
                             std::optional<nlohmann::json> detail = std::nullopt);

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

    // tool = "view_image"
    std::string image_detail = "auto"; // "auto" | "low"

    // tool = "write"
    std::string content; // file content to write
    std::string encoding = "text"; // "text" (default) or "base64"

    // tool = "edit"
    std::vector<EditOp> edits;

    // tool = terminal_*
    std::string session_id;
    std::string terminal_command;
    int         terminal_cols = 220;
    int         terminal_rows = 50;
    // Shared terminal read options (see src/terminal.h).
    int                    terminal_wait_ms  = -1;   // -1 = not given
    std::string            terminal_wait_for;         // "" | output | exit
    std::optional<uint64_t> terminal_cursor;          // raw-log cursor
    bool                   terminal_capture_status = false;
    bool                   terminal_include_exited = false;
    std::string            terminal_signal;           // send_to_terminal: INT/TERM/…

    // Set when the tool arguments themselves are wrong.  The parser accepts the
    // request (so the tool kind is known) and the dispatcher turns this into a
    // tool error — E_INVALID_ARGUMENT — rather than a protocol error, which is
    // what the tool result contract asks for.
    std::string arg_error;

    // Set for notifications/cancelled: the id of the request the client gave up
    // on (string or number).  Requests are never answered as notifications, but
    // this one has to be acted upon.
    nlohmann::json cancel_id;
};

// ---------------------------------------------------------------------------
// RpcResponse
// ---------------------------------------------------------------------------

// Result to be serialized as a single JSON line to stdout.
// Used for shell command (bash) results and protocol-level errors; built-in
// tool results go through ToolResult / rpc_serialize_tool_result instead.
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
    bool timed_out = false;

    // Timeout that was in force for this command (0 = none) and whether it
    // came from the server default (--command-timeout) rather than from the
    // request.  Lets the result tell a caller "pass timeout to run longer".
    int  timeout_sec = 0;
    bool timeout_from_server_default = false;

    // Present on any failure (shell crash or tool error)
    int error_code = -32000; // JSON-RPC 2.0 error code
    std::string error;

    // When true, error is a protocol-level error (parse_error, unknown method)
    // and should be serialized as a JSON-RPC error response.
    // When false and error is set, it is a tool execution error and should be
    // serialized as MCP CallToolResult with isError=true.
    bool is_protocol_error = false;

    // True when the client cancelled this request while it was running: MCP
    // gives a cancelled request no reply at all, so the event loop drops this
    // response instead of writing it.
    bool suppressed = false;
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Serialize a response to a single JSON line (no trailing newline).
std::string rpc_serialize_response(const RpcResponse &resp);

// Serialize a unified tool result as one JSON-RPC 2.0 response line
// (no trailing newline).  is_error must be true for failures — either a tool
// error (tr.error) or a non-zero command exit (bash).
std::string rpc_serialize_tool_result(const nlohmann::json &id,
                                      const ToolResult &tr, bool is_error);

// Build the unified result for a shell command (bash tool) response.
ToolResult tool_result_from_bash(const RpcResponse &resp);

// Budget for one serialized tool result, in *encoded* bytes (0 = no limit).
// Exceeding a client's stdio read buffer is fatal for the whole session - the
// official SDK drops its buffer and closes the transport - so this is enforced
// on the JSON that actually goes out (see rpc.cpp).  Set once at startup from
// --max-result-bytes.
void rpc_set_result_budget(size_t encoded_bytes);
size_t rpc_result_budget();

// Parse one JSON line into an RpcRequest.
// Returns false and sets parse_error on failure.
bool rpc_parse_request(const std::string &line, RpcRequest &req,
                       std::string &parse_error);

// Forward declaration — avoids circular include with worker_pool.h.
class WorkerPool;
// Run the concurrent RPC event loop.
void rpc_run_loop(int fd_in, int fd_out, WorkerPool &pool);

// Ask the RPC event loop to shut down cleanly (called from a signal handler,
// so both functions stay async-signal-safe).
void rpc_request_shutdown();
bool rpc_shutdown_requested();

} // namespace boxsh
