#include "terminal.h"

#include "error_codes.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <poll.h>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>   // posix_openpt, grantpt, unlockpt, ptsname
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#include "vterm.h"

// ---------------------------------------------------------------------------
// Session model
//
// One reader thread per session drains the PTY master.  Everything it reads
// goes to two places:
//
//   * a libvterm screen — the rendered view that an interactive caller looks
//     at (escape sequences applied, at most `rows` lines, so it loses whatever
//     scrolled off, exactly like a real terminal);
//   * a bounded raw log — the lossless byte channel, addressed by an absolute
//     cursor (log_base + offset).  Trimming the ring never invalidates a
//     cursor, it only sets `truncated`, so output loss is always reported.
//
// A read never blocks the event loop: the RPC layer runs every tool call on a
// background thread, so waiting up to `wait_ms` for output or for process exit
// costs nothing elsewhere.
// ---------------------------------------------------------------------------

namespace boxsh {
namespace {

using Clock = std::chrono::steady_clock;

constexpr int kDefaultCols = 220;
constexpr int kDefaultRows = 50;
constexpr int kMinCols     = 20;
constexpr int kMaxCols     = 1000;
constexpr int kMinRows     = 1;
constexpr int kMaxRows     = 1000;

// Reader tuning.  A burst is published when the writer pauses for
// kBurstGraceMs, or early once it grows past kBurstMaxBytes / kBurstMaxMs, so
// a firehose (yes(1), a build log) cannot hold a publish back indefinitely.
constexpr int    kBurstGraceMs  = 15;
constexpr size_t kBurstMaxBytes = 64 * 1024;
constexpr int    kBurstMaxMs    = 100;

// How long kill()/shutdown waits for a signal to take effect before
// escalating.  An interactive shell ignores SIGHUP, hence the escalation.
constexpr int kKillWaitMs = 1000;

// Log trimming: the front is dropped only once the ring is over limit + slack,
// then trimmed back to the limit.  Trimming on every append would memmove the
// whole log for a session that prints faster than the cap.
constexpr size_t kLogSlackMin = 64 * 1024;

// ---------------------------------------------------------------------------
// capture_status probe
//
// `capture_status` submits a command line and wants its exit code back, so
// boxsh appends one extra command line that prints the shell's $? as an OSC
// sequence:
//
//   printf '\033]9999;boxsh-status=%d\a' $?
//
// The OSC payload is never drawn by a terminal, so the probe adds no cursor
// movement and no erasing of its own (an earlier version prefixed CR + CSI K to
// hide its own echo, which instead ate the last line of a command whose output
// did not end in a newline — a tty echo can only be hidden before it happens).
// What the caller sees is therefore one extra echoed command line, which boxsh
// strips — together with the marker — from the text, the raw stream and the
// rendered screen it returns (strip_status_noise / strip_probe_echo_lines).
// OSC 9999 is not a sequence any terminal acts on, and it is consumed by
// boxsh's own vterm.
// ---------------------------------------------------------------------------

const char kStatusLine[]      = "printf '\\033]9999;boxsh-status=%d\\a' $?\n";
const char kStatusLineCrlf[]  = "printf '\\033]9999;boxsh-status=%d\\a' $?\r\n";
const char kStatusOscPrefix[] = "\033]9999;boxsh-status=";
constexpr size_t kStatusOscPrefixLen = sizeof(kStatusOscPrefix) - 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

int64_t ms_since(Clock::time_point t) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t).count();
}

std::string generate_uuid() {
    static std::mt19937_64 rng{std::random_device{}()};
    std::uniform_int_distribution<uint64_t> dist;
    uint64_t hi = dist(rng);
    uint64_t lo = dist(rng);

    // Set version (4) and variant bits (10xx)
    hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
    lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;

    char buf[37];
    snprintf(buf, sizeof(buf),
             "%08x-%04x-%04x-%04x-%012llx",
             (unsigned)(hi >> 32),
             (unsigned)((hi >> 16) & 0xFFFF),
             (unsigned)(hi & 0xFFFF),
             (unsigned)(lo >> 48),
             (unsigned long long)(lo & 0x0000FFFFFFFFFFFFULL));
    return buf;
}

// ---------------------------------------------------------------------------
// Internal TerminalSession
// ---------------------------------------------------------------------------

struct TerminalSession {
    std::string  id;
    std::string  command;
    pid_t        child_pid  = -1;
    int          fd_master  = -1;
    std::string  slave_path;          // ptsname(fd_master), for tcgetpgrp()
    int          cols       = kDefaultCols;
    int          rows       = kDefaultRows;

    VTerm       *vt         = nullptr;
    VTermScreen *screen     = nullptr;

    std::mutex               mu;
    std::condition_variable  cv;
    uint64_t                 generation = 0;   // incremented on read/exit

    std::thread  reader_thread;
    bool         exited    = false;
    int          exit_code = -1;

