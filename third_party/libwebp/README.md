# libwebp (vendored subset)

Source: <https://github.com/webmproject/libwebp> — tag **v1.6.0**
License: BSD-3-Clause (see [COPYING](COPYING))

## What is vendored

Only the **decoder** side is vendored — boxsh decodes WebP for the
`view_image` tool and re-encodes with stb (`src/image_resize.cpp`); it never
encodes WebP itself.

```
src/webp/    public headers (decode.h, demux.h, types.h, mux_types.h, ...)
             + boxsh's own config.h (see "Build integration")
src/dec/     core decoder
src/dsp/     portable-C common paths only (no SSE2/NEON/MIPS/MSA variants)
src/utils/   bit reader, huffman, palette, rescaler, ...
src/demux/   RIFF demuxer + anim_decode (first frame of animated WebP)
```

Not vendored: `src/enc/`, `sharpyuv/`, `imageio/`, `examples/`, all `*_sse2.c`
/ `*_neon.c` / `*_mips*.c` / `*_msa*.c` / `*_avx2.c` variants and every
`Makefile.am`/`CMakeLists.txt` of the upstream project.

`src/dsp/` holds exactly the files listed as `COMMON_SOURCES` in the upstream
`src/dsp/Makefile.am` (alpha_processing, cpu, dec, dec_clip_tables, filters,
lossless, rescaler, upsampling, yuv + their headers).

## Build integration

`CMakeLists.txt` compiles the files listed above into the static library
`libwebp_decoder` (with `-w`, since this is third-party code) and defines
`BOXSH_HAVE_WEBP` for the `boxsh` target. `src/rpc.cpp` uses that macro for the
`view_image` descriptor/error text, and `src/image_resize.cpp` for the decode
path.

`BOXSH_HAVE_WEBP` only gates the decode call and the advertised format list:
the vendored sources are compiled unconditionally by `CMakeLists.txt`, so
deleting this directory without also removing `LIBWEBP_SOURCES` is a CMake
configure error, not a silent degradation.

`src/webp/config.h` here is **not** an upstream file: upstream generates it at
configure time (`cmake/config.h.in`). The vendored copy selects the portable-C
paths only — no SIMD (SSE2/SSE4.1/AVX2/NEON/MIPS/MSA) and no threads — so the
same file set builds on every cross-compiled target
(ia32/arm/mips64/ppc64/riscv64/loong64) and no per-architecture configuration
is needed. It is picked up via `-DHAVE_CONFIG_H`, which is defined **only** for
the `libwebp_decoder` target.

Caveat: upstream's `src/dsp/cpu.h` enables the MIPS32/MIPS-DSP-R2/MSA paths from
compiler macros alone, without consulting `config.h`. Those paths reference the
(unvendored) `*_mips*.c` / `*_msa.c` files, so such a build would fail to link.
boxsh's matrix does not hit this — mips64 is excluded from the MIPS32 branch by
`!defined(__mips64)`, and `__mips_msa` only appears when a toolchain is invoked
with `-mmsa` (not the case for our cross builds). If a MIPS/MSA target is ever
added, vendor the matching `src/dsp/*_mips*.c` / `*_msa.c` files too.

## Upgrading

```sh
VER=v1.6.0
curl -sSL -o /tmp/libwebp.tar.gz \
  https://github.com/webmproject/libwebp/archive/refs/tags/${VER}.tar.gz
tar xzf /tmp/libwebp.tar.gz -C /tmp
SRC=/tmp/libwebp-${VER#v}/src
DST=third_party/libwebp
rm -rf $DST/src && mkdir -p $DST/src/{webp,dec,utils,dsp,demux}
cp $SRC/webp/*.h         $DST/src/webp/
cp $SRC/dec/*            $DST/src/dec/
cp $SRC/utils/*          $DST/src/utils/
cp $SRC/demux/anim_decode.c $SRC/demux/demux.c $DST/src/demux/
for f in alpha_processing.c cpu.c cpu.h dec.c dec_clip_tables.c dsp.h \
         filters.c lossless.c lossless.h lossless_common.h rescaler.c \
         upsampling.c yuv.c yuv.h; do cp $SRC/dsp/$f $DST/src/dsp/; done
cp /tmp/libwebp-${VER#v}/COPYING $DST/COPYING
```

If upstream adds/removes a file in `COMMON_SOURCES` or in `src/dec`, update
both the copy list above and `LIBWEBP_SOURCES` in `CMakeLists.txt`.
