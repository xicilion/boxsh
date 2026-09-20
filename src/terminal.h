#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// PTY sessions ("terminal tools")
//
// A session has two output channels:
//
//   * the rendered screen (libvterm) — what an interactive program drew, with
//     escape sequences applied.  This is a *view*: at most `rows` lines, so
//     anything that scrolled off is gone (exactly like a real terminal).
//   * the raw log — every byte read from the PTY master, kept in a bounded
//     ring.  This is the lossless channel: an absolute byte cursor addresses
//     it, so a caller can read deltas instead of re-reading the screen.
//
// Callers that treat a session as a command runner read the raw log (and, for
// shell sessions, use `capture_status` to get a per-command exit code);
// callers that drive interactive programs read the screen.
// ---------------------------------------------------------------------------

namespace boxsh {

// ---------------------------------------------------------------------------
// Session metadata (for list_terminals)
// ---------------------------------------------------------------------------

struct TerminalInfo {
    std::string id;
    std::string command;
    bool        alive;
    int         cols;
    int         rows;
    int         exit_code;      // valid when !alive (-1 when killed by a signal)
    uint64_t    total_bytes;    // bytes received from the PTY since start
    uint64_t    retained_bytes; // bytes still readable from the raw log
    bool        truncated;      // earlier output was dropped from the log
    int64_t     age_ms;         // since the session was created
    int64_t     idle_ms;        // since the last output (or the process exit)
};

// ---------------------------------------------------------------------------
// Read options
// ---------------------------------------------------------------------------

// What a read waits for before returning.
enum class TerminalWait {
    None,   // return immediately
    Output, // new output or process exit (historical behaviour, default)
    Exit    // wait for the session's process to exit
};

struct TerminalReadOptions {
    int          wait_ms  = 500;             // 0 = return at once
    TerminalWait wait_for = TerminalWait::Output;
    // Absolute cursor into the raw log, taken from a previous result's
    // `next_cursor`.  Absent = start at the oldest retained byte, i.e. "give me
    // everything you still have".
    std::optional<uint64_t> cursor;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Result of a read.  `output` is the rendered screen; the raw-log fields are
// filled in when the caller asked for the stream channel.
struct TerminalOutputResult {
    std::string output;    // rendered screen snapshot
    bool        exited;    // the session's process has exited
    int         exit_code; // valid when exited (-1 for a signal)

    // Raw-log channel: `stream` holds the bytes in
    // [requested cursor (or oldest retained byte), next_cursor).
    bool        with_stream  = false; // false: the stream was not requested
    std::string stream;
    uint64_t    first_cursor = 0;     // oldest cursor still retained
    uint64_t    next_cursor  = 0;     // pass as `cursor` to continue reading
    uint64_t    total_bytes  = 0;     // bytes received since session start
    bool        truncated    = false; // the requested cursor was already dropped
    uint64_t    dropped_bytes = 0;    // bytes dropped from the log since start
    // True when the session produced more lines than the rendered screen can
    // show: `output` is a partial view and only the stream has everything.
    bool        screen_partial = false;
};

// Create a new PTY session running `command` through `/bin/sh -c`.  Waits
// according to `opts` before returning the first read result.
struct TerminalCreateResult {
    std::string         id;
    TerminalOutputResult out;
};
TerminalCreateResult terminal_create(const std::string &command,
                                     int cols = 220, int rows = 50,
                                     const TerminalReadOptions &opts = {});

// Result of a write to a session.
struct TerminalSendResult {
    TerminalOutputResult out;
    // Set when `capture_status` was requested on a shell session and the
    // status probe reported back: the exit code of the command line that was
    // just submitted (not the session's own exit code).
    bool has_command_exit_code = false;
    int  command_exit_code     = 0;
};

// Write `text` to a session's PTY stdin, then read the result.
//
// `capture_status` submits the text as a shell command line and appends a
// self-erasing status probe, so the command's exit code comes back in
// TerminalSendResult::command_exit_code.  Shell sessions only: the probe is
// input, so an interactive program (a REPL, a pager) would just see garbage.
// Throws TerminalError if id is unknown or the session has exited.
TerminalSendResult terminal_send(const std::string &id, const std::string &text,
                                 const TerminalReadOptions &opts = {},
                                 bool capture_status = false);

// Read a session without writing to it.
//
// The raw-log channel is included when the caller treats the session as a data
// channel — i.e. when `opts.cursor` is set or `opts.wait_for` is Exit — and
// stays out of a plain screen poll, so a polling loop can never pull the whole
// log by accident.  Throws TerminalError if id is unknown.
TerminalOutputResult terminal_read(const std::string &id,
                                   const TerminalReadOptions &opts = {});

// Kill the session: signal its process group, drain the final output and free
// the resources.  `cursor` selects the raw delta that is returned (see
// TerminalReadOptions::cursor).  Throws TerminalError if id is unknown.
struct TerminalKillResult {
    std::string output;       // final screen snapshot
    bool        killed;       // a signal had to be delivered
    int         exit_code;    // session exit code (-1 when signalled)
    std::string stream;       // raw delta (from `cursor`, else from the start)
    uint64_t    first_cursor = 0;
    uint64_t    next_cursor  = 0;
    bool        truncated    = false;
    uint64_t    dropped_bytes = 0;
};
TerminalKillResult terminal_kill(const std::string &id,
                                 const std::optional<uint64_t> &cursor = {});

// Return metadata for every live session plus exited sessions that have not
// been reaped yet (see TerminalConfig::ttl_sec).
std::vector<TerminalInfo> terminal_list();

// Kill every session and free its resources.  Called when the server is
// shutting down: session children are in their own session/process group, so
// they outlive boxsh unless they are signalled here.  Each session's process
// group gets SIGTERM and then SIGKILL, so a shell that ignores SIGTERM (an
// interactive one does) cannot hold the shutdown up.  Safe to call when no
// session exists, or twice.
void terminal_shutdown_all();

// ---------------------------------------------------------------------------
// Limits and lifecycle
// ---------------------------------------------------------------------------

// Resource limits.  `log_limit_bytes` bounds the raw log retained per session
// (the ring keeps at least this much, then drops from the front — and reports
// `truncated`/`dropped_bytes`, so output loss is never silent); `max_sessions`
// bounds live sessions; `ttl_sec` reaps exited sessions (0 = keep them).
struct TerminalConfig {
    size_t log_limit_bytes = 1024u * 1024u;
    int    max_sessions    = 32;
    int    ttl_sec         = 600;
};
void terminal_set_config(const TerminalConfig &cfg);

// Reap exited sessions whose TTL expired (or that exceed the retained-session
// bound).  Called from every entry point; exposed for tests.
void terminal_sweep();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Stable tool error codes (see src/error_codes.h) so the RPC layer can map a
// failure to the right code without matching on message text.
class TerminalError : public std::runtime_error {
public:
    TerminalError(const std::string &code, const std::string &message)
        : std::runtime_error(message), code_(code) {}
    const std::string &code() const { return code_; }

private:
    std::string code_;
};

} // namespace boxsh
