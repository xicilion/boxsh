# boxsh 工具结果契约与改造方案（analysis v1）

> 目标：把 boxsh 的 tools 结果提升为 **MCP 2025-06-18 完整合规 + 对模型友好 + 对程序可校验** 的上游契约，
> 供 agent-app（devspace → agent-sdk）链路直接消费；本文件是 boxsh 侧的唯一规范出处。
>
> 关联文档：agent-app `plans/tool-result-contract-and-media-pipeline-plan-2026-09-12.md`（消费方计划）。

---

## 一、背景（实证，均指 2026-09-12 改造前的代码状态）

### 1.1 现状盘点（代码事实）

| 项 | 现状 | 证据 |
|---|---|---|
| 三通道 | 每个工具都返回 `content` + `structuredContent` + `isError`（部分工具带 `outputSchema`/`annotations`） | `src/rpc.cpp:272-290, 597-687, 780-950` |
| `read` 图片 | magic-byte 检测 → stb 解码 + resize → `content:[{text},{image}]` + `structuredContent{encoding:'image',…}` | `src/rpc.cpp:805-850`、`src/image_resize.cpp` |
| `read` 文本 | `content.text` = 正文；`structuredContent.content` = 正文副本 + 元数据 | `src/rpc.cpp:910-923` |
| `bash` | `content.text = sc.dump()`（JSON 副本）；`exit_code != 0` → `isError` | `src/rpc.cpp:272-290` |
| 终端类 | `content.text = sc.dump()`；`list_terminals` 例外（人读文本 + `{sessions}`） | `src/rpc.cpp:597-687` |
| 图片解码 | 仅 stb（无 libwebp）；`file_type.cpp` 能识别 webp/avif/heic/jxl/jp2，但解码失败回落 metadata 文本 | `third_party/stb`、`src/rpc.cpp:816-830` |

### 1.2 需要修正的问题

1. **`read` 的 description 与实现不符**：写着 "Binary files are returned as base64"，实际是图片→image 块、其他二进制→元数据、文本→分页（`src/rpc.cpp:374`）。
2. **`read` 的 `outputSchema` 与实现不符**：`required: ["content","encoding","mime_type"]`，但 image / metadata 分支的 `structuredContent` 没有 `content` 字段——违反 MCP "有 outputSchema 时返回 MUST 符合 schema"。
3. **`structuredContent` 承载正文副本**（read）与 **text 承载 JSON 副本**（bash/终端）：违反"文本=模型表示、结构化=程序数据"的分工，造成 token 重复与转义噪音。
4. **不可解码图片静默回落 metadata**：模型只看到一句 `[Image: … could not be processed]`，没有可操作指引。
5. **测试缺口**：图片路径只覆盖"解码失败→metadata"回退，没有正向图片用例（`tests/tools.test.mjs:193`）。
6. **README 描述过时**：仍称 "binary as base64 with MIME detection"、"Nine tools"。

### 1.3 消费方链路事实（为什么要改）

- agent-app 的 devspace 适配层曾把整个 MCP result `JSON.stringify` 成 text（毁掉 image 块）——该问题在消费方计划中修复；
- agent-app 的 agent-sdk 会：优先使用工具文本、缺失时从 `structuredContent` 紧凑派生；并计划透传 `outputSchema` 做结果校验。
- 结论：boxsh 只需保证"三个通道各自干净且自洽"，其余由消费方处理。

---

## 二、契约规范（规范用语：MUST / SHOULD / MUST NOT）

### 2.1 三通道职责

| 通道 | 职责 | 规则 |
|---|---|---|
| `content` | **模型/人** 可读表示 | `text` 块：MUST 在"文本是自然表示"时提供正文（如 `read`、命令输出）；MUST 在返回 `image` 块时同时提供说明文本；MUST NOT 重复 dump `structuredContent` |
| `image`（content 内块） | 视觉内容 | 只允许出现在 `content`；MUST 经 resize/编码规范化；MUST 同时给 `structuredContent` 元数据 |
| `structuredContent` | **权威结构化数据**（程序/UI/校验） | 声明了 `outputSchema` 的工具 MUST 返回符合 schema 的该字段；MUST NOT 承载 base64；MUST NOT 承载正文副本（`read` 除外：见 §五 的迁移说明） |
| `isError` | 工具执行错误 | 见 §2.2；MUST 同时给可读 `text` |
| `_meta`（可选） | 保留给协议/宿主扩展 | 本版不使用 |