    // Raw log.  `log` holds the retained bytes and `log_base` is the absolute
    // offset of log[0], so trimming the front never shifts a cursor; the bytes
    // that were dropped are counted in `dropped`.
    std::string log;
    uint64_t    log_base = 0;
    uint64_t    dropped  = 0;
    uint64_t    total_lines = 0;  // newlines seen, for "is the screen partial?"

    // Where the next cursor-less read starts: 0 (everything retained) at first,
    // advanced to the end of every stream a read returns, so polling a session
    // costs nothing while it is idle and never repeats what was already read.
    uint64_t    read_cursor = 0;

    // capture_status bookkeeping.
    std::string scan_tail;            // last bytes, so a probe split across
                                      // two reads is still recognised
    bool        status_pending     = false;
    bool        probe_used         = false; // the screen hides the probe echo
    uint64_t    status_seq         = 0; // sequence of the newest probe
    uint64_t    status_pending_seq = 0;
    uint64_t    status_done_seq    = 0; // newest probe whose value was parsed
    int         status_code        = 0;

    Clock::time_point created_at     = Clock::now();
    Clock::time_point last_output_at = Clock::now();
    Clock::time_point exited_at      = Clock::now();

    uint64_t total_bytes() const { return log_base + log.size(); }
};

TerminalConfig g_cfg;

// ---------------------------------------------------------------------------
// TerminalManager singleton
// ---------------------------------------------------------------------------

struct TerminalManager {
    std::mutex                                                       map_mu;
    std::unordered_map<std::string, std::shared_ptr<TerminalSession>> sessions;

    static TerminalManager &instance() {
        static TerminalManager mgr;
        return mgr;
    }

    std::shared_ptr<TerminalSession> get(const std::string &id) {
        std::lock_guard<std::mutex> lk(map_mu);
        auto it = sessions.find(id);
        if (it == sessions.end()) return nullptr;
        return it->second;
    }

    void add(std::shared_ptr<TerminalSession> s) {
        std::lock_guard<std::mutex> lk(map_mu);
        sessions[s->id] = s;
    }

    void remove(const std::string &id) {
        std::lock_guard<std::mutex> lk(map_mu);
        sessions.erase(id);
    }

    std::vector<std::shared_ptr<TerminalSession>> all() {
        std::lock_guard<std::mutex> lk(map_mu);
        std::vector<std::shared_ptr<TerminalSession>> v;
        v.reserve(sessions.size());
        for (auto &kv : sessions) v.push_back(kv.second);
        return v;
    }
};

// ---------------------------------------------------------------------------
// Screen snapshot helper
// ---------------------------------------------------------------------------

std::string screen_snapshot(VTermScreen *screen, int rows, int cols) {
    if (!screen) return std::string();
    std::string result;
    result.reserve((size_t)rows * ((size_t)cols + 1));

    // One row can hold up to four UTF-8 bytes per cell; size the scratch buffer
    // for that so vterm never has to cut a row short.
    std::vector<char> buf((size_t)cols * 4 + 2);

    // Find last non-empty row.
    int last_row = 0;
    for (int r = rows - 1; r >= 0; --r) {
        VTermRect rect = {r, r + 1, 0, cols};
        size_t n = vterm_screen_get_text(screen, buf.data(), buf.size(), rect);
        // Trim trailing whitespace/nulls from this row.
        while (n > 0 && (buf[n-1] == ' ' || buf[n-1] == '\0')) --n;
        if (n > 0) { last_row = r; break; }
    }

    for (int r = 0; r <= last_row; ++r) {
        VTermRect rect = {r, r + 1, 0, cols};
        size_t n = vterm_screen_get_text(screen, buf.data(), buf.size(), rect);
        // Trim trailing spaces.
        while (n > 0 && buf[n-1] == ' ') --n;
        result.append(buf.data(), n);
        result += '\n';
    }

    return result;
}

// ---------------------------------------------------------------------------
// Raw log
// ---------------------------------------------------------------------------

// Append raw PTY bytes, trimming the front when the ring is over its limit.
void log_append(TerminalSession &s, const char *data, size_t n) {
    s.log.append(data, n);

    const size_t limit = g_cfg.log_limit_bytes;
    if (limit == 0) return;
    const size_t slack = std::max(limit / 8, kLogSlackMin);
    if (s.log.size() <= limit + slack) return;

    size_t drop = s.log.size() - limit;
    s.log.erase(0, drop);
    s.log_base += drop;
    s.dropped  += drop;
}

// Bytes in [cursor or the session's read cursor, end of log).
struct LogSlice {
    std::string data;
    uint64_t    begin     = 0;
    uint64_t    end       = 0;
    bool        truncated = false;
};

LogSlice log_slice(const TerminalSession &s, const std::optional<uint64_t> &cursor) {
    LogSlice out;
    out.end = s.total_bytes();
    uint64_t begin = cursor.value_or(s.read_cursor);
    if (begin < s.log_base) {
        // The position the caller asked for (or the session's read cursor) is
        // older than anything kept: say so instead of silently returning a gap.
        out.truncated = true;
        begin = s.log_base;
    }
    if (begin > out.end) begin = out.end;
    out.begin = begin;
    out.data  = s.log.substr((size_t)(begin - s.log_base));
    return out;
}

