# boxsh WebP 集成复核（vendored libwebp 1.6.0 解码子集） · libwebp-01

- **复核对象**：`/Users/lion/works/boxsh` 工作区未提交改动中的 libwebp 集成：`third_party/libwebp/`（72 文件 / 940 KB）、`CMakeLists.txt` 的 `libwebp_decoder`、`src/image_resize.cpp`（`DecodedPixels` / `decode_webp`）、`src/rpc.cpp`（`webp_is_animated` / `supported_image_formats` / 描述与 `detail.supported`）、`tests/view-image.test.mjs` 与文档。
- **上游参照**：`/tmp/libwebp-1.6.0`（`configure.ac` = `AC_INIT([libwebp], [1.6.0])`，确为 v1.6.0 源码包）。
- **方法**：① `diff -rq` / `cmp` 逐文件对上游；② 读 `CMakeLists.txt` 源列表并与 vendored `.c` 集合求差；③ 读 `config.h`/`cpu.h` 的编译宏门控并推演每个交叉目标；④ 逐行读解码/动图/动画判定实现；⑤ 真实二进制探针（含手工构造畸形文件）+ 像素级对照（`webpmux`/`dwebp`/`magick`）+ RSS 泄漏对照；⑥ 三份测试套件 + 无 `BOXSH_HAVE_WEBP` 语法的编译检查。**未修改任何源码/测试/文档**（本文件为唯一新增产物）。
- **环境**：macOS arm64；`cmake --build build -j` 成功；`node --test tests/view-image.test.mjs` → **15 pass / 0 fail**；`node --test tests/index.test.mjs` → **657 pass / 0 fail / 30 skip**；`BOXSH=build/boxsh node --test sdk/js/test/all.test.mjs` → **47 pass / 0 fail**（`session.test.mjs` 单跑 31 pass）。按指令未执行 docker，故 Linux 交叉目标的链接未实测（见 F-03）。

## 结论

**blocked** —— 1 项 P2 阻塞（WebP 动画判定的畸形输入死循环，已复现），另有 1 项同根因 P2（PNG/APNG 判定，同一改动集）。其余为 P3 文案/文件集/用例强度问题，不阻塞。

## 阻塞项（blocking）

| # | 严重度 | 位置 | 说明 |
|---|---|---|---|
| F-01 | P2 | `src/rpc.cpp:246`（循环 236-248） | `p += 8u + len + (len & 1u)` 的 32 位回绕使 `p` 不前进 → 畸形 WebP 让 `view_image` 永久死循环（32 字节文件即可复现） |
| F-02 | P2 | `src/rpc.cpp:223`（循环 213-225） | `p += 12u + len` 同类回绕 → 畸形 PNG 让 `view_image` 永久死循环（本次新增代码，与 F-01 同根因） |

## 发现清单

| # | 严重度 | 阻塞 | 主题 | 文档位置 | 代码位置 |
|---|---|---|---|---|---|
| F-01 | P2 | blocking | `webp_is_animated` 长度自增回绕 → 死循环 | 契约 §2.2/§四（畸形输入应报 `E_UNSUPPORTED_FORMAT`） | `src/rpc.cpp:246` |
| F-02 | P2 | blocking | `png_is_apng` 同类回绕 → 死循环 | 同上 | `src/rpc.cpp:223` |
| F-03 | P3 | non-blocking | README 的 SIMD/MIPS caveat 不完整：MSA 在 mips64 上仍可能被打开 | `third_party/libwebp/README.md:46-51` | `third_party/libwebp/src/dsp/cpu.h:152-162`、`src/webp/config.h:1-40` |
| F-04 | P3 | non-blocking | README 称"没有该目录也能构建"，实际 CMake 直接配置失败 | `third_party/libwebp/README.md:35` | `CMakeLists.txt:218-256` |
| F-05 | P3 | non-blocking | 未编译的编码侧源码 + 上游 `Makefile.am` 属未使用文件，与 README"Not vendored"自述矛盾 | `third_party/libwebp/README.md:21-24` | `third_party/libwebp/src/utils/{bit_writer_utils,huffman_encode_utils,quant_levels_utils}.c`、`src/{dec,utils}/Makefile.am`；`CMakeLists.txt:221-256` |
| F-06 | P3 | non-blocking | 契约文档 §1.1 仍写"仅 stb（无 libwebp）"；文件数/体积计数过时 | `docs/analysis-tool-result-contract.md:21`、`:226` | — |
| F-07 | P3 | non-blocking | 动图用例未锁定"首帧"内容（只验证已重编码） | `tests/view-image.test.mjs:176-193` | `src/image_resize.cpp:62-88` |
| F-08 | P3 | non-blocking（信息性，非本次引入） | 大图重编码路径峰值 RSS 随请求线性增长（PNG 对照组同样增长） | — | `src/image_resize.cpp:199-247`（共享路径） |

