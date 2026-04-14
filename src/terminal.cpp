#include "terminal.h"

#include <stdexcept>
#include <string>
#include <unordered_map>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

// POSIX PTY
#include <stdlib.h>   // posix_openpt, grantpt, unlockpt, ptsname
#include <termios.h>
#include <sys/ioctl.h>

#include "vterm.h"

// ---------------------------------------------------------------------------
// UUID v4 generation (RFC 4122, random-based)
// ---------------------------------------------------------------------------

#include <random>

static std::string generate_uuid() {
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

namespace {

struct TerminalSession {
    std::string  id;
    std::string  command;
    pid_t        child_pid  = -1;
    int          fd_master  = -1;
    int          cols       = 220;
    int          rows       = 50;

    VTerm       *vt         = nullptr;
    VTermScreen *screen     = nullptr;

    std::mutex               mu;
    std::condition_variable  cv;
    uint64_t                 generation = 0;   // incremented on every PTY read

    std::thread  reader_thread;
    bool         exited    = false;
    int          exit_code = -1;
};

// ---------------------------------------------------------------------------
// TerminalManager singleton
// ---------------------------------------------------------------------------

struct TerminalManager {
    std::mutex                                                    map_mu;
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

static std::string screen_snapshot(VTermScreen *screen, int rows, int cols) {
    std::string result;
    result.reserve(rows * (cols + 1));

    // Find last non-empty row.
    int last_row = 0;
    for (int r = rows - 1; r >= 0; --r) {
        VTermRect rect = {r, r + 1, 0, cols};
        char buf[4096];
        size_t n = vterm_screen_get_text(screen, buf, sizeof(buf), rect);
        // Trim trailing whitespace/nulls from this row.
        while (n > 0 && (buf[n-1] == ' ' || buf[n-1] == '\0')) --n;
        if (n > 0) { last_row = r; break; }
    }

    for (int r = 0; r <= last_row; ++r) {
        VTermRect rect = {r, r + 1, 0, cols};
        char buf[4096];
        size_t n = vterm_screen_get_text(screen, buf, sizeof(buf), rect);
        // Trim trailing spaces.
        while (n > 0 && buf[n-1] == ' ') --n;
        result.append(buf, n);
        result += '\n';
    }

    return result;
}

// ---------------------------------------------------------------------------
// Reader thread: drains PTY master fd → vterm
// ---------------------------------------------------------------------------

static void reader_thread_fn(std::shared_ptr<TerminalSession> s) {
    char buf[4096];
    while (true) {
        ssize_t n = read(s->fd_master, buf, sizeof(buf));
        if (n <= 0) {
            // PTY master closed (child exited or error).
            // Reclaim system resources immediately regardless of how the
            // process ended (natural exit or SIGHUP from terminal_kill).
            int status = 0;
            waitpid(s->child_pid, &status, 0);
            {
                std::lock_guard<std::mutex> lk(s->mu);
                // Guard: terminal_kill may have already closed fd_master.
                if (s->fd_master >= 0) {
                    close(s->fd_master);
                    s->fd_master = -1;
                }
                s->exited    = true;
                s->exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
                s->generation++;
            }
            s->cv.notify_all();
            break;
        }
        {
            std::lock_guard<std::mutex> lk(s->mu);
            vterm_input_write(s->vt, buf, (size_t)n);
            vterm_screen_flush_damage(s->screen);
            s->generation++;
        }
        s->cv.notify_all();
    }
}

// ---------------------------------------------------------------------------
// Wait for new output (long-poll helper)
// ---------------------------------------------------------------------------

static std::string wait_for_output(std::shared_ptr<TerminalSession> s,
                                   int timeout_ms) {
    std::unique_lock<std::mutex> lk(s->mu);
    uint64_t last_gen = s->generation;
    s->cv.wait_for(lk, std::chrono::milliseconds(timeout_ms),
                   [&]{ return s->generation != last_gen || s->exited; });
    return screen_snapshot(s->screen, s->rows, s->cols);
}

} // anonymous namespace

// ---------------------------------------------------------------------------
// Public API implementation
// ---------------------------------------------------------------------------

namespace boxsh {

TerminalCreateResult terminal_create(const std::string &command,
                                     int cols, int rows,
                                     int initial_wait_ms) {
    // Open PTY master.
    int fdm = posix_openpt(O_RDWR | O_NOCTTY);
    if (fdm < 0) throw std::runtime_error("posix_openpt failed");
    if (grantpt(fdm) < 0 || unlockpt(fdm) < 0) {
        close(fdm);
        throw std::runtime_error("grantpt/unlockpt failed");
    }

    // Set PTY size.
    struct winsize ws{};
    ws.ws_col = (unsigned short)cols;
    ws.ws_row = (unsigned short)rows;
    ioctl(fdm, TIOCSWINSZ, &ws);

    // Fork child.
    pid_t pid = fork();
    if (pid < 0) {
        close(fdm);
        throw std::runtime_error("fork failed");
    }

    if (pid == 0) {
        // Child: open PTY slave as controlling terminal.
        setsid();
        const char *slave_name = ptsname(fdm);
        int fds = open(slave_name, O_RDWR);
        if (fds < 0) _exit(1);
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
    s->cols      = cols;
    s->rows      = rows;

    s->vt = vterm_new(rows, cols);
    vterm_set_utf8(s->vt, 1);
    s->screen = vterm_obtain_screen(s->vt);
    vterm_screen_enable_altscreen(s->screen, 1);
    vterm_screen_reset(s->screen, 1);

    TerminalManager::instance().add(s);

    // Start reader thread (captures shared_ptr for lifetime).
    s->reader_thread = std::thread(reader_thread_fn, s);
    s->reader_thread.detach();

    // Wait briefly for initial output, then return full status.
    auto out = terminal_output(s->id, initial_wait_ms);
    return {s->id, out.output, out.exited, out.exit_code};
}

void terminal_send(const std::string &id, const std::string &text) {
    auto s = TerminalManager::instance().get(id);
    if (!s) throw std::runtime_error("unknown terminal session: " + id);
    {
        std::lock_guard<std::mutex> lk(s->mu);
        if (s->exited) throw std::runtime_error("terminal session has exited: " + id);
    }
    const char *p = text.data();
    size_t remaining = text.size();
    while (remaining > 0) {
        ssize_t n = write(s->fd_master, p, remaining);
        if (n <= 0) throw std::runtime_error("write to PTY failed");
        p += n;
        remaining -= (size_t)n;
    }
}

TerminalOutputResult terminal_output(const std::string &id, int wait_ms) {
    auto s = TerminalManager::instance().get(id);
    if (!s) throw std::runtime_error("unknown terminal session: " + id);
    std::string snap = wait_for_output(s, wait_ms);
    std::lock_guard<std::mutex> lk(s->mu);
    return {snap, s->exited, s->exit_code};
}

std::string terminal_kill(const std::string &id) {
    auto s = TerminalManager::instance().get(id);
    if (!s) throw std::runtime_error("unknown terminal session: " + id);

    // Signal the child, then close fd_master to force EOF in the reader
    // thread (guards against the child ignoring SIGHUP).  The reader thread
    // may have already closed fd_master if the child exited naturally first.
    kill(s->child_pid, SIGHUP);
    {
        std::lock_guard<std::mutex> lk(s->mu);
        if (s->fd_master >= 0) {
            close(s->fd_master);
            s->fd_master = -1;
        }
    }

    // Wait for reader thread to mark exited.
    {
        std::unique_lock<std::mutex> lk(s->mu);
        s->cv.wait_for(lk, std::chrono::seconds(3),
                       [&]{ return s->exited; });
    }

    std::string snap;
    {
        std::lock_guard<std::mutex> lk(s->mu);
        snap = screen_snapshot(s->screen, s->rows, s->cols);
        vterm_free(s->vt);
        s->vt     = nullptr;
        s->screen = nullptr;
    }

    TerminalManager::instance().remove(id);
    return snap;
}

std::vector<TerminalInfo> terminal_list() {
    auto sessions = TerminalManager::instance().all();
    std::vector<TerminalInfo> result;
    result.reserve(sessions.size());
    for (auto &s : sessions) {
        std::lock_guard<std::mutex> lk(s->mu);
        result.push_back({s->id, s->command, !s->exited, s->cols, s->rows});
    }
    return result;
}

} // namespace boxsh