### 2.2 错误模型

工具错误 MUST：`isError: true` + `content.text`（可读）+ `structuredContent = {code, message, detail?}`（机器可判定）。

- `message` = 自描述消息，形如 `<tool>: <说明>`；`content.text` = `"<CODE>: " + message`。
- `detail` 可选，承载机器可读补充信息（如 `{"mime":"image/webp","supported":[...]}`）。
- 判别规则：`isError` 为真时，若 `structuredContent.code` 存在 → 工具错误；否则 → 命令结果（仅 `bash` 非零退出）。
- **参数校验分层（已决策）**：结构级错误（缺少字段、类型不符、取值不合法，如 `timeout:"5"` / `offset:0`）→ JSON-RPC `-32000` protocol error（MCP 语义的 invalid params）；值级错误（能进入处理流程但不满足语义，如非法 base64、`oldText` 匹配失败）→ `E_INVALID_ARGUMENT` 工具错误。两者都不得静默忽略参数。

错误码表（稳定，不得随意新增）：

| code | 含义 |
|---|---|
| `E_INVALID_ARGUMENT` | 参数缺失/类型错误 |
| `E_NOT_FOUND` | 文件/终端不存在 |
| `E_NOT_TEXT` | `read` 的目标不是文本（二进制，或声明为文本但非合法 UTF-8） |
| `E_NOT_IMAGE` | 非图片文件传入 `view_image`（或图片传入 `read`，见 §五） |
| `E_UNSUPPORTED_FORMAT` | 图片可识别但不可解码 |
| `E_TOO_LARGE` | 超出输出/图片限制 |
| `E_TIMEOUT` | 超时 |
| `E_SANDBOX` | 沙箱拒绝/权限问题（EACCES/EPERM） |
| `E_INTERNAL` | 兜底 |

**已决策（2026-09-13）**：不引入 `E_PATH_ESCAPE` —— boxsh 不承担工作区管理职责，file 工具直接 `open/stat`，越界由沙箱在 OS 层拒绝并映射为 `E_SANDBOX`；工作区根校验属于消费方（agent-app）。`read` 的“非文本”语义需要独立表达，因此新增 `E_NOT_TEXT`。

### 2.3 图片规则

- 只经 `view_image` 返回（`read` 不再返回图片，见 §五）；
- resize 目标：最长边 ≤ **2000px**、base64 ≤ **4.5MB**；策略保留现有：已达标→原图；否则 PNG/JPEG 取小者、JPEG 质量 80→60→40→20 递降、仍超则尺寸减半（`src/image_resize.cpp`）；
- `detail:'low'` 时最长边 ≤ **512px**（省 token）；
- MUST 在 `structuredContent` 给 `original_width/original_height/was_resized/size`；动图 MUST 标注 `animated:true`；
- 动图 MUST 只回传首帧：GIF 多帧 / APNG `acTL` 判定为动图后**跳过原字节快路径**，重新编码为首帧 PNG/JPEG（以免把整个动图交给客户端）；
- 不可解码格式 MUST 报 `E_UNSUPPORTED_FORMAT` + 可操作提示（列出支持格式），MUST NOT 静默回落；
- 解码成功但任何编码组合都超限 MUST 报 `E_TOO_LARGE`（与解码失败区分：`ResizeStatus`）。

### 2.4 输出文本预算（bash）

`bash` 输出可能极大，而模型/人只应看到可读片段。规则（**已决策：不做跨调用分页、不缓存 stdout**）：

- `structuredContent.stdout/stderr` 仍是权威数据（沿用 worker 的 10 MiB/流上限，`stdout_truncated`/`stderr_truncated` 标记）；
- `content.text` 上限 **50 KiB**：超出时保留头部 **24 KiB** + 尾部 **24 KiB**，中间插入单行省略标记 `… [truncated: N bytes of M omitted] …`（按行边界切分，UTF-8 安全）；
- 不做 `next_offset` 分页：boxsh 同时支持长驻 MCP server 与一次性 `--rpc` 进程（一个进程一个请求），进程内缓存对后者无效，落盘又要引入可写目录/清理/越界问题；模型需要中间部分时改写命令（`| head`/`| tail`/`| sed -n`/`| grep`）重新获取。