// A stream is always attached; what the *text* shows is decided in the RPC
// layer (screen vs delta).  Kept as a helper so the rule stays in one place.
bool wants_stream(const TerminalReadOptions &) {
    return true;
}

// ---------------------------------------------------------------------------
// capture_status probe parsing / scrubbing
// ---------------------------------------------------------------------------

// Look for the status probe in freshly read bytes.  The marker can straddle
// two reads, so the scan window starts a few bytes before the new data.
void scan_status(TerminalSession &s, const std::string &fresh) {
    std::string window;
    window.reserve(s.scan_tail.size() + fresh.size());
    window += s.scan_tail;
    window += fresh;

    if (s.status_pending) {
        size_t pos = 0;
        while ((pos = window.find(kStatusOscPrefix, pos)) != std::string::npos) {
            size_t p = pos + kStatusOscPrefixLen;
            long code = 0;
            bool digits = false;
            while (p < window.size() && window[p] >= '0' && window[p] <= '9') {
                code = code * 10 + (window[p] - '0');
                digits = true;
                if (code > 1000000) break;
                ++p;
            }
            if (digits && p < window.size() && (unsigned char)window[p] == 0x07) {
                s.status_code     = (int)code;
                s.status_done_seq = s.status_pending_seq;
                s.status_pending  = false;
                s.generation++;          // wake a waiter that is not watching bytes
                break;
            }
            pos += kStatusOscPrefixLen;
        }
    }

    if (window.size() > kStatusOscPrefixLen)
        window.erase(0, window.size() - kStatusOscPrefixLen);
    s.scan_tail = std::move(window);
}

// Remove boxsh's own status probe noise from a raw stream region: the OSC
// marker and the echoed probe command line (a tty echoes what is typed).  Both
// are fixed byte patterns, so this is a pure function of the region and
// cursors stay consistent across reads.
std::string strip_status_noise(const std::string &raw) {
    std::string out = raw;

    size_t pos = 0;
    while ((pos = out.find(kStatusOscPrefix, pos)) != std::string::npos) {
        size_t end = pos + kStatusOscPrefixLen;
        while (end < out.size() && out[end] >= '0' && out[end] <= '9') ++end;
        if (end < out.size() && (unsigned char)out[end] == 0x07)
            out.erase(pos, end + 1 - pos);   // marker + BEL
        else
            pos += kStatusOscPrefixLen;
    }

    const std::string echo(kStatusLineCrlf);
    for (size_t p = 0; (p = out.find(echo, p)) != std::string::npos;)
        out.erase(p, echo.size());

    return out;
}

