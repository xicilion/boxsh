#pragma once

#include <string>
#include <vector>

namespace boxsh {

// ---------------------------------------------------------------------------
// Terminal session info (for list_terminals)
// ---------------------------------------------------------------------------

struct TerminalInfo {
    std::string id;
    std::string command;
    bool        alive;
    int         cols;
    int         rows;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Shared output result returned by terminal_output(), and embedded in
// TerminalCreateResult.
struct TerminalOutputResult {
    std::string output;    // libvterm screen snapshot
    bool        exited;    // true if the process has exited
    int         exit_code; // exit code; -1 if not exited or signal-terminated
};

// Create a new PTY session running `command` (e.g. "bash").
// Waits up to `initial_wait_ms` for initial output before returning.
// Returns { id, output, exited, exit_code } on success, or throws
// std::runtime_error.
struct TerminalCreateResult {
    std::string id;
    std::string output;
    bool        exited;
    int         exit_code;
};
TerminalCreateResult terminal_create(const std::string &command,
                                     int cols = 220, int rows = 50,
                                     int initial_wait_ms = 500);

// Write text to a session's PTY stdin.
// Throws std::runtime_error if id is unknown or session has exited.
void terminal_send(const std::string &id, const std::string &text);

// Wait up to `wait_ms` for new output, then return the current screen
// snapshot together with exit status.  Unlike terminal_kill(), this does not
// free any resources.  Throws std::runtime_error if id is unknown.
TerminalOutputResult terminal_output(const std::string &id,
                                     int wait_ms = 500);

// Kill the session: send SIGHUP, drain final output, free resources.
// Returns the final libvterm screen snapshot.
// Throws std::runtime_error if id is unknown.
std::string terminal_kill(const std::string &id);

// Return metadata for all live and recently-exited sessions.
std::vector<TerminalInfo> terminal_list();

} // namespace boxsh