---

## 三、统一结果构造器（唯一出口）

所有工具经同一个 helper 产出结果，杜绝逐工具手拼 JSON：

```cpp
struct ToolResult {
  std::optional<std::string> text;        // 模型表示（可缺省；缺省时消费方紧凑派生）
  std::optional<json>        structured;  // 有 outputSchema 则 MUST 符合
  std::vector<ImagePart>     images;      // 已 resize；非空时 text MUST 非空
  std::optional<ToolError>   error;       // {code, message, detail?}
};
```

规则：
1. `images` 非空 → `text` 必填（形如 `[Image: image/png, 1024x768, resized from 2048x1536]`）；
2. `error` 非空 → `isError:true` + `text` + `structured{code,message}`；
3. 任何工具 MUST NOT 把 `structured` dump 进 `text`；
4. CI 校验：用每个工具的 `outputSchema` 验证其真实返回值（见 §八）。

---

## 四、逐工具规格（目标态）

`structuredContent` 一律**不 dump 到 text**；`content.text` 是模型表示，模板如下（`{}` 表示出现条件）。

| 工具 | `content.text`（模型表示） | `structuredContent` | `annotations` |
|---|---|---|---|
| `bash` | stdout；stderr 非空时先给 `[stdout]` 分节，再给 `[stderr]` 分节；非零退出码追加 `[exit code: N]`；超预算按 §2.4 头尾裁剪；全空且退出码 0 → `(no output)` | `{exit_code, stdout, stderr, duration_ms, stdout_truncated?, stderr_truncated?, timed_out?}` | `destructiveHint:true` |
| `read` | 纯文本正文；截断时追加 `[truncated: showing lines A-B of T; continue with offset=N]`；单行超过 50 KiB 时先截断该行并给出 bash 提示 | `{encoding:'text', mime_type, line_count, truncated, total_lines?, next_offset?}` | `readOnlyHint:true` |
| `view_image`（新） | `"[Image: mime, WxH{, resized from W0xH0}{, low detail}{, animated, first frame}]"` | `{encoding:'image', mime_type, width, height, original_width, original_height, was_resized, size, animated}` | `readOnlyHint:true` |
| `write` | `write: PATH (created|overwrote existing, N bytes)` | `{path, bytes, created}` | `destructiveHint:true` |
| `edit` | `edit: PATH (+A -R, first change at line L)` | `{path, lines_added, lines_removed, first_changed_line}`（**已决策：`diff` 不进 structuredContent**） | `destructiveHint:true` |
| `run_in_terminal` | `terminal ID (COMMAND), running`（已退出则 `terminal ID (COMMAND), exited, code N`）+ 空行 + 首屏 output | `{id, output, exited, exit_code}` | `destructiveHint:true` |
| `send_to_terminal` | output（无新输出时 `(no new output)`） | `{id, output, exited, exit_code}` | `destructiveHint:true` |
| `get_terminal_output` | 同上 | `{id, output, exited, exit_code}` | `readOnlyHint:true` |
| `kill_terminal` | `terminal ID killed` + 空行 + 最终 output | `{id, killed:true, output}` | `destructiveHint:true` |
| `list_terminals` | 每行一条 `ID  running|exited  COMMAND`；无会话 → `(no terminal sessions)` | `{sessions:[{id, command, alive, exited, exit_code, cols, rows}]}` | `readOnlyHint:true` |

约定：

- `exit_code` 在终端类结果中**始终存在**：进程已退出为整数，未退出为 `null`；`list_terminals.sessions[]` 同规则。
- `bash` 的 `structuredContent` 表示“命令结果”，非零退出码同样置 `isError:true`，但因无 `code` 字段而与工具错误可区分（§2.2）。
- 每个工具 MUST 在 `tools/list` 提供 `outputSchema`；`inputSchema` 关键参数补齐 `description`。
- 图片只允许出现在 `view_image` 的结果里（§2.3）。

---

## 五、`read` / `view_image` 拆分（破坏性变更，需版本说明）

**动机**：两个工具语义、schema、预算策略完全不同；合一会导致描述与 schema 无法同时准确。

