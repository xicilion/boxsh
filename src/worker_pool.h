#pragma once

#include "rpc.h"
#include "sandbox.h"

#include <string>
#include <cstddef>
#include <vector>

namespace boxsh {

// Configuration for the worker pool.
struct WorkerPoolConfig {
    size_t num_workers = 4;       // number of pre-forked worker processes
    std::string shell_path;       // path to the shell binary (e.g. /bin/sh)
    SandboxConfig global_sandbox; // global sandbox applied at worker fork time
};

// WorkerPool manages a set of pre-forked worker processes.
// Each worker handles at most one in-flight request at a time.
// The coordinator (rpc_run_loop) uses try_dispatch / busy_entries / collect
// in a poll(2) event loop so that multiple requests execute concurrently and
// responses are written in completion order (not submission order).
class WorkerPool {
public:
    explicit WorkerPool(WorkerPoolConfig cfg);
    ~WorkerPool();

    WorkerPool(const WorkerPool &) = delete;
    WorkerPool &operator=(const WorkerPool &) = delete;

    // Fork all worker processes.  Returns false on error.
    bool init(std::string &error);

    // Non-blocking dispatch: pick a free worker, send the request, mark it
    // busy.  Returns false when every worker is currently occupied.
    bool try_dispatch(const RpcRequest &req);

    // Number of idle (free) workers.
    size_t idle_count() const;

    // Descriptor of an in-flight worker, used to build poll(2) fd sets.
    struct BusyEntry {
        int    fd;  // coordinator-side socketpair fd
        size_t idx; // index into internal worker array
    };
    std::vector<BusyEntry> busy_entries() const;

    // Collect a response from worker[idx].  Call only after poll(2) reports
    // that BusyEntry::fd is readable.  On worker crash the worker is respawned
    // and an error response is returned.
    RpcResponse collect(size_t idx);

    // Terminate all workers and reap their PIDs.
    void shutdown();

    // Expose the sandbox configuration, used by the RPC event loop to apply
    // the same sandbox to tool child processes as to exec workers.
    const SandboxConfig &sandbox_cfg() const { return cfg_.global_sandbox; }

private:
    struct Worker {
        pid_t       pid         = -1;
        int         fd          = -1;   // coordinator-side socketpair fd
        bool        busy        = false;
        nlohmann::json inflight_id;     // request id in flight (for crash reports)
    };

    void spawn_worker(Worker &w);

    WorkerPoolConfig    cfg_;
    std::vector<Worker> workers_;
};

} // namespace boxsh