---

### F-01（P2，blocking）`webp_is_animated` 的 32 位长度自增回绕导致死循环

- **代码**：`src/rpc.cpp:236-248`，关键行 `src/rpc.cpp:246`：

  ```cpp
  uint32_t len = ...;                     // 文件内的 4 字节小端长度（可任意取值）
  ...
  p += 8u + len + (len & 1u);             // 8u/len/(len&1u) 均为 32 位，结果按 2^32 回绕
  ```

  `8u + len + (len & 1u)` 是 `unsigned int`（32 位）运算：当 `len == 0xFFFFFFF8` 时结果恰为 `2^32 → 0`，于是 `p += 0`，`p` 不前进；若该位置的四字节不是 `ANIM`/`VP8X`/`VP8 `/`VP8L`，`while (p + 8 <= s.size())`（`:236`）会以完全相同的一轮无限重复。
- **证据（真实二进制）**：构造 32 字节文件 `RIFF` + size + `WEBP` + `XXXX` + `F8 FF FF FF` + 12×`00`，经 `view_image` 调用 `./build/boxsh --rpc`：

  ```
  crafted file: 32 bytes
  *** TIMEOUT after 6s: boxsh is spinning (infinite loop confirmed) ***
  ```

  未命中该长度值时同结构文件正常返回 `E_UNSUPPORTED_FORMAT`（对照见“已核对”）。
- **影响**：`view_image` 指向任意不受信任的 `.webp`（仓库内文件、下载物、被检出的第三方资源）即可让 boxsh 进程 100% CPU 空转、永不返回——MCP 会话随之挂死（无输出、无错误码、无法超时退出）。属于可由输入触发的可用性缺陷，非内存安全缺陷。
- **建议**：用 `size_t` 累加并显式防回绕/不前进，例如

  ```cpp
  const size_t adv = 8u + static_cast<size_t>(len) + (len & 1u);
  if (adv == 0 || adv > s.size() - p) break;   // 长度越界视为畸形，直接停止扫描
  p += adv;
  ```

### F-02（P2，blocking）`png_is_apng` 同类回绕（同一改动集新增代码）

- **代码**：`src/rpc.cpp:213-225`，关键行 `src/rpc.cpp:223`：`p += 12u + len;`。`len == 0xFFFFFFF4` 时 `12u + len` 回绕为 0，`p` 不前进；块类型非 `acTL`/`IDAT`/`IEND` 时死循环。
- **证据**：构造 `\x89PNG\r\n\x1a\n` + `FF FF FF F4`（大端长度）+ `XXXX` + 8×`00`（24 字节）：

  ```
  crafted png: 24 bytes; length field = fffffff4 type = b'XXXX'
  *** TIMEOUT after 6s -> png_is_apng infinite loop confirmed ***
  ```

  （注意 PNG 长度字段在前、大端；第一次用 `XXXX` 当长度字段时不会触发，故该缺陷对字节序敏感。）
