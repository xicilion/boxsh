# boxsh 工具结果契约复核 · tool-contract-01

- **复核对象**：`/Users/lion/works/boxsh`（工作区未提交改动：`src/rpc.cpp/.h`、`src/image_resize.*`、`src/terminal.*`、`src/worker_pool.cpp` + 测试/文档/SDK；`BOXSH_VERSION=5.1.0`）。
- **依据**：`docs/analysis-tool-result-contract.md`（analysis v1，2026-09-13）。
- **方法**：逐行读实现 + 读测试 + 手工探针（`./build/boxsh --rpc` 真实调用）三向对照；不修改任何源码/测试。
- **环境**：macOS，`cmake --build build -j` 成功；`node --test tests/index.test.mjs` → **651 pass / 0 fail / 30 skip**；`BOXSH=build/boxsh node --test sdk/js/test/all.test.mjs` → **46 pass / 0 fail**；`node --test tests/tool-contract.test.mjs tests/view-image.test.mjs` → **51 pass / 0 fail**。

## 结论

**pass**（无 P1、无阻塞项；4 项 P2 建议在小版本内修正，其余为 P3 文案/边界问题）。

## 阻塞项（blocking）

无。

## 发现清单

| # | 严重度 | 阻塞 | 主题 | 文档位置 | 代码位置 |
|---|---|---|---|---|---|
| F-01 | P2 | non-blocking | 动图未裁剪首帧，`animated, first frame` 与实现不符 | §2.3、§四、§八.1 | `src/rpc.cpp:1350,1359,704`、`src/image_resize.cpp:83-99` |
| F-02 | P2 | non-blocking | `view_image` 描述宣称支持 webp（构建永远无解码器） | §5、§六.4 | `src/rpc.cpp:680` vs `src/rpc.cpp:1175-1180,1345-1349` |
| F-03 | P2 | non-blocking | `edit.annotations.destructiveHint=false`（契约为 true） | §四（edit 行） | `src/rpc.cpp:786-790` |
| F-04 | P2 | non-blocking | `read` 的 50 KiB 上限对首行超长文件不生效 | §四（read 行）、README.md:184、docs/usage.md:910 | `src/rpc.cpp:1243,1220,643` |
| F-05 | P3 | non-blocking | bash 头尾裁剪在"无换行"输出下尾部为空 | §2.4 | `src/rpc.cpp:125-135` |
| F-06 | P3 | non-blocking | 参数校验缺口：缺参走 JSON-RPC 错误、类型错的选参被静默忽略 | §2.2（E_INVALID_ARGUMENT）、§八.2 | `src/rpc.cpp:306,316,330,363,1996-2002,340-347,376-378` |
| F-07 | P3 | non-blocking | `read` 的 UTF-8 校验只覆盖本次返回页 | §5 | `src/rpc.cpp:1265` |
| F-08 | P3 | non-blocking | `read.mime_type` 示例不符；空文件返回 `inode/x-empty` | §5 | `src/rpc.cpp:660`、`src/file_type.cpp:470-481` |
| F-09 | P3 | non-blocking | 终端文本模板/错误前缀偏差；"已退出"报 E_NOT_FOUND | §四、§2.2 | `src/rpc.cpp:956-971,1063` |
| F-10 | P3 | non-blocking | `E_TOO_LARGE` 实际不可达且无用例；`E_TIMEOUT` 无生产者 | §2.3、§2.2、§八.2 | `src/image_resize.cpp:120-141`、`src/rpc.h:37` |
| F-11 | P3 | non-blocking | 文档/SDK 注释残留旧行为（edit diff、read 图片、旧协议注释） | §七 | `docs/usage.md:1231`、`README.md:553`、`tests/file-type.test.mjs:328`、`sdk/js/src/client.mjs:10-16` |
| F-12 | P3 | non-blocking | 未按 §6.2 在 README 说明"工具集静态、需重启"+ listChanged=false | §六.2 | `README.md:151-152`、`docs/usage.md:872` |
| F-13 | P3 | non-blocking（信息性） | bash `structuredContent.stdout/stderr` 对非法 UTF-8 有损替换且无标记 | §2.4 | `src/rpc.cpp:458-476`、`src/io_utils.cpp:60-133` |