- `read`：
  - 只服务文本。检测为二进制时：`image/*` → `E_NOT_IMAGE`（提示 `use view_image`）；其他二进制 → `E_NOT_TEXT`（提示用 `bash` 的 `file`/`xxd`/`strings`）；
  - 声明为文本但非合法 UTF-8 → `E_NOT_TEXT`（错误信息注明编码问题）；
  - `structuredContent` **移除正文副本**（`content` 字段删除），只留分页元数据（迁移见 §七）；
  - 普通文本文件的 `content.text` 就是正文；`mime_type` 仍来自 magic-byte 检测（如 `text/x-shellscript`），不再回落 `encoding:'metadata'`。
- `view_image`（新）：
  - 入参 `{path: string, detail?: 'auto'|'low'}`（`detail` 默认 `'auto'`）；
  - 非图片文件 → `E_NOT_IMAGE`；文件不存在 → `E_NOT_FOUND`；
  - 输出见 §四；格式支持：png/jpeg/gif（首帧）/bmp/tiff + **webp**（vendor libwebp 1.6.0 解码子集，见 `third_party/libwebp/README.md`；动图取首帧）；其余（avif/heic/jxl/jp2/psd…）→ `E_UNSUPPORTED_FORMAT` + `detail.supported` 列表；
  - 解码成功但超限（> 4.5MB 或尺寸策略无法满足）→ `E_TOO_LARGE` + 建议 `detail:'low'`。

**兼容策略**：`read` 收到图片时返回 `E_NOT_IMAGE` 文本（老客户端可读），只是不再附带 image 块。

**已决策**：不做多图 `paths: string[]`（v1 只接受单个 `path`）。

---

## 六、描述符与协议

1. `initialize` 的版本协商规则（**已决策**）：
   - 客户端未带 `protocolVersion` → 回 `"2025-06-18"`（本版基线）；
   - 客户端带旧版本（`2024-10-07` / `2024-11-05` / `2025-03-26`）→ 原样回显（老客户端不断）；
   - 其余（含 `2025-06-18` 及更新的未知版本）→ 回 `"2025-06-18"`。
   `structuredContent`/`outputSchema`/`isError` 均为附加字段，向旧版本客户端回显时依然返回。
2. `capabilities`：`{tools: {listChanged: false}}` —— 工具集是静态的（编译期确定）；变更工具描述需要重启进程，因此**不发** `notifications/tools/list_changed`，并在 README 明确要求重启。
3. 每个工具描述符 MUST 含：`name/title/description/inputSchema/outputSchema`；SHOULD 含 `annotations`。
4. `description` 是模型选工具的唯一依据 → MUST 与实现一致（纳入 CI 文案检查：不得出现 "base64"、"binary returned as base64" 等过时表述）。
5. 工具数量：`bash`、`read`、`view_image`、`write`、`edit`、`run_in_terminal`、`send_to_terminal`、`get_terminal_output`、`kill_terminal`、`list_terminals`（10 个）。

---

## 七、兼容性与破坏性变更清单

| 变更 | 影响 | 处置 |
|---|---|---|
| `read` 不再返回 image 块 | 依赖该行为的客户端会拿不到图 | 升 minor 版本（5.0.0 → 5.1.0）+ README 说明；消费方版本地板 |
| `read.structuredContent.content` 移除 | 程序化读正文的调用方 | 改为读 `content.text`；文档标注 deprecated→removed |
| `read` 对二进制/图片改报错（原 `encoding:'metadata'`） | 依赖 metadata 回落的调用方 | README 说明；改用 `view_image` 或 `bash` |
| `bash`/终端 `content.text` 从 JSON 副本改为可读文本 | 解析 text 的调用方 | 明确规范：程序请用 `structuredContent` |
| `bash` text 超 50 KiB 头尾裁剪 | 依赖 text 拿全量输出的调用方 | 用 `structuredContent.stdout/stderr` |
| 图片不可解码从"静默 metadata"改为报错 | 行为可见性提升 | README 说明 |
| 新增 `view_image` 工具 | 工具列表变化 | 客户端需重新 `tools/list`（重启） |

---

## 八、测试要求

