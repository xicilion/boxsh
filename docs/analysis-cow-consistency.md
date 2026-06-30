# boxsh COW 一致性分析报告（修订 v2）

> **核心纠正：** host 修改的是 cow 的 **dst 目录**（可写层），不是 src（只读基础层）。
> 本质是：**同一目录树、多进程并发访问时，长生命周期 worker 进程的 VFS 缓存滞后。**

---

## 一、问题本质

```
host 进程                          boxsh worker 进程（长生命周期）
  │                                       │
  │ write("/tmp/work/config.json")        │
  │                                       │ open("/tmp/work/config.json")
  ▼                                       ▼
  ┌─────────────────────────────────────────┐
  │         同一 APFS 目录 /tmp/work/        │
  │         UBC (Unified Buffer Cache)      │
  │         VFS name cache / dcache         │
  └─────────────────────────────────────────┘
                    ▲
          host 写入后 UBC 更新，
          但 worker 的 name cache / dentry cache 可能仍是旧快照
```

worker 是 `worker_loop()` 中的**长生命周期进程**，由 coordinator fork 出来后一直运行（循环处理请求），从不退出。它的 VFS 缓存随时间累积。host 写入 dst 后：

- **文件内容**（page cache）：UBC 是全局一致的 → `open()+read()` 通常能读到最新内容
- **目录列表**（name cache / dcache）：**没有跨进程一致性保证** → 新增/删除文件可能不可见
- **元数据**（stat cache）：属性缓存可能滞后（通常 <1s，但高负载时延长）

### 当前架构（RPC 模式）

```
main.cpp:440  sandbox_apply(cfg)     ← coordinator 进入 sandbox
main.cpp:455  pool.init()            ← fork N 个 worker
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
  worker[0]    worker[1]    worker[2]    ← 每个都是长生命周期进程
  worker_loop  worker_loop  worker_loop    （直到 shutdown 才退出）
```

macOS: `sandbox_apply()` → `clonefile(src,dst)` + `sandbox_init(SBPL)` + `chdir(dst)`  
Linux: `sandbox_apply()` → `unshare(ns)` + `fork()` → overlay mount + `pivot_root`  
Worker fork 自 coordinator，继承 sandbox 环境和 CWD。

---

## 二、哪些情形导致不一致

### 场景 A：目录列表不一致 ★ 最常见的痛点

| 操作 | 表现 |
|------|------|
| host 在 dst 中 `touch newfile.txt` | boxsh 内 `ls` 看不到 |
| host 在 dst 中 `rm oldfile.txt` | boxsh 内 `ls` 仍显示 |
| host 在 dst 中 `mkdir subdir` | boxsh 内 `ls` 看不到新目录 |

**根因：** worker 进程的 VFS name cache（macOS）/ dcache（Linux）缓存了旧目录项。后续 `getdirentries`/`readdir` 返回缓存快照。

**生命周期：** 缓存通常在内存压力下被挤出，或超时后自然失效（秒级）。但如果 worker 持续高频访问该目录，缓存会被持续"保鲜"——可能几小时都不过期。

### 场景 B：文件内容不一致（较少见）

| 操作 | 表现 |
|------|------|
| host 修改 dst/config.json | boxsh 先 `open()` 再 `close()`，再 `open()` → 可能读到旧版本 |
| host 追加文本 | boxsh `cat` 读到旧版本 |

**根因：** UBC page cache 通常全局一致，但 **每次请求 fork 的 grandchild 进程**能拿到最新内容（新进程无缓存）。不一致主要发生在 worker 进程自身直接持有文件 fd 的情形。在 MCP 模式中，实际的文件操作由每次 fork 的 grandchild（dash 子进程）执行，它每次都是新进程，文件内容通常一致。

**实际触发概率：** 极低（因为每个请求 fork 新 grandchild）。

### 场景 C：文件元数据不一致

| 操作 | 表现 |
|------|------|
| host 修改文件内容 | boxsh `stat` 看到旧的 mtime/size |
| host `chmod` | boxsh `stat` 看到旧权限 |

**根因：** vnode 属性缓存。macOS APFS 的属性缓存超时较短，但非零。

---

## 三、OS 清除 fs 缓存的可能

### 3.1 macOS

| 机制 | 目录缓存 | 文件内容缓存 | 权限需求 | 结论 |
|------|---------|------------|---------|------|
| `F_NOCACHE` per-fd | ❌ 不适用 | ✅ 有效 | 无 | 只能用于文件 fd，不能用于目录 |
| `purge` 命令 | ✅ | ✅ | **root** | ❌ boxsh worker 没有 root |
| `open()/close()` 目录 | ⚠️ 不确定 | - | 无 | 依赖内核实现，不可靠 |
| `rename()` 目录 hack | ⚠️ 未验证 | - | 无 | 对目录 rename 可能使 name cache 失效，但有风险 |