- **归属**：本次评审范围是 libwebp 集成，此项不在 libwebp 目录内，但 `image_is_animated()` 是范围条目 4 明确点名的函数、且与 F-01 同一提交新增、同一修复模式，建议一并修复。
- **建议**：与 F-01 相同的 `size_t` + 越界/不前进即 `break`。（`gif_frame_count` 的 `skip_sub_blocks` 每次循环至少前进 1 字节，已确认不会死循环。）

### F-03（P3，non-blocking）config.h 的 SIMD 门控分析 + README caveat 精度

逐条核对 `src/webp/config.h`（boxsh 自写；72 个文件里只有它和 `README.md` 不是上游文件）与 `src/dsp/cpu.h`：

| 目标路径 | 判定宏 | 结论 |
|---|---|---|
| x86 / ia32 / x86_64 SSE2/SSE4.1/AVX2 | `(defined(__SSE2__)…) && (!defined(HAVE_CONFIG_H) \|\| defined(WEBP_HAVE_SSE2))`（`cpu.h:68-92`） | `HAVE_CONFIG_H` 已定义且 `config.h` 不含 `WEBP_HAVE_*` → **关闭** ✔ |
| arm / arm64 NEON、Android NEON | 同型门控（`cpu.h:121-136`）；Android 另需 `HAVE_CPU_FEATURES_H`（`config.h` 未定义） | **关闭** ✔ |
| 线程 | `WEBP_USE_THREAD` 未定义（`config.h` 无该宏） | 单线程路径 ✔（`thread_utils.c` 仍编译，但不引入 pthread 依赖） |
| MIPS32 / MIPS-DSP-R2 | `defined(__mips__) && !defined(__mips64) && …`（`cpu.h:152-158`） | 仅 32 位 MIPS 打开；mips64 因 `!__mips64` **关闭** ✔（README 说法正确） |
| MSA | `defined(__mips_msa) && defined(__mips_isa_rev) && (__mips_isa_rev >= 5)`（`cpu.h:160-162`） | **不含 `!__mips64`**：mips64 上若工具链启用 MSA（`-mmsa`，或 `-march` 隐含）仍会打开，进而引用未 vendor 的 `*_msa.c` 符号 → 链接失败 |

- **不准确性**：README:49-50 的括号“mips64（where upstream disables those paths because `__mips64` is defined）”只对 MIPS32/MIPS-DSP-R2 成立，对 MSA 不成立。
- **现状风险**：`.github/workflows/build.sh` 对 mips64 用 clang `--target=mips64el-linux-gnuabi64`（无 `-mmsa`），`__mips_msa` 不会定义；loong64 走 `loongarch64-unknown-linux-gnu` GCC（`__mips__` 未定义，`cpu.h` 无 LoongArch 分支）；ppc64/riscv64 无 SIMD 分支 → **当前矩阵安全**。风险仅在“mips64 + 默认开 MSA 的工具链”。
- **建议**：把 caveat 改为“只有 32 位 MIPS 或启用 MSA 的 mips64 工具链会链接失败”；如需硬保证，可在 CMake 侧对 mips64 目标显式 `-mno-msa`（不可移植）或改判为“已知限制”。

### F-04（P3，non-blocking）“没有该目录也能构建”不成立

- **文档**：`third_party/libwebp/README.md:35`：“…so a build without this directory still works and simply reports `E_UNSUPPORTED_FORMAT` for WebP。”（段落 33-36）
- **代码**：`CMakeLists.txt:218-256` 无条件把 31 个 vendored 源文件列入 `LIBWEBP_SOURCES`。
- **证据**：CMake 对列出的不存在源文件直接报错（实验：`add_library(x STATIC /tmp/does-not-exist.c)` → `CMake Error … Cannot find source file`，`CMake Generate step failed`）。即“删掉 `third_party/libwebp/` 仍能构建”为假；真正的无 WebP 构建需要同时移除该 target 与 `-DBOXSH_HAVE_WEBP`（当前无 CMake 开关，只能改文件）。
- **建议**：措辞改为“`BOXSH_HAVE_WEBP` 未定义时（如 `#ifdef` 所见）描述与 `detail.supported` 均不含 webp”，或把源列表包进 `if(EXISTS ${LIBWEBP_SRC}/dec/webp_dec.c)` 并提供 `BOXSH_HAVE_WEBP` 的 CMake option。