// Same idea for the rendered screen: a tty echo cannot be un-done (it happens
// before the probe runs), so the probe's own command line is dropped from what
// a caller is shown.  The screen has no escape sequences left by this point, so
// this is a line-level filter: a row that *is* the probe echo disappears, and on
// a row where it merely continues earlier text the tail from the probe on is cut.
std::string strip_probe_echo_lines(const std::string &screen_text) {
    const std::string probe(kStatusLine, sizeof(kStatusLine) - 2); // no trailing \n
    std::string out;
    out.reserve(screen_text.size());
    size_t pos = 0;
    while (pos < screen_text.size()) {
        size_t nl = screen_text.find('\n', pos);
        if (nl == std::string::npos) nl = screen_text.size();
        std::string line = screen_text.substr(pos, nl - pos);
        while (!line.empty() && line.back() == ' ') line.pop_back();
        if (line == probe) {
            // Drop the whole row (keep the newline so line numbering holds).
            if (nl < screen_text.size()) out += '\n';
        } else {
            // A row that continues earlier text (no trailing newline in front of
            // the echo): cut from the probe on.
            size_t at  = screen_text.find(probe, pos);
            size_t end = (at != std::string::npos && at < nl) ? at : nl;
            out.append(screen_text, pos, end - pos);
            if (nl < screen_text.size()) out += '\n';
        }
        pos = nl + 1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Reader thread: drains the PTY master → raw log + vterm
// ---------------------------------------------------------------------------

void reader_thread_fn(std::shared_ptr<TerminalSession> s) {
    const int fd = s->fd_master;
    if (fd < 0) return;

    char buf[8192];
    std::string burst;
    Clock::time_point burst_start = Clock::now();

    // Publish everything accumulated so far, then (when the slave is gone)
    // record the child's exit status.
    auto publish = [&](bool is_eof) {
        int status = 0;
        int code   = -1;
        if (is_eof) {
            pid_t w = waitpid(s->child_pid, &status, 0);
            if (w == s->child_pid)
                code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            // w < 0 (ECHILD): something else reaped it (the sandbox's SIGCHLD
            // reaper) — the exit code is simply unknown.
        }

        std::lock_guard<std::mutex> lk(s->mu);
        if (!burst.empty()) {
            log_append(*s, burst.data(), burst.size());
            if (s->vt) {
                vterm_input_write(s->vt, burst.data(), burst.size());
                vterm_screen_flush_damage(s->screen);
            }
            scan_status(*s, burst);
            s->total_lines += (uint64_t)std::count(burst.begin(), burst.end(), '\n');
            s->last_output_at = Clock::now();
            s->generation++;
            burst.clear();
        }
        if (is_eof) {
            if (s->fd_master >= 0) {
                close(s->fd_master);
                s->fd_master = -1;
            }
            s->exited    = true;
            s->exit_code = code;
            s->exited_at = Clock::now();
            s->generation++;
        }
        s->cv.notify_all();
    };

    while (true) {
        // Wait for output.  poll() rather than a blocking read is what makes
        // the burst below possible; it also reports POLLHUP, i.e. "the slave
        // side is gone", which becomes EOF on the next read.
        struct pollfd pfd{};
        pfd.fd     = fd;
        pfd.events = POLLIN;
        int pr = poll(&pfd, 1, -1);
        if (pr < 0) {
            if (errno == EINTR) continue;  // signal: re-poll, the slave closes too
            break;
        }
        if (pr == 0) continue;

        // Drain everything that is ready into one burst.  Publishing per read
        // instead would let a caller observe a half-drawn screen, and a command
        // that exits right after writing would be reported as still running.
        // The burst is only cleared by publish(), so the grace poll below can
        // keep accumulating from one wakeup to the next.
        if (burst.empty()) burst_start = Clock::now();
        bool eof = false;
        while (true) {
            ssize_t n = read(fd, buf, sizeof(buf));
            if (n > 0) {
                burst.append(buf, (size_t)n);
                if (burst.size() >= kBurstMaxBytes) break;
                if (ms_since(burst_start) >= kBurstMaxMs) break;
                continue;
            }
            if (n == 0) { eof = true; break; }                  // slave closed
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) break; // burst drained
            eof = true; break;                                  // EIO, …
        }

        if (!eof && !burst.empty()) {
            // Short grace period before publishing: a process that writes and
            // exits immediately (sh -c "no such command") closes the slave a
            // moment later, and waiting for it here means one call reports the
            // exit code instead of two.
            struct pollfd again{};
            again.fd     = fd;
            again.events = POLLIN;
            if (poll(&again, 1, kBurstGraceMs) > 0) continue;
        }

        publish(eof);
        if (eof) break;
    }
}

// ---------------------------------------------------------------------------
// Reading helpers (callers hold s->mu)
// ---------------------------------------------------------------------------

TerminalOutputResult read_locked(const TerminalSession &s,
                                 const TerminalReadOptions &opts,
                                 bool with_stream) {
    TerminalOutputResult r;
    r.output        = screen_snapshot(s.screen, s.rows, s.cols);
    if (s.probe_used) r.output = strip_probe_echo_lines(r.output);
    r.exited        = s.exited;
    r.exit_code     = s.exited ? s.exit_code : -1;
    r.total_bytes   = s.total_bytes();
    r.first_cursor  = s.log_base;
    r.dropped_bytes = s.dropped;
    r.next_cursor   = r.total_bytes;
    r.screen_partial =
        s.total_lines > (uint64_t)std::count(r.output.begin(), r.output.end(), '\n');

    if (with_stream) {
        LogSlice sl    = log_slice(s, opts.cursor);
        r.stream       = strip_status_noise(sl.data);
        r.first_cursor = sl.begin;
        r.next_cursor  = sl.end;
        r.truncated    = sl.truncated;
    }
    return r;
}

// Consume the returned delta: the next cursor-less read continues from here.
void advance_read_cursor(TerminalSession &s, const TerminalOutputResult &r) {
    if (r.next_cursor > s.read_cursor) s.read_cursor = r.next_cursor;
}

// Wait inside a read.  `gen0` is captured before the wait so that the default
// ("output") condition means "something arrived since this call started".
//
// "output" is also settled: the very first bytes after a write are the tty's
// echo of the command line, while the command's own output is still in flight.
// Returning on them hands a caller a result that looks truncated; waiting for a
// short quiet gap instead makes a quick command complete in one call.  The gap
// is deliberately generous: a busy machine (a CI runner, a loaded laptop) can
// pause for tens of milliseconds between the echo and the command's first line,
// and the cost of waiting is only paid when output has already stopped arriving.
// Anything longer than this belongs to the caller: `capture_status` waits for
// the command's real exit, and a cursor poll collects the rest.
constexpr int kOutputSettleMs = 100;

void wait_for_read(std::unique_lock<std::mutex> &lk, TerminalSession &s,
                   const TerminalReadOptions &opts, uint64_t gen0,
                   bool want_status, uint64_t status_seq) {
    if (opts.wait_ms <= 0) return;
    const auto deadline = Clock::now() + std::chrono::milliseconds(opts.wait_ms);

    auto ready = [&]() -> bool {
        if (s.exited) return true;
        if (want_status) return s.status_done_seq >= status_seq;
        if (opts.wait_for == TerminalWait::Exit) return false;   // s.exited checked above
        return s.generation != gen0;                             // Output
    };

    if (!ready())
        s.cv.wait_until(lk, deadline, ready);

    if (want_status || opts.wait_for != TerminalWait::Output) return;

    // Settle: keep waiting while output keeps arriving, until it has been quiet
    // for kOutputSettleMs or the budget is gone.
    auto quiet_at = Clock::now() + std::chrono::milliseconds(kOutputSettleMs);
    while (!s.exited) {
        auto until = std::min(quiet_at, deadline);
        if (Clock::now() >= until) break;
        uint64_t gen = s.generation;
        if (!s.cv.wait_until(lk, until, [&]{ return s.exited || s.generation != gen; }))
            break;                                    // quiet for the whole gap
        quiet_at = Clock::now() + std::chrono::milliseconds(kOutputSettleMs);
    }
}

std::shared_ptr<TerminalSession> require_session(const std::string &id) {
    // Every terminal entry point starts here, so this is where exited sessions
    // that outlived their TTL are reaped.
    terminal_sweep();
    auto s = TerminalManager::instance().get(id);
    if (!s) throw TerminalError(error_code::kNotFound, "unknown terminal session: " + id);
    return s;
}

// Wait up to `timeout_ms` for the session's process to be reaped.
bool wait_for_exit(const std::shared_ptr<TerminalSession> &s, int timeout_ms) {
    std::unique_lock<std::mutex> lk(s->mu);
    return s->cv.wait_for(lk, std::chrono::milliseconds(timeout_ms),
                          [&]{ return s->exited; });
}

// Write the whole buffer, waiting for the PTY to drain if its input fills up.
void write_all(TerminalSession &s, const std::string &data) {
    size_t off = 0;
    while (off < data.size()) {
        ssize_t n = write(s.fd_master, data.data() + off, data.size() - off);
        if (n > 0) { off += (size_t)n; continue; }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd pfd{};
            pfd.fd     = s.fd_master;
            pfd.events = POLLOUT;
            if (poll(&pfd, 1, 1000) > 0) continue;
            throw TerminalError(error_code::kTimeout,
                                "timed out writing to terminal session " + s.id);
        }
        // EIO (or a closed master) means the session went away while we were
        // writing: that is a "no such session" from the caller's point of view,
        // not an internal error.
        if (s.exited || errno == EIO)
            throw TerminalError(error_code::kNotFound,
                                "terminal session has exited: " + s.id);
        throw TerminalError(error_code::kInternal, "write to PTY failed: " + s.id);
    }
}