---

### F-01（P2，non-blocking）动图未裁剪首帧

- **文档**：§2.3「动图 MUST 标注 `animated:true`（只回传首帧，GIF 多帧 / APNG `acTL` 均判定为动图）」；§四 view_image 文本模板含 `{, animated, first frame}`。
- **代码**：`src/rpc.cpp:1350`（`image_is_animated`）、`src/rpc.cpp:1359`（文本追加 `", animated, first frame"`）、`src/rpc.cpp:704`（outputSchema 描述 "Animated source — only the first frame is returned"）；`src/image_resize.cpp:83-99` 的"已达标 → 原图直出"快路径不抽帧。
- **证据**：`tests/fixture/fixture.apng` 的 `acTL num_frames = 20`；`view_image` 返回的 image 块 base64 解码后与原文件**逐字节相同**（63435 B，`identical=true`），即客户端拿到的是完整 20 帧 APNG。只有触发 resize（>2000px 或 >4.5 MB）时 stb 才只解码首帧，行为随尺寸而变。
- **影响**：MUST 项未实现，模型侧文本与 metadata 描述失实（消费方按"首帧"语义处理会拿到动图）。
- **建议**：① 对 `animated` 源在预算内也强制首帧抽取后重编码；或 ② 若有意直出原图，则同步修正文档、schema 描述与文本标记（如 `animated` 而非 `first frame`）。

### F-02（P2，non-blocking）`view_image` 描述宣称支持 webp

- **文档**：§5「webp 未启用——当前构建不带解码器，统一报 `E_UNSUPPORTED_FORMAT` + `detail.supported`」；§六.4「`description` MUST 与实现一致」。
- **代码**：`src/rpc.cpp:680`（描述写死 `(png, jpeg, gif, bmp, tiff, webp)`）；`src/rpc.cpp:1175-1180` 与 `1345-1349` 用 `#ifdef BOXSH_HAVE_WEBP` 条件编译，而**全仓库（含 `CMakeLists.txt`、`.github/`、`build/` 缓存）无任何位置定义 `BOXSH_HAVE_WEBP`**。
- **证据**：`tests/fixture/fixture.webp` → `E_UNSUPPORTED_FORMAT`，`detail.supported=[image/png,image/jpeg,image/gif,image/bmp,image/tiff]`（无 webp）。
- **同类文案**：`sdk/js/README.md:258`、`sdk/py/src/boxsh_py/client.py:376`、`sdk/js/src/client.mjs:229`（无 "when built with libwebp" 限定）；`README.md:195`、`docs/usage.md:932` 有限定词，可接受。
- **附注**：现有 CI 文案检查（`tests/tool-contract.test.mjs:124-137`）只拦 `base64` / `nine tools` / bash `json`，拦不住此类过时格式列表。
- **建议**：描述改为按 `BOXSH_HAVE_WEBP` 编译期拼接，或直接删除 webp。

### F-03（P2，non-blocking）`edit` 的 `destructiveHint`

- **文档**：§四 表格 edit 行 `annotations` 列 = `destructiveHint:true`。
- **代码**：`src/rpc.cpp:786-790` 为 `readOnlyHint:false, destructiveHint:false`。
- **证据**：`tools/list` 实测 `edit | ann: {"destructiveHint":false,"readOnlyHint":false,"title":"Edit File"}`；`tests/tool-contract.test.mjs:106-115` 只断言 `readOnlyHint` 存在，未校验取值，故测试不会发现。
- **影响**：客户端可能据此跳过破坏性确认；edit 会改写文件，语义上属破坏性。
- **建议**：改为 `destructiveHint:true`，或在契约表里改口径。