### F-05（P3，non-blocking）文件集中的未使用文件与 README 自述矛盾

- README:21-24 明确写 “Not vendored: … every `Makefile.am`/`CMakeLists.txt` of the upstream project”，但树内存在 `src/dec/Makefile.am`、`src/utils/Makefile.am`（均为上游原文件）。
- `src/utils/bit_writer_utils.c`、`huffman_encode_utils.c`、`quant_levels_utils.c`（合计 36 KB）在树内但**不在** `LIBWEBP_SOURCES`：已核对编译产物对 `VP8*BitWriter*`/`VP8LCreateHuffmanTree`/`QuantizeLevels` 无未定义引用，确属编码侧死重（README 的 “src/utils/” 清单也未提这些文件）。README:64 的升级脚本用 `cp $SRC/utils/*` 会在每次升级时**再次**把它们带进来。
- **建议**：删掉这 5 个文件，或把升级脚本改为白名单拷贝，并在 “What is vendored” 中显式声明“保留编码侧 utils 但未编译”。
- 附带（观感）：静态库产物名为 `build/liblibwebp_decoder.a`（target 名自带 `lib` 前缀被 CMake 再加一次），不影响构建。

### F-06（P3，non-blocking）契约文档两处过时数字/描述

- `docs/analysis-tool-result-contract.md:21`（§1.1 现状盘点表）仍写“图片解码｜仅 stb（无 libwebp）……解码失败回落 metadata 文本”——这是改造前的快照，但文档自称“唯一规范出处”，且 §十:226 已宣告 libwebp 落地，前后矛盾。
- `docs/analysis-tool-result-contract.md:226` 的 “70 文件 / 932 KB” 与实际（`find` 计数 **72** 文件、`du -sk` **940 KB**）不符。
- **建议**：§1.1 加“（改造前快照，见 §十）”标注或更新该行；把计数改为 72 文件 / 940 KB（若剔除 F-05 的 5 个文件则改为 67 文件 / ~904 KB）。

### F-07（P3，non-blocking）动图用例未验证“是第一帧”

- `tests/view-image.test.mjs:176-193` 断言了 `animated=true`、`64x48`、`was_resized=false`、输出不等于原文件、不含 `ANIM`；这些条件对“首帧”和“末帧”都成立（fixture 两帧尺寸相同）。
- **我的独立验证**：用 `webpmux -get frame {1,2}` + `dwebp -pam` 取参考帧、`magick` 把 boxsh 返回的 PNG 转回 RGBA，逐字节比较：

  ```
  frame1 == frame2 ? False | sizes: 12288 12288 | boxsh out: 12288
  boxsh output == frame1 ? True
  boxsh output == frame2 ? False
  ```

  即当前实现确实返回首帧（canvas 合成正确），但仓库测试无法防回归。
- **建议**：fixture 两帧像素明显不同，把“首帧参考像素”（或参考 PNG fixture）纳入断言。

### F-08（P3，non-blocking，信息性）大图重编码路径的峰值内存随请求数增长