**结论：macOS 上没有不需要 root 的通用缓存失效 API。** 尤其是目录缓存，没有公开的用户态清除手段。

#### 深水区探索

1. **`rename()` hack：**
   ```c
   // 理论：rename 目录会触发内核使该目录的 name cache 失效
   rename("/tmp/work", "/tmp/work.tmp");
   rename("/tmp/work.tmp", "/tmp/work");
   ```
   - 如果 worker 的 CWD 在该目录下 → `EBUSY`
   - rename 窗口期目录不可访问
   - 未验证是否真的能使 name cache 失效

2. **`getattrlistbulk()` 的私有选项：** macOS 的 `ls` 使用 `getattrlistbulk(2)`。该函数有未公开的 flag 控制是否使用/更新 name cache。不可依赖。

3. **APFS snapshot：** 可以创建 APFS 快照然后 revert，但需要 root。不可行。

### 3.2 Linux

| 机制 | 目录缓存 | 文件内容缓存 | 权限需求 | 结论 |
|------|---------|------------|---------|------|
| `/proc/sys/vm/drop_caches` | ✅ | ✅ | **root** (`CAP_SYS_ADMIN`) | ❌ boxsh 在 user ns 中无此权限 |
| `posix_fadvise(DONTNEED)` | ❌ | ✅ | 无 | 只管 page cache，不管 dcache |
| `mount -o remount /path` | ✅ | ✅ | **root** | ❌ 需要 `CAP_SYS_ADMIN` |
| 重新 mount overlay | ✅ | ✅ | **root** | ❌ 同上 |

**结论：Linux 上同样没有不需要 root 的 dcache 清除手段。** `posix_fadvise` 是最接近的，但它不能清除目录缓存。

### 3.3 跨平台结论

> **两个平台都不提供「普通用户可调用的目录缓存失效 API」。这是 POSIX 设计层面的空白——VFS 缓存被假定为"总是正确的"，实际上在并发写入场景下可能出现滞后。**

---

## 四、进程内热重启机制

这是**唯一跨平台、不需要 root、完全可靠**的方案。

### 4.1 为什么有效

worker 进程持有自己的 VFS 缓存视图。新 fork 的进程 → 空白 VFS 缓存 → 任何路径查找都走磁盘 → host 的修改立即可见。

**关键架构优势（当前设计天然支持）：**

```
coordinator (sandbox 内)
  │ sandbox_apply() 只调用一次
  │ namespace / Seatbelt / CWD 已就位
  │
  ├── spawn_worker() → fork() → worker_loop()
  ├── spawn_worker() → fork() → worker_loop()
  └── spawn_worker() → fork() → worker_loop()
       ▲
       └── 只需重新 fork，sandbox 环境自动继承
           无需再次调用 sandbox_apply()
```

- **macOS**: 新 worker 继承 coordinator 的 Seatbelt sandbox + CWD（在 dst 中）。无需重新 `clonefile`。
- **Linux**: 新 worker 继承 coordinator 的 namespace（含 overlay mount）。无需重新 mount。

### 4.2 实现设计

#### 新增 RPC 工具

```
方法:   restart_workers
参数:   无
返回:   {"restarted": N, "draining": M, "total": T}

语义:
  - 空闲 worker: 立即 SIGTERM → waitpid → fork 新 worker
  - 忙碌 worker: 标记 drain=true → 完成当前请求后退出 → fork 新 worker
  - 协调者不重启，RPC 连接不断
```

#### WorkerPool 变更

```cpp
// worker_pool.h

struct Worker {
    pid_t pid = -1;
    int   fd  = -1;
    bool  busy = false;
    bool  drain = false;   // NEW: 完成请求后不回到空闲池，退出并重建
    nlohmann::json inflight_id;
};

class WorkerPool {
public:
    struct RestartResult {
        size_t restarted;  // 已立即重启
        size_t draining;   // 等待当前请求完成后重启
        size_t total;
    };
    RestartResult restart_workers();
    
    // collect() 增加 drain 处理
};
```

#### 核心逻辑

```cpp
WorkerPool::RestartResult WorkerPool::restart_workers() {
    RestartResult r{0, 0, workers_.size()};
    
    for (auto &w : workers_) {
        if (w.busy) {
            w.drain = true;
            r.draining++;
        } else {
            kill(w.pid, SIGTERM);
            waitpid(w.pid, nullptr, 0);
            close(w.fd);
            w.fd = -1;
            w.pid = -1;
            spawn_worker(w);
            r.restarted++;
        }
    }
    return r;
}

// collect() 末尾:
RpcResponse WorkerPool::collect(size_t idx) {
    Worker &w = workers_[idx];
    // ... 读取响应 ...
    
    if (w.drain) {
        kill(w.pid, SIGTERM);
        waitpid(w.pid, nullptr, 0);
        close(w.fd);
        w.fd = -1;
        w.pid = -1;
        w.drain = false;
        w.busy = false;
        spawn_worker(w);   // 重建，新进程 → 新 VFS 缓存
    } else {
        w.busy = false;
    }
    return response;
}
```