// Signal names accepted by send_to_terminal.  A curated set: the interesting
// ones for a session are INT (abort what it is running), KILL (make it stop
// ignoring TERM) and the job-control pair STOP/CONT.  Interactive shells ignore
// SIGTERM and SIGQUIT by POSIX, so those two are accepted but rarely useful.
struct SignalName { const char *name; int sig; };
const SignalName kSignalNames[] = {
    {"INT", SIGINT}, {"TERM", SIGTERM}, {"KILL", SIGKILL}, {"HUP", SIGHUP},
    {"QUIT", SIGQUIT}, {"USR1", SIGUSR1}, {"USR2", SIGUSR2},
    {"STOP", SIGSTOP}, {"CONT", SIGCONT},
};

int signal_from_name(const std::string &name) {
    for (const auto &s : kSignalNames)
        if (name == s.name) return s.sig;
    return 0;
}

std::string signal_name_list() {
    std::string out;
    for (const auto &s : kSignalNames) {
        if (!out.empty()) out += ", ";
        out += s.name;
    }
    return out;
}

// Foreground process group of the session's terminal, or -1 when it cannot be
// read.  This is the group a physical terminal's Ctrl-C reaches: the job the
// shell is running, not the shell itself.
//
// The master is asked first: TIOCGPGRP works there on macOS *and* Linux (unlike
// TIOCSWINSZ, which only the slave accepts).  Opening the slave as a fallback
// mimics what a terminal emulator does — briefly, with O_NOCTTY so it does not
// become *our* controlling terminal, and closed right away so that EOF
// detection (which is what marks a session exited) stays intact.
int foreground_pgrp(const TerminalSession &s) {
    errno = 0;
    pid_t fg = s.fd_master >= 0 ? tcgetpgrp(s.fd_master) : -1;
    if (fg > 0) return (int)fg;

    if (s.slave_path.empty()) return -1;
    int fds = open(s.slave_path.c_str(), O_RDWR | O_NOCTTY);
    if (fds < 0) return -1;
    fg = tcgetpgrp(fds);
    close(fds);
    return fg > 0 ? (int)fg : -1;
}

// Deliver a signal the way "stop what you are doing" is meant to work.
//
// Two targets, because they do different jobs:
//   * the *foreground* process group is what a physical Ctrl-C hits - the
//     command that is running, which is what actually stops it;
//   * the shell's own process group is what makes the shell abandon the rest of
//     its command line.  Interactive shells decide this themselves and the
//     rules differ between versions (bash 3.2 abandons on its own SIGINT, bash
//     5.x only when the foreground job died from one), so both are signalled.
// Returns false when neither group could be reached (everything already gone).
bool deliver_signal(const TerminalSession &s, int sig) {
    bool delivered = false;
    int fg = foreground_pgrp(s);
    if (fg > 0 && kill(-fg, sig) == 0) delivered = true;
    if (kill(-s.child_pid, sig) == 0) delivered = true;
    return delivered;
}