### F-04（P2，non-blocking）`read` 首行超长时突破 50 KiB 描述上限

- **文档**：§四 read 行（截断追加提示）；描述与 README 同源：`src/rpc.cpp:643`、`README.md:184`、`docs/usage.md:910`（"capped at 2000 lines or 50 KiB per call"）。
- **代码**：`src/rpc.cpp:1243` —`if (collected > 0 && total_bytes + line_bytes > DEFAULT_MAX_BYTES)`：首行（`collected == 0`）无条件放行；`DEFAULT_MAX_BYTES = 50*1024`（`src/rpc.cpp:1220`）。
- **证据**：200 KiB 单行文件 → `content.text` = **204,860 B**（约 200 KiB），`structuredContent={line_count:1, truncated:true, total_lines:2, next_offset:2}`，正文未裁剪、仅追加截断提示。
- **影响**：模型侧 token 预算可被单行日志 / 压缩 JS 撑爆，且与自身描述不符。
- **建议**：对单行也做字节裁剪（截到 N KiB + 省略标记），或在描述中显式声明"单行不裁剪"。

### F-05（P3，non-blocking）bash 尾部可能被裁空

- **文档**：§2.4「保留头部 24 KiB + 尾部 24 KiB」。
- **代码**：`src/rpc.cpp:125-127`：`tail_start = utf8_floor(...); nl2 = s.find('\n', tail_start); if (nl2 != npos) tail_start = nl2 + 1;`——找不到换行时尾部被跳空；`src/rpc.cpp:131-135` 的标记按 `tail_start - head_end` 计数。
- **证据**：`python3 -c "sys.stdout.write('中'*30000)"`（90000 B、无换行）→ text 仅 24,627 B（头 24 KiB + 标记），标记 `[truncated: 65425 bytes of 90001 omitted]`；`head -c 200000 /dev/zero | tr '\0' 'a'` → 24,629 B。
- **影响**：与"尾部 24 KiB"承诺不符；但标记计数是准确的，非静默丢数据，`structuredContent` 仍全量。
- **建议**：尾部改为向前对齐行首（`rfind('\n', tail_start)`）或对无换行输入直接按字节切。

### F-06（P3，non-blocking）参数校验缺口

- **文档**：§2.2 错误码表 `E_INVALID_ARGUMENT | 参数缺失/类型错误`；§八.2 要求 E_INVALID_ARGUMENT 用例。
- **代码**：缺参在解析期判错（`src/rpc.cpp:306` bash command、`316` path、`330` content、`363` detail），事件循环把它序列化为 JSON-RPC 错误（`src/rpc.cpp:1996-2002`，`code:-32000`）；已声明类型的可选参只在类型匹配时才赋值（`340-347` bash timeout、`376-378` read offset/limit、`418-421` cols/rows）。
- **证据**：`read` 无 path → `{"error":{"code":-32000,"message":"parse_error: read tool missing string field: path"}}`，**不是** `isError:true + E_INVALID_ARGUMENT`；`{"offset":1.5}` / `{"limit":"2"}` / `{"offset":true}` 被静默忽略；`bash {command:"sleep 3", timeout:"1"}` 静默忽略 timeout，实测 `duration_ms:3010`。
- **说明**：`README.md:264-266` 已把 "missing/invalid arguments" 归为 Protocol error，代码与 README 自洽，但与契约 §2.2 的 E_INVALID_ARGUMENT 语义有出入（该码实际只用于 write 非法 base64、edit oldText 无法匹配 / 重叠、目录路径等场景）。`timeout` 被静默忽略有实际风险。
- **建议**：统一为 E_INVALID_ARGUMENT 工具错误，或在契约里补一句"参数层面错误一律走 JSON-RPC 协议错误"，并对已声明类型的可选参做显式校验；顺带：错误码宜用 `-32602`（invalid params）而非 `-32000`。

### F-07（P3，non-blocking）`read` 的 UTF-8 校验只覆盖返回页

