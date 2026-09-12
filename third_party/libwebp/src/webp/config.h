// Minimal libwebp configuration for boxsh's vendored decode-only subset.
//
// Upstream generates this file with cmake/configure (see
// cmake/config.h.in in the libwebp distribution).  boxsh ships a fixed
// version that selects the portable-C code paths only:
//
//   * no SIMD (SSE2/SSE4.1/AVX2/NEON/MIPS/MSA) — one source list builds on
//     every cross-compiled target (ia32/arm/mips64/ppc64/riscv64/loong64),
//     and boxsh decodes at most one image per tool call;
//   * no thread support (WEBP_USE_THREAD) — decoding already runs on a
//     dedicated background thread inside boxsh.
//
// Defining HAVE_CONFIG_H (see CMakeLists.txt, private to libwebp_decoder)
// makes libwebp include this file.

#ifndef BOXSH_LIBWEBP_CONFIG_H_
#define BOXSH_LIBWEBP_CONFIG_H_

// Byte-swap builtins used by the bit readers.  Available on the compilers
// boxsh supports (clang/gcc); the manual fallback would work too.
#if defined(__clang__) || defined(__GNUC__)
#define HAVE_BUILTIN_BSWAP16 1
#define HAVE_BUILTIN_BSWAP32 1
#define HAVE_BUILTIN_BSWAP64 1
#endif

// Endianness: WORDS_BIGENDIAN stays undefined (all supported targets are
// little-endian), matching upstream's default.

#define PACKAGE_VERSION "1.6.0"

#endif  // BOXSH_LIBWEBP_CONFIG_H_