// Free a session's resources and drop it from the table.  Only valid once the
// reader thread has stopped (s->exited): the reader writes into the vterm.
void reap_session(const std::shared_ptr<TerminalSession> &s) {
    {
        std::lock_guard<std::mutex> lk(s->mu);
        if (s->vt) {
            vterm_free(s->vt);
            s->vt     = nullptr;
            s->screen = nullptr;
        }
        s->log.clear();
    }
    TerminalManager::instance().remove(s->id);
}

} // anonymous namespace

// ---------------------------------------------------------------------------
// Public API implementation
// ---------------------------------------------------------------------------

void terminal_set_config(const TerminalConfig &cfg) {
    g_cfg = cfg;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

void terminal_sweep() {
    const auto sessions = TerminalManager::instance().all();
    if (sessions.empty()) return;

    std::vector<std::pair<Clock::time_point, std::shared_ptr<TerminalSession>>> exited;
    std::vector<std::shared_ptr<TerminalSession>> dead;

    for (auto &s : sessions) {
        std::lock_guard<std::mutex> lk(s->mu);
        if (!s->exited) continue;
        exited.emplace_back(s->exited_at, s);
        if (g_cfg.ttl_sec > 0 && ms_since(s->exited_at) >= (int64_t)g_cfg.ttl_sec * 1000)
            dead.push_back(s);
    }

    // Keep the table bounded even before the TTL expires: an agent that runs
    // one-shot commands creates one exited session per call.
    if (g_cfg.max_sessions > 0 && (int)exited.size() > g_cfg.max_sessions) {
        std::sort(exited.begin(), exited.end(),
                  [](const auto &a, const auto &b) { return a.first < b.first; });
        for (size_t i = 0; i + (size_t)g_cfg.max_sessions < exited.size(); ++i)
            dead.push_back(exited[i].second);
    }

    if (dead.empty()) return;
    std::sort(dead.begin(), dead.end(),
              [](const auto &a, const auto &b) { return a->id < b->id; });
    dead.erase(std::unique(dead.begin(), dead.end(),
                           [](const auto &a, const auto &b) { return a->id == b->id; }),
               dead.end());
    for (auto &s : dead) reap_session(s);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

TerminalCreateResult terminal_create(const std::string &command,
                                     int cols, int rows,
                                     const TerminalReadOptions &opts) {
    if (cols < kMinCols || cols > kMaxCols)
        throw TerminalError(error_code::kInvalidArgument,
            "run_in_terminal: cols must be between " + std::to_string(kMinCols) +
            " and " + std::to_string(kMaxCols));
    if (rows < kMinRows || rows > kMaxRows)
        throw TerminalError(error_code::kInvalidArgument,
            "run_in_terminal: rows must be between " + std::to_string(kMinRows) +
            " and " + std::to_string(kMaxRows));
    if (command.empty())
        throw TerminalError(error_code::kInvalidArgument,
                            "run_in_terminal: command must not be empty");

    terminal_sweep();
    {
        int live = 0;
        for (auto &s : TerminalManager::instance().all())
            if (!s->exited) live++;
        if (g_cfg.max_sessions > 0 && live >= g_cfg.max_sessions)
            throw TerminalError(error_code::kTooManySessions,
                "run_in_terminal: " + std::to_string(g_cfg.max_sessions) +
                " terminal sessions are already running; kill_terminal one "
                "before starting another");
    }

    // Open PTY master.
    int fdm = posix_openpt(O_RDWR | O_NOCTTY);
    if (fdm < 0) throw TerminalError(error_code::kInternal, "posix_openpt failed");

#ifdef __APPLE__
    // On macOS grantpt() is a no-op; both grantpt/unlockpt may fail in
    // sandboxed environments (Seatbelt).  The slave device is still
    // accessible via ptsname(), so treat failure as non-fatal.
    if (grantpt(fdm) < 0 || unlockpt(fdm) < 0) {
        // non-fatal on macOS — proceed with the PTY
    }
#else
    if (grantpt(fdm) < 0 || unlockpt(fdm) < 0) {
        int e = errno;
        close(fdm);
        throw TerminalError(error_code::kInternal,
            std::string("grantpt/unlockpt failed: ") + std::strerror(e));
    }
#endif

    // PTY window size.  It has to be applied to the *slave* once that is open:
    // on macOS/BSD TIOCSWINSZ on the master fails with ENOTTY, which is why
    // `stty size` used to report 0 0 while boxsh rendered the screen at
    // cols x rows — programs that ask the tty for its size then wrapped at 80
    // columns while the screen wrapped at `cols`, garbling long input lines.
    struct winsize ws{};
    ws.ws_col = (unsigned short)cols;
    ws.ws_row = (unsigned short)rows;

    // Fork child.
    pid_t pid = fork();
    if (pid < 0) {
        close(fdm);
        throw TerminalError(error_code::kInternal, "fork failed");
    }

    if (pid == 0) {
        // Child: open PTY slave as controlling terminal.
        setsid();
        const char *slave_name = ptsname(fdm);
        int fds = open(slave_name, O_RDWR);
        if (fds < 0) _exit(1);
        ioctl(fds, TIOCSWINSZ, &ws);
#ifdef TIOCSCTTY
        ioctl(fds, TIOCSCTTY, 0);
#endif
        dup2(fds, STDIN_FILENO);
        dup2(fds, STDOUT_FILENO);
        dup2(fds, STDERR_FILENO);
        if (fds > STDERR_FILENO) close(fds);
        close(fdm);

        // Set TERM so apps behave correctly.
        setenv("TERM", "xterm-256color", 1);

        execl("/bin/sh", "sh", "-c", command.c_str(), (char *)nullptr);
        _exit(127);
    }

    // Parent: build session.
    auto s = std::make_shared<TerminalSession>();
    s->id        = generate_uuid();
    s->command   = command;
    s->child_pid = pid;
    s->fd_master = fdm;
    if (const char *slave = ptsname(fdm)) s->slave_path = slave;
    s->cols      = cols;
    s->rows      = rows;

    // The reader drains through poll(), so the master stays non-blocking; the
    // write path waits for POLLOUT when the PTY input buffer fills up.
    int flags = fcntl(fdm, F_GETFL, 0);
    if (flags >= 0) fcntl(fdm, F_SETFL, flags | O_NONBLOCK);

    s->vt = vterm_new(rows, cols);
    vterm_set_utf8(s->vt, 1);
    s->screen = vterm_obtain_screen(s->vt);
    vterm_screen_enable_altscreen(s->screen, 1);
    vterm_screen_reset(s->screen, 1);

    TerminalManager::instance().add(s);

    // Start reader thread (captures shared_ptr for lifetime).
    s->reader_thread = std::thread(reader_thread_fn, s);
    s->reader_thread.detach();

    TerminalCreateResult res;
    res.id = s->id;
    {
        std::unique_lock<std::mutex> lk(s->mu);
        uint64_t gen0 = s->generation;
        wait_for_read(lk, *s, opts, gen0, false, 0);
        res.out = read_locked(*s, opts, wants_stream(opts));
        advance_read_cursor(*s, res.out);
    }
    return res;
}

// ---------------------------------------------------------------------------
// Send / read
// ---------------------------------------------------------------------------

TerminalSendResult terminal_send(const std::string &id, const std::string &text,
                                 const TerminalSendOptions &opts) {
    auto s = require_session(id);

    int sig = 0;
    if (!opts.signal.empty()) {
        sig = signal_from_name(opts.signal);
        if (sig == 0)
            throw TerminalError(error_code::kInvalidArgument,
                "send_to_terminal: unknown signal \"" + opts.signal +
                "\"; expected one of " + signal_name_list());
    }

    // Write and read are one operation: the lock is held across both so a
    // concurrent read cannot observe the write without its result.
    std::unique_lock<std::mutex> lk(s->mu);
    if (s->exited)
        throw TerminalError(error_code::kNotFound, "terminal session has exited: " + id);

    std::string payload = text;
    uint64_t status_seq = 0;
    if (opts.capture_status) {
        if (payload.empty() || payload.back() != '\n') payload += '\n';
        payload += kStatusLine;
        // Arm the probe *before* writing: the shell may already execute the
        // probe line before this thread gets the lock back.
        s->status_seq++;
        status_seq            = s->status_seq;
        s->status_pending_seq = status_seq;
        s->status_pending     = true;
        s->probe_used         = true;
    }

    if (!payload.empty())
        write_all(*s, payload);

    if (sig != 0) {
        // ESRCH just means everything already exited: not an error.
        if (!deliver_signal(*s, sig) && errno != ESRCH)
            throw TerminalError(error_code::kInternal,
                "failed to send SIG" + opts.signal + " to terminal session " + id);
    }

    uint64_t gen0 = s->generation;
    wait_for_read(lk, *s, opts.read, gen0, opts.capture_status, status_seq);

    TerminalSendResult r;
    r.out = read_locked(*s, opts.read, wants_stream(opts.read));
    advance_read_cursor(*s, r.out);
    if (opts.capture_status && s->status_done_seq >= status_seq) {
        r.has_command_exit_code = true;
        r.command_exit_code     = s->status_code;
    }
    return r;
}

TerminalOutputResult terminal_read(const std::string &id,
                                   const TerminalReadOptions &opts) {
    auto s = require_session(id);
    std::unique_lock<std::mutex> lk(s->mu);
    uint64_t gen0 = s->generation;
    wait_for_read(lk, *s, opts, gen0, false, 0);
    TerminalOutputResult r = read_locked(*s, opts, wants_stream(opts));
    advance_read_cursor(*s, r);
    return r;
}

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

TerminalKillResult terminal_kill(const std::string &id) {
    auto s = require_session(id);

    bool need_signal = false;
    {
        std::lock_guard<std::mutex> lk(s->mu);
        need_signal = !s->exited;
    }

    if (need_signal) {
        // The child called setsid(), so it leads its own process group: -pid
        // reaches every job the session started (otherwise a shell leaves
        // `yes | head` style grandchildren behind).  SIGHUP is only a request
        // and an interactive shell ignores it, so escalate to SIGKILL — which
        // also releases the PTY slave, the only thing that wakes the reader.
        kill(-s->child_pid, SIGHUP);
        if (!wait_for_exit(s, kKillWaitMs)) {
            kill(-s->child_pid, SIGKILL);
            wait_for_exit(s, kKillWaitMs);
        }
    }

    TerminalKillResult r;
    LogSlice slice;
    {
        std::lock_guard<std::mutex> lk(s->mu);
        r.output        = screen_snapshot(s->screen, s->rows, s->cols);
        if (s->probe_used) r.output = strip_probe_echo_lines(r.output);
        // A kill is the last chance to read the session, so it returns
        // everything still retained.
        slice           = log_slice(*s, 0);
        r.exit_code     = s->exited ? s->exit_code : -1;
        r.stream        = strip_status_noise(slice.data);
        r.first_cursor  = slice.begin;
        r.next_cursor   = slice.end;
        r.truncated     = slice.truncated;
        r.dropped_bytes = s->dropped;
        r.killed        = need_signal;
    }

    // Close fd_master to force EOF in a reader that is somehow still running,
    // but only after the wait above: close(2) on an fd the reader is blocked
    // in read(2) on does not return until that read does, so an unconditional
    // close here would hang the whole server for a session that holds on.
    // Freeing the vterm state is only safe once the reader has stopped writing
    // into it; a session whose PTY slave is held open by a grandchild the
    // signal never reached is dropped without its state instead.
    {
        std::lock_guard<std::mutex> lk(s->mu);
        if (s->exited) {
            if (s->fd_master >= 0) {
                close(s->fd_master);
                s->fd_master = -1;
            }
            if (s->vt) {
                vterm_free(s->vt);
                s->vt     = nullptr;
                s->screen = nullptr;
            }
        }
    }

    TerminalManager::instance().remove(id);
    return r;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

void terminal_interrupt(const std::string &id) {
    auto s = TerminalManager::instance().get(id);
    if (!s) return;
    std::lock_guard<std::mutex> lk(s->mu);
    if (s->exited) return;
    // Both targets, exactly like `signal: "INT"`: the foreground job stops what
    // is running, and the shell abandons the rest of that command line - a
    // cancelled call asked for the command, so leaving `cmd1; cmd2` to continue
    // would be the wrong kind of silence.  The shell itself survives, and with it
    // the session and its state.
    deliver_signal(*s, SIGINT);
}

std::vector<TerminalInfo> terminal_list() {
    terminal_sweep();
    auto sessions = TerminalManager::instance().all();
    std::vector<TerminalInfo> result;
    result.reserve(sessions.size());
    for (auto &s : sessions) {
        std::lock_guard<std::mutex> lk(s->mu);
        TerminalInfo info;
        info.id             = s->id;
        info.command        = s->command;
        info.alive          = !s->exited;
        info.cols           = s->cols;
        info.rows           = s->rows;
        info.exit_code      = s->exit_code;
        info.total_bytes    = s->total_bytes();
        info.retained_bytes = s->log.size();
        info.truncated      = s->dropped > 0;
        info.age_ms         = ms_since(s->created_at);
        info.idle_ms        = s->exited ? ms_since(s->exited_at)
                                        : ms_since(s->last_output_at);
        result.push_back(std::move(info));
    }
    return result;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

void terminal_shutdown_all() {
    auto sessions = TerminalManager::instance().all();
    for (auto &s : sessions) {
        const pid_t pid = s->child_pid;

        // terminal_create() calls setsid() in the child, so the child is the
        // leader of its own process group: signalling -pid reaches every job
        // the session started, not just the shell itself.  SIGTERM is only a
        // request — an interactive shell ignores it — so anything still alive
        // gets SIGKILL, which it cannot ignore.
        if (pid > 0) kill(-pid, SIGTERM);
        if (!wait_for_exit(s, 500)) {
            if (pid > 0) kill(-pid, SIGKILL);
            wait_for_exit(s, 1000);
        }

        // Do NOT close the PTY master here.  close(2) on an fd another thread
        // is blocked in read(2) on does not return until that read does, so
        // closing while the reader is still draining would turn this cleanup
        // into a hang.  The reader thread closes the master itself when the
        // slave goes away (which SIGKILL guarantees).
        //
        // The vterm state is freed only once the reader has stopped writing to
        // it; a session whose PTY is still held open by an escaped grandchild
        // keeps its state instead — the process is exiting anyway.
        {
            std::lock_guard<std::mutex> lk(s->mu);
            if (s->exited && s->vt) {
                vterm_free(s->vt);
                s->vt     = nullptr;
                s->screen = nullptr;
            }
        }

        TerminalManager::instance().remove(s->id);
    }
}

} // namespace boxsh