- **文档**：§5「声明为文本但非合法 UTF-8 → `E_NOT_TEXT`」。
- **代码**：`src/rpc.cpp:1265`（`is_valid_utf8(text_content)`，`text_content` 是切片）。
- **证据**：文件 = 50 行 `a` + `0xE9` 行 + 其余；`read {offset:1,limit:2}` → **成功**返回 `a\na\n`；整文件读取 → `E_NOT_TEXT`。
- **说明**：返回页本身是合法 UTF-8，行为可辩护（避免为校验读全文件），但与文档措辞不符，且同一文件不同参数给出不同语义。
- **建议**：文档补"按页校验"或对探测头（前 8 KiB）另行校验。

### F-08（P3，non-blocking）`read.mime_type` 示例不符

- **文档**：§5「`mime_type` 仍来自 magic-byte 检测（如 `text/x-shellscript`）」。
- **代码/文档**：`src/file_type.cpp:470-481` 对文本一律返回 `text/plain`，空文件返回 `inode/x-empty`；`src/rpc.cpp:660`、`sdk/js/src/index.d.ts:41`、`sdk/js/README.md:68`（`text/x-c++`）沿用错误示例。
- **证据**：`/tmp/t.sh` → `mime_type:"text/plain"`；空文件 → `mime_type:"inode/x-empty"`。
- **建议**：修正示例；空文件改回 `text/plain`。

### F-09（P3，non-blocking）终端工具文本/错误细节偏差

- **文档**：§四（run_in_terminal 文本 `terminal ID (COMMAND) started`；list_terminals 每行 `ID  running|exited(N)  COMMAND`；§2.2 `message` 形如 `<tool>: <说明>`）。
- **代码**：`src/rpc.cpp:956-965` 输出 `terminal ID (cmd), running` / `, exited, code N`（无 `started`）；`src/rpc.cpp:1063` list_terminals 文本不含 exit code；`src/rpc.cpp:967-971` 终端异常消息原样抛出（`unknown terminal session: <id>` / `terminal session has exited: <id>`），无 `terminal_*:` 前缀。
- **附注**：已退出但仍在列表中的会话，`send_to_terminal` 报 `E_NOT_FOUND`（`src/rpc.cpp:969`），与"E_NOT_FOUND=不存在"语义不符（会话存在）。
- **建议**：对齐模板、补前缀；或改用 `E_INVALID_ARGUMENT` 并在文档同步。

### F-10（P3，non-blocking）`E_TOO_LARGE` 不可达、`E_TIMEOUT` 无生产者

- **文档**：§2.2、§2.3「解码成功但任何编码组合都超限 MUST 报 `E_TOO_LARGE`」、§八.2 要求 E_TOO_LARGE 用例。
- **代码**：`src/image_resize.cpp:120-141`（每轮 4 档 JPEG 质量 + PNG 取小，再尺寸减半，最多 8 轮）；`src/rpc.cpp:1332-1337`（E_TOO_LARGE 分支）；`src/rpc.h:37`（`kTimeout`）。
- **说明**：任何可解码图片在 `2000/2^7 ≈ 15px` 时必然远小于 4.5 MB，`TooLarge` 实际不可达（等价死代码）；`E_TIMEOUT` 在 C++ 侧无任何生产者（bash 超时走 command-failure：`exit_code:-1 + timed_out:true + isError`）。`tests/tool-contract.test.mjs:35-38` 只把 E_TOO_LARGE/E_TIMEOUT/E_SANDBOX/E_INTERNAL 列入白名单，无触发用例（§八.2 明确要求 E_TOO_LARGE 用例）。
- **建议**：补一条 E_TOO_LARGE 用例（或下调该分支预期）；明确 E_TIMEOUT 归属（保留为未来使用需在文档注明）。

### F-11（P3，non-blocking）文档/SDK 残留旧行为