- 实测（输出重定向到 `/dev/null`，`/usr/bin/time -l` 的 maximum RSS）：2400×1600 输入连续调用 → 1 次 51 MB / 20 次 869 MB / 60 次 2380 MB（约 38 MB/请求）。
- **对照组**：同一图转成 2400×1600 PNG（纯 stb 路径，本次改动未触碰）→ 1 次 41 MB / 20 次 669 MB / 60 次 1971 MB，同样线性增长 → **非本次改动引入**，属共享的重编码路径既有行为，本次不判缺陷，仅记录。
- 与 libwebp 相关的两条路径是干净的：静态 WebP 直出 6000 次峰值 7.3→24.2 MB（平台期，无每请求增长）；动图重编码 600 次峰值 14.3 MB。

---

## 已核对项（结论 + 方法/证据）

1. **逐文件上游一致性**：`diff -rq` 比对 `src/dec`、`src/utils`、`src/demux`，`cmp` 比对 `src/dsp/*`、`src/webp/*` → vendored 的 70 个上游文件（69 个 `src/**` 文件 + `COPYING`）**逐字节一致**；72 个文件里只有 2 个非上游：`src/webp/config.h`（自写，头部已注明）与 `README.md`（boxsh 自述文件）。`COPYING` 与上游字节一致（BSD-3-Clause，含 patents 授权指向）；`README.md` 的 tag/来源描述准确；`/tmp/libwebp-1.6.0` 确为 v1.6.0（`configure.ac`）。
2. **文件集充分性**：`src/dec` = 上游 `DEC_*` 全集；`src/dsp` = 上游 `COMMON_SOURCES`（9 个 .c + 5 个头文件，与 README:25 自述一致）；`src/demux` = `demux.c` + `anim_decode.c`；`encode.h`/`mux.h` 虽属编码侧头文件但**被已编译的 `palette.c`/`utils.c`/`demux.c`/`anim_decode.c` 直接 include**，必须保留。静态解码（`fixture.webp`，`WebPDecodeRGBA` + `WebPFree`）、动图首帧（`WebPGetFeatures` → `WebPAnimDecoder*`）、特性/尺寸查询（`original_width/height`、`animated`）三条路径均由测试与探针走通。
3. **链接完整性**：macOS 构建成功，`nm` 显示 libwebp 对象仅依赖 libc（`memcpy/malloc/qsort/__stack_chk_*` 等），**不需要 `-lm`，也不需要 pthread**；交叉目标未实测（未用 docker），但宏推演见 F-03。`target_link_libraries` 中 `libwebp_decoder` 与本项目其它静态库无相互依赖，链接顺序无隐患。
4. **CMake 源列表与树完全对应**：`comm` 求差 → 列出但缺失 = 0；树内未列出 = 恰为 F-05 的 3 个编码侧 `.c`（已确认无被引用符号）。`target_include_directories(... PUBLIC)` 使 `<webp/decode.h>` 在 `boxsh` 目标内可解析（`boxsh.dir/flags.make` 可见 `-Ithird_party/libwebp{-src,}`），`HAVE_CONFIG_H` 仅对 `libwebp_decoder` 生效（PRIVATE），未污染 boxsh 侧编译单元。
5. **无 `BOXSH_HAVE_WEBP` 构建**：以 `c++ -fsyntax-only`（去掉 `-DBOXSH_HAVE_WEBP`，其余 flags 取自 `boxsh.dir/flags.make`）编译 `src/rpc.cpp` + `src/image_resize.cpp` → 无错误（仅 stb 既有告警）。两处 `#ifdef` 覆盖解码分派、`supported_image_formats()`、`detail.supported` 数组；`file_type.cpp:74-76` 始终识别 webp，因此该构建下 `.webp` 走 stb 解码失败 → `E_UNSUPPORTED_FORMAT` 且 `detail.supported` 不含 webp，与契约一致。
6. **解码与所有权**：`DecodedPixels`（`image_resize.cpp:36-46`）以 `stbi_image_free` 释放 stb 像素、以 `std::vector` 持有 libwebp 拷贝，无双重释放/漏放；`decode_webp`（`:54-101`）在 `WebPAnimDecoderNew` 成功后所有分支都执行 `WebPAnimDecoderDelete`（`:86`），拷贝发生在删除之前（`:81`）；`WebPDecodeRGBA` 后 `WebPFree`（`:94`）。动图返回缓冲区确为 **canvas 尺寸**（`anim_decode.c:138-142` 分配 `canvas_w*4*canvas_h`；`:444` `*buf_ptr = dec->curr_frame`），故按 `info.canvas_width/height*4` 拷贝不会越界/截断——这一点也被像素对照证实。
7. **`always_reencode` 语义**：`rpc.cpp:1398-1400` 以 `animated` 作为 `always_reencode`；`image_resize.cpp:201` 的“原字节快路径”仅在非动图且尺寸达标时启用 → 小静态 WebP 以 `image/webp` 原样直出（探针：`[Image: image/webp, 200x133]`，`mime_type=image/webp`），动图强制重编码（探针：`[Image: image/png, 64x48, animated, first frame]`），与 README:195 / usage.md:932-943 / SDK 文案一致。`was_resized` 改为“维度是否变化”（`:240`，早退分支保持 `false`）→ 动图同尺寸重编码时 `was_resized=false`，与 `view_image` 描述“Whether the image was downscaled”一致。
8. **非 WebP 格式行为**：`git diff HEAD -- src/image_resize.cpp` 显示非 WebP 路径改动仅 3 处——显式 `stbi_image_free` 改为 RAII 析构、`!always_reencode` 守卫、`was_resized` 改为维度比较；解码仍走 `stbi_load_from_memory`，`channels > 4` 钳制语义不变（`:127`），`resize_image` 的尺寸/质量回退循环（`:226-247`）逐行未变。png/jpeg/gif/bmp/tiff 的既有用例（`view-image.test.mjs` 内 gif/jpeg/bmp、index 套件）全绿。
9. **动画判定正确性（合法输入）**：`webp_is_animated`（`rpc.cpp:231-249`）按 chunk 前进、`ANIM` 命中即真、`VP8X` 取 flags 的 `0x02`（与上游 `mux_types.h:34` 的 `ANIMATION_FLAG = 0x00000002` 一致）、遇到顶层 `VP8 `/`VP8L`（纯静态）即假、奇数长度按 RIFF 补齐（`len & 1u`）→ 对合法文件无误判（4 个 fixture 与 `webpinfo` 输出逐项一致）。缺陷仅在畸形长度（F-01）。
10. **fixture 真实性**：`webpinfo` 确认 `boxsh-large.webp` = 2400×1600 VP8 有损单帧、`boxsh-animated.webp` = VP8X(canvas 64×48, Animation=1) + ANIM + 2×ANMF(64×48, VP8L)、`fixture.webp` = 200×133、`fixture-json.webp` = 19 字节 JSON 文本（用作“扩展名是 .webp 但不是图片”的反例，断言 `E_NOT_IMAGE`）。
11. **文档一致性**：`README.md:25,195`、`docs/usage.md:932,943`、`sdk/js/README.md:258`、`sdk/js/src/client.mjs:229`、`sdk/py/src/boxsh_py/client.py:376-379`、`sdk/js/src/index.d.ts`（`mimeType: string`，无枚举）均正确描述 webp：格式列表含 webp、仅动图承诺重编码为首帧、直出时 mime 可为 `image/webp`（`outputSchema` 描述“may differ from the file after re-encoding”），未发现“webp 不支持”或“webp 一律重编码”的残留。唯一过时处为 F-06（契约 §1.1 与计数）。
12. **测试与探针**：三套测试全绿（数字见页首）；手工探针覆盖 `--rpc` 静态/大图/动图/畸形/JSON-命名 5 类；畸形输入对照组（非回绕长度、截断文件）正常返回 `E_UNSUPPORTED_FORMAT`，说明 F-01/F-02 是特定长度值触发的确定性缺陷而非普遍性挂起。
13. **新增文件可入库性**：`git check-ignore -v` 对 `third_party/libwebp/**`、`tests/fixture/boxsh-{large,animated}.webp` 均无命中（未被 `.gitignore` 吞掉），但当前整套改动仍为未提交状态（untracked/modified）——评审结论以“文件内容正确但尚未提交”为前提。