1. **正向图片用例**（新增，`tests/view-image.test.mjs`）：
   - 小图（`tests/fixture/fixture.png`）→ 断言 `content[1].type === 'image'`、`mimeType`、`structuredContent.encoding === 'image'`、`was_resized === false`；
   - 大图（程序生成 >2000px）→ 断言 `was_resized === true`、边长 ≤ 2000、base64 ≤ 4.5MB；
   - `detail:'low'` → 断言边长 ≤ 512。
2. **错误码用例**：`E_NOT_IMAGE`（read 图片 / view_image 非图片）、`E_NOT_TEXT`（read 二进制）、`E_UNSUPPORTED_FORMAT`（view_image 不可解码格式）、`E_INVALID_ARGUMENT`（目录、非法 base64、oldText 不匹配）、`E_NOT_FOUND`。
   `E_TOO_LARGE` 保留为安全网：现行“尺寸减半 + JPEG 质量递减”策略下解码成功的图片几乎不可能超限，只能靠人工构造验证，暂不写成用例。
3. **schema 一致性自测**（`tests/tool-contract.test.mjs`）：遍历 `tools/list` 的每个工具，用 fixture 调用并以它的 `outputSchema` 校验真实返回；成功与错误路径都覆盖。
   **已决策**：不引入外部 devDependency（仓库无根 `package.json`，CI 只跑 `node --test`）——在 `tests/helpers.mjs` 实现一个文档化的 JSON Schema 子集校验器（`type`/`properties`/`required`/`items`/`enum`/`anyOf`），schema 只用这个子集。
4. **老客户端可读性**：断言 `content` 单独可读（不依赖 `structuredContent`）——每个工具至少一条用例只看 `content`。
5. **描述一致性**：CI 禁止 description 出现已废弃表述（简单正则白名单即可），并断言 10 个工具都带 `outputSchema`。
6. **text ≠ JSON dump**：断言 `bash`/终端工具的 `content.text` 不是以 `{` 开头的 JSON。

---

## 九、实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| B1 | 统一结果构造器；`read`/`view_image` 拆分；description/outputSchema 修正；错误码（含 `E_NOT_TEXT`） | 全部工具 schema 校验通过；正向图片用例绿 |
| B2 | 图片加固：`animated` 标记、超限策略（`E_TOO_LARGE`）；**libwebp（已决策：vendor 源码）** | `animated`/超限用例绿；webp 正向用例（静态/大图/动图）绿 |
| B3 | `bash`/终端 text 可读化（不再 dump JSON）；annotations 补全 | 快照/单测更新；老客户端可读性用例绿 |
| B4 | 协议版本协商 + `capabilities` + README/usage/SDK 文案同步 | 握手断言；文档更新 |

**已交付（2026-09-13）**：B1、B3、B4，B2 全部（`animated` 标记、`detail:'low'`、解码失败与超限分离的 `ResizeStatus`、libwebp 1.6.0 解码子集 vendor 进 `third_party/libwebp`）。
额外修复：`LineReader` 的换行扫描由 O(n²) 改为增量扫描（64 MiB 单行输入从 10-15 s 降到 < 1 s，`protocol-regression.test.mjs` 的 64 MiB 用例由超时变为稳定通过）。

---

## 十、开放问题（已全部定案 2026-09-13）

1. ~~WebP 之外是否补 AVIF/HEIC~~ → **不补**（收益低、体积大）；`E_UNSUPPORTED_FORMAT` 已给出 `detail.supported`。
1b. ~~WebP 解码怎么落地~~ → **vendor libwebp 1.6.0 解码子集**（`third_party/libwebp`，64 文件 / 880 KB，portable C，无 SIMD/线程；静态 webp 达标时走原字节快路径，动图重编码为首帧；`HAVE_CONFIG_H` 仅在 `libwebp_decoder` 目标内定义）。
2. ~~`edit` 的 `diff` 是否进 `structuredContent`~~ → **不进**；只用 `lines_added/lines_removed/first_changed_line` 摘要。
3. ~~图片多张一次返回~~ → **不做**（v1 只收单 `path`）。
4. ~~`bash` 输出分页~~ → **不做跨调用分页、不缓存 stdout**；text 头尾裁剪（§2.4），需要中间部分时改写命令。
5. ~~二进制非图片（PDF/docx）标准错误文案~~ → **不做专用文案**；统一归入 `E_NOT_TEXT`（通用提示：二进制文件、mime、大小）。