- `docs/usage.md:1231`：`const { diff } = await client.edit(...)` — edit 已不返回 diff（§七 决策；`sdk/js/src/client.mjs:283-291` 返回 `void`），示例会拿到 `undefined`。**这是唯一仍描述旧 `diff` 行为的用户文档**。
- `README.md:553`：`image_resize.h / .cpp Image resizing for binary read responses` — resize 现在只服务 `view_image`（`read` 不再返回图片）。
- `tests/file-type.test.mjs:328`：注释仍写 "encoding will be 'image' … or 'metadata'" — metadata 回落已删除。
- `sdk/js/src/client.mjs:10-16`：协议注释仍写旧的扁平请求（`{id, cmd, timeout?}` / `{id, tool:"read|write", path}`）与旧响应形状（`shell: {id, exit_code, …}`），实际是 JSON-RPC 2.0 + `CallToolResult`。

### F-12（P3，non-blocking）缺少"工具集静态 / 需重启"的 README 说明

- **文档**：§六.2「…因此不发 `notifications/tools/list_changed`，并**在 README 明确要求重启**」。
- **证据**：`README.md`、`docs/usage.md` 全文无 `listChanged`，也无"重启后 `tools/list` 才更新"的提示；`README.md:151` 仅写 "Returns server capabilities and protocol version"。

### F-13（P3，non-blocking，信息性）bash 结构化流的 UTF-8 有损替换

- **文档**：§2.4「`structuredContent.stdout/stderr` 仍是权威数据」。
- **代码**：`src/rpc.cpp:458-476`（`ensure_valid_utf8` 同时作用于 text 与 structured）；`src/io_utils.cpp:60-133`（非法序列→U+FFFD，无计数、无 `lossy` 标记）。
- **说明**：JSON 传输无法承载非法 UTF-8，替换不可避免，但消费方无法得知权威数据被替换；"权威"仅对合法 UTF-8 成立。

---

## 已验证正确的部分（覆盖说明）

**统一出口 / 通道职责**
- 工具结果只有一条序列化路径：`rpc_serialize_tool_result`（`src/rpc.cpp:479`），调用点仅 `run_builtin_tool`（`1716`）与 `rpc_serialize_response`（`529-535`，bash/worker 路径）；`src/main.cpp` 不构造任何工具结果；`socketpair` 失败与 tool 线程异常的兜底也走同一出口（`1943/1964`）。
- 无任何工具把 `structuredContent` dump 进 `content.text`：bash 文本由 `bash_result_text`（`140-160`）生成、终端/read/write/edit 各自生成可读文本，实测 `content.text` 均不以 `{` 开头。
- 图片只出现在 `view_image` 结果中（全仓库仅 `src/rpc.cpp:1363` 一处 push image 块）；image 块只在 `content`，`structuredContent` 无 base64（实测 + `tests/tool-contract.test.mjs:483-489`）。

**错误模型**
- 所有工具错误的 `code` 均取自 `error_code::*` 常量表（`src/rpc.h:31-41`），未出现 `E_PATH_ESCAPE` 或未文档化码；全部为 `isError:true + content.text("<CODE>: message") + structuredContent{code,message,detail?}`（`src/rpc.cpp:487-497`）。
- bash 非零退出：`isError:true` 且 `structuredContent` 是正常命令结果、无 `code`（实测 `exit 42` → `{exit_code:42,stdout:"partial\n",…}`）——与 §2.2 判别规则一致。
- 错误码实测覆盖：`E_NOT_FOUND`（read/view_image/edit/终端未知 id）、`E_NOT_IMAGE`（read 图片、view_image 非图片，read 侧 detail 含 `{mime,size}`）、`E_NOT_TEXT`（二进制、整文件非法 UTF-8）、`E_UNSUPPORTED_FORMAT`（webp/jxl，含 `detail.supported`）、`E_INVALID_ARGUMENT`（目录、write 非法 base64、edit 匹配失败/重叠）。