## 覆盖说明与残余风险

- 覆盖：vendored 树与上游逐字节比对、文件集/源列表求差、编译宏门控推演、解码与动图路径逐行审读 + 像素级行为验证、内存所有权与泄漏对照、动画判定的合规与畸形输入、CMake 集成、无宏构建的语法检查、四份文档与两套 SDK 的文案一致性、三套测试套件与手工探针。
- 未覆盖（环境限制）：Linux 交叉目标（ia32/arm/mips64/ppc64/riscv64/loong64）的实际编译与链接（指令禁止 docker），只做了宏级推演；`mips64 + MSA` 属理论风险（F-03）。
- 残余风险：F-01/F-02 的畸形输入死循环应优先修复；其余 P3 为文档与文件集整理项。

---

## 处理记录（2026-09-13，orchestrator）

| finding | 处理 | 验证 |
|---|---|---|
| F-01（P2，blocking）`webp_is_animated` 长度回绕死循环 | 已修复：改为 `size_t` 前进 + `len > remaining - 8u` 上界检查，奇数长度补齐前再查一次 `adv + 1u > remaining` | 新增回归用例（crafted `0xFFFFFFF8` 长度，8s 超时内返回 `E_UNSUPPORTED_FORMAT`） |
| F-02（P2，blocking）`png_is_apng` 同类回绕 | 已修复：`remaining < 12u \|\| len > remaining - 12u` 则退出循环 | 同上，新增 PNG crafted 长度用例 |
| F-03（P3）config.h SIMD 门控 / README caveat 精度 | `third_party/libwebp/README.md` 已改写：MIPS32/MIPS-DSP-R2 由 `!defined(__mips64)` 排除；MSA 仅 `-mmsa` 工具链触发；若新增 MIPS/MSA 目标须一并 vendor 对应 dsp 文件 | 文档复核 |
| F-04（P3）"没有该目录也能构建"不成立 | README 已改写：`BOXSH_HAVE_WEBP` 只门控解码调用与格式列表，源码由 CMake 无条件编译，删目录是 configure 硬错误 | 文档复核 |
| F-05（P3）未使用文件与自述矛盾 | 删除 3 个编码侧 utils（`bit_writer_utils`、`huffman_encode_utils`、`quant_levels_utils` .c/.h）与 2 个 `Makefile.am` → 64 文件 / 880 KB | 删除后 macOS + Linux 均重新构建通过，view-image 17/17 |
| F-06（P3）契约文档 §1.1 描述与计数 | §一 标题改为"均指 2026-09-12 改造前的代码状态"；§十 计数更新为 64 文件 / 880 KB | 文档复核 |
| F-07（P3）动图用例未证明"首帧" | 测试内置最小 PNG 解码器（支持 5 种 filter），断言返回像素为红色首帧 (220,40,40) 且右下角同色（排除第二帧） | `tests/view-image.test.mjs` |
| F-08（P3，信息性）大图重编码峰值内存随请求数增长 | 不处理：评审已用 PNG 对照组证明为既有行为，非本次改动引入 | — |

复验（2026-09-13）：
- macOS：`node --test tests/index.test.mjs` → 689 tests / 659 pass / 0 fail / 30 skipped；`tests/view-image.test.mjs` 17/17（含 2 条死循环回归）；JS SDK 47/47；Python SDK 37/37。
- Linux（docker `boxsh-repro-build`，全新 configure + build）：build exit=0，仅 stb/dash 既有告警；容器内 index 687 tests / 657 pass（16 fail 全为基线既有的 Phase 10）、JS SDK 47/47。