#### RPC 事件循环集成

```cpp
// rpc.cpp rpc_run_loop 中
if (req.cmd == "restart_workers") {
    auto result = pool.restart_workers();
    resp.tool = ToolKind::None;
    resp.exit_code = 0;
    resp.stdout_data = json{{"restarted", result.restarted},
                            {"draining", result.draining},
                            {"total", result.total}}.dump();
    write_response(resp);
    continue;
}
```

#### 外部信号触发（可选）

```cpp
// main.cpp
static std::atomic<bool> g_restart_flag{false};
static void on_sigusr1(int) { g_restart_flag.store(true); }

// 在 rpc_run_loop 的主 poll 前检查:
if (g_restart_flag.exchange(false)) {
    pool.restart_workers();
}
```

Host 使用: `kill -USR1 $(pgrep boxsh)`

### 4.3 调用方视角

```
业务层流程：
  1. host 修改 dst/some/config.json
  2. 发送 restart_workers RPC
  3. 空闲 worker(n) 立即重建 → 新 worker 看到 config.json 更新
  4. 忙 worker(k) 完成当前请求 → 退出 → 重建
  5. RPC 连接、终端 session 均不受影响
```

### 4.4 边界情况分析

| 场景 | 行为 |
|------|------|
| 所有 worker 都空闲 | 全部立即重启，总耗时 = N × (kill+waitpid+fork) ≈ 几 ms |
| 所有 worker 都忙 | 全部标记 drain，最坏情况等待 timeout 秒 |
| 部分忙部分闲 | 空闲立即重启，忙的等待完成 |
| worker 在执行长时间命令 | drain 标记后 worker 继续执行，不中断 |
| coordinator 收到 SIGTERM | 正常 shutdown（现有逻辑不变） |
| 连续两次 restart | 第一次的 drain 未完成时，第二次会再次标记 drain（幂等） |

### 4.5 无需担心的事项

1. **sandbox 重建**: 不需要——新 worker 直接 fork 自 coordinator，继承已有 sandbox
2. **clonefile 重执行**: 不需要——dst 目录已存在且非空，`sandbox_apply` 中的 clone 逻辑会跳过（见 `sandbox_darwin.cpp:510` 的 `should_clone = false` 分支）
3. **overlay 重挂载**: 不需要——新 worker 继承 coordinator 的 mount namespace，已有 overlay 仍然有效
4. **终端 session**: 终端 session 在 coordinator 进程中管理（不随 worker 重启而丢失）
5. **RPC 连接**: 在 coordinator 进程中，不受影响

---

## 五、总结

| 维度 | 结论 |
|------|------|
| **能否清除 OS 缓存** | ❌ macOS 无 API；Linux 需要 root（boxsh 没有） |
| **是否有 hack 绕过** | ⚠️ `F_NOCACHE` 只管文件内容，不管目录。`rename()` hack 不可靠。 |
| **热重启可行性** | ✅ 当前架构天然支持。fork 新 worker 即获得新 VFS 缓存。 |
| **对业务影响** | 零中断。空闲 worker 立即重建，忙 worker 等待完成后重建。 |
| **实现复杂度** | 低。核心逻辑 < 50 行，主要是 WorkerPool 加 drain 标记 + restart_workers 方法。 |

**推荐方案：实现进程内热重启机制。**

---

## 附录：相关代码索引

| 文件:行号 | 内容 |
|-----------|------|
| `src/main.cpp:440` | `sandbox_apply` — coordinator 进入 sandbox |
| `src/main.cpp:455` | `pool.init()` — fork 所有 worker |
| `src/worker_pool.h:22-61` | WorkerPool 类定义 |
| `src/worker_pool.cpp:362-380` | `spawn_worker()` — fork + worker_loop |
| `src/worker_pool.cpp:300-340` | `worker_loop()` — 长生命周期循环 |
| `src/sandbox_darwin.cpp:488` | `clonefile()` — macOS COW 快照 |
| `src/sandbox_darwin.cpp:510` | 如果 dst 非空则跳过 clone（`should_clone = false`） |
| `src/sandbox.cpp:517` | Linux overlay mount |
| `src/sandbox.cpp:727` | `unshare()` — Linux namespace 隔离 |