**bash 文本预算（§2.4）**
- 预算内：实测最大 49,201 B（`seq 1 200000` 双流）≤ 50 KiB；标记格式与文档一致 `… [truncated: N bytes of M omitted] …`，行边界切分；CJK/多字节用例无 U+FFFD（UTF-8 安全）；`structuredContent.stdout` 全量（1,988,895 B 完整、`stderr_truncated`/`timed_out` 标记按需出现）。
- 小输出不裁剪、静默成功 → `"(no output)\n"`、`[stdout]/[stderr]` 分节与 `[exit code: N]` 均符合 §四。

**read**
- 分页保真：57 KB / 200 行文件按 `next_offset` 连续读取，200/200 行无重复无遗漏；`limit=37` 轮询同样 200/200；`total_lines`/`next_offset` 仅在 `truncated` 时出现，`line_count`=本次返回行数。
- 截断提示格式与文档一致；目录 → `E_INVALID_ARGUMENT`；整文件非法 UTF-8 → `E_NOT_TEXT`；`structuredContent` 不含正文副本（无 `content` 字段，`tests/mcp.test.mjs:185-193` 亦断言）。

**view_image**
- 尺寸预算：默认最长边 ≤2000px、`detail:"low"` ≤512px、`was_resized`/`original_*`/`size`（原始文件字节数）语义正确（`tests/view-image.test.mjs` 全绿 + 手工复验）；base64 上限常量 4,718,592（`src/image_resize.h:9`）。
- 动图检测：GIF 按块结构数帧、PNG 按 `acTL`（`src/rpc.cpp:168-226`）——`fixture.apng`（acTL num_frames=20）→ `animated:true`；单帧 `fixture.gif` → `false`；静态 PNG/JPEG 不出现 "animated" 文案。
- 错误分流与 §2.3 一致：解码失败 → `E_UNSUPPORTED_FORMAT`+`detail.supported`；`ResizeStatus::TooLarge` → `E_TOO_LARGE`+`detail{mime,size}`（分支正确，可达性见 F-10）。

**schema 一致性 / 协议**
- `tools/list` 10 个工具，全部含 `title/description/inputSchema/outputSchema/annotations`（实测）。
- 终端类 `exit_code` 严格 number|null：运行中 `null`（`run_in_terminal('bash')`）、已退出为整数（`run_in_terminal('true')` → 0；`list_terminals` 中 `exit 5` 的会话 → 5）；`run_in_terminal`/`send_to_terminal`/`get_terminal_output`/`kill_terminal` 的 required 字段齐全。
- 成功路径全部通过各自 `outputSchema` 校验（`tests/tool-contract.test.mjs` 的 `schemaErrors` 子集校验器；`outputSchema` 关键字也限定在文档化子集内）。
- `initialize` 三分支实测：无 `protocolVersion` → `2025-06-18`；`2024-10-07`/`2024-11-05`/`2025-03-26` → 原样回显；`2025-06-18` 与未知 `2026-01-01` → `2025-06-18`；`capabilities.tools.listChanged=false`；`notifications/initialized` 无响应。
- `BOXSH_VERSION=5.1.0`（§七 要求的 minor 升级）已落地。

**测试与测试基建**
- `tests/helpers.mjs` 的 JSON Schema 子集校验器（type/properties/required/items/enum/anyOf）与文档 §8.3 一致，无外部 devDependency；`tests/index.test.mjs` 已纳入 `view-image.test.mjs`、`tool-contract.test.mjs`。
- 三套宿主/SDK 测试全绿（见首部数字）。

## 未覆盖/未复核

- Docker 相关用例（30 skip，按要求未执行 docker）。
- Python SDK 测试未运行（仅静态复核 `sdk/py/src/boxsh_py/client.py`、README，结论一致）。
- libwebp（按设计未启用）、AVIF/HEIC（明确 out of scope，仅验证其按 `E_UNSUPPORTED_FORMAT`/`E_NOT_TEXT` 正常分流）。
