// Built-in file type detection via magic bytes.
//
// Inspired by https://github.com/sindresorhus/file-type (MIT).
// We only care about binary vs text — the MIME is a best-effort bonus.

#include "file_type.h"

#include <cstring>
#include <fstream>

namespace boxsh {

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

static inline bool eq(const unsigned char *buf, size_t buflen,
                      const void *sig, size_t siglen, size_t off = 0) {
    return off + siglen <= buflen && memcmp(buf + off, sig, siglen) == 0;
}

static inline bool eq_str(const unsigned char *buf, size_t buflen,
                           const char *s, size_t off = 0) {
    return eq(buf, buflen, s, strlen(s), off);
}

// TAR header checksum validation (offset 148, 8 octal digits).
static bool tar_checksum_valid(const unsigned char *buf, size_t len) {
    if (len < 512) return false;

    // Read stored checksum (octal string at offset 148, 8 bytes).
    char chk_str[8];
    memcpy(chk_str, buf + 148, 8);
    chk_str[7] = '\0';
    // Strip trailing spaces/NULs.
    for (int i = 6; i >= 0; --i) {
        if (chk_str[i] == ' ' || chk_str[i] == '\0') chk_str[i] = '\0';
        else break;
    }
    char *end = nullptr;
    long stored = strtol(chk_str, &end, 8);
    if (end == chk_str) return false;

    // Compute checksum: sum all 512 bytes, treating the checksum field
    // (bytes 148..155) as spaces (0x20).
    long sum = 8 * 0x20;
    for (size_t i = 0; i < 148; ++i) sum += buf[i];
    for (size_t i = 156; i < 512; ++i) sum += buf[i];

    return stored == sum;
}

// -------------------------------------------------------------------------
// detect_mime — returns MIME string for known binary formats, nullptr otherwise.
// -------------------------------------------------------------------------

static const char *detect_mime(const unsigned char *buf, size_t len) {
    if (len < 2) return nullptr;

    // --- Images ---------------------------------------------------------

    // PNG
    if (eq(buf, len, "\x89PNG\r\n\x1a\n", 8, 0))
        return "image/png";

    // JPEG
    if (eq(buf, len, "\xff\xd8\xff", 3, 0))
        return "image/jpeg";

    // GIF
    if (eq_str(buf, len, "GIF87a") || eq_str(buf, len, "GIF89a"))
        return "image/gif";

    // WEBP
    if (eq_str(buf, len, "RIFF") && eq_str(buf, len, "WEBP", 8))
        return "image/webp";

    // BMP
    if (eq_str(buf, len, "BM") && len >= 6)
        return "image/bmp";

    // ICO
    if (eq(buf, len, "\x00\x00\x01\x00", 4, 0))
        return "image/x-icon";

    // CUR
    if (eq(buf, len, "\x00\x00\x02\x00", 4, 0))
        return "image/x-icon";

    // TIFF (little-endian and big-endian)
    if (eq(buf, len, "II\x2a\x00", 4, 0) || eq(buf, len, "MM\x00\x2a", 4, 0))
        return "image/tiff";

    // JPEG XL
    if (eq(buf, len, "\xff\x0a", 2, 0) ||
        eq(buf, len, "\x00\x00\x00\x0c\x4a\x58\x4c\x20\x0d\x0a\x87\x0a", 12, 0))
        return "image/jxl";

    // JPEG 2000
    if (eq(buf, len, "\x00\x00\x00\x0c\x6a\x50\x20\x20\x0d\x0a\x87\x0a", 12, 0) ||
        eq(buf, len, "\xff\x4f\xff\x51", 4, 0))
        return "image/jp2";

    // HEIF / AVIF: ISO base media with ftyp at offset 4
    // (Full ftyp brand dispatch is in the Video section below)

    // JXR / WDP (3-byte signature, 4th byte varies)
    if (eq(buf, len, "\x49\x49\xbc", 3, 0))
        return "image/vnd.ms-photo";

    // PSD
    if (eq_str(buf, len, "8BPS"))
        return "image/vnd.adobe.photoshop";

    // OpenEXR
    if (eq(buf, len, "\x76\x2f\x31\x01", 4, 0))
        return "image/x-exr";

    // RAW camera formats
    if (eq_str(buf, len, "FUJIFILMCCD-RAW"))
        return "image/x-fujifilm-raf";

    // --- Audio ----------------------------------------------------------

    // ID3 tag → audio/mpeg (we don't peek past ID3 to find AAC/FLAC)
    if (eq_str(buf, len, "ID3"))
        return "audio/mpeg";

    // MPEG sync word 0xFFE0 — distinguish AAC (ADTS) from MP3/MP2/MP1
    // using the layer bits (bits 1-2 of byte 1):
    //   layer=00 (0x00) → AAC (ADTS)
    //   layer=01 (0x02) → Layer 3 (MP3)
    //   layer=10 (0x04) → Layer 2 (MP2)
    //   layer=11 (0x06) → Layer 1 (MP1)
    if (len >= 2 && (buf[0] == 0xff) && (buf[1] & 0xe0) == 0xe0) {
        if ((buf[1] & 0x16) == 0x10)  // ADTS: layer=0, sync bits set
            return "audio/aac";
        return "audio/mpeg";
    }

    // OGG container (Opus, Vorbis, Theora, FLAC inside OGG)
    if (eq_str(buf, len, "OggS"))
        return "audio/ogg";

    // FLAC
    if (eq_str(buf, len, "fLaC"))
        return "audio/flac";

    // MIDI
    if (eq_str(buf, len, "MThd"))
        return "audio/midi";

    // WAV (RIFF + WAVE)
    if (eq_str(buf, len, "RIFF") && eq_str(buf, len, "WAVE", 8))
        return "audio/wav";

    // AIFF
    if (eq_str(buf, len, "FORM") && (eq_str(buf, len, "AIFF", 8) || eq_str(buf, len, "AIFC", 8)))
        return "audio/aiff";

    // Musepack
    if (eq_str(buf, len, "MPCK") || eq_str(buf, len, "MP+"))
        return "audio/x-musepack";

    // WavPack
    if (eq_str(buf, len, "wvpk"))
        return "audio/wavpack";

    // AMR
    if (eq_str(buf, len, "#!AMR"))
        return "audio/amr";

    // AC3
    if (eq(buf, len, "\x0b\x77", 2, 0))
        return "audio/vnd.dolby.dd-raw";

    // Creative VOC
    if (eq_str(buf, len, "Creative Voice File"))
        return "audio/x-voc";

    // --- Video ----------------------------------------------------------

    // MOV atoms without ftyp: free, mdat, moov, wide at offset 4
    if (len >= 8 &&
        (eq_str(buf, len, "free", 4) || eq_str(buf, len, "mdat", 4) ||
         eq_str(buf, len, "moov", 4) || eq_str(buf, len, "wide", 4)))
        return "video/quicktime";

    // ISO Base Media ftyp box: dispatch on brand major at offset 8
    if (len >= 12 && eq_str(buf, len, "ftyp", 4) && (buf[8] & 0x60) != 0x00) {
        // Extract 4-byte brand major at offset 8
        char brand[5] = {};
        memcpy(brand, buf + 8, 4);
        // Trim trailing spaces and NULs
        for (int i = 3; i >= 0; --i) {
            if (brand[i] == ' ' || brand[i] == '\0') brand[i] = '\0';
            else break;
        }
        if (strcmp(brand, "avif") == 0 || strcmp(brand, "avis") == 0)
            return "image/avif";
        if (strcmp(brand, "mif1") == 0)
            return "image/heif";
        if (strcmp(brand, "msf1") == 0)
            return "image/heif-sequence";
        if (strcmp(brand, "heic") == 0 || strcmp(brand, "heix") == 0)
            return "image/heic";
        if (strcmp(brand, "hevc") == 0 || strcmp(brand, "hevx") == 0)
            return "image/heic-sequence";
        if (strcmp(brand, "qt") == 0)
            return "video/quicktime";
        return "video/mp4";
    }

    // Matroska / WebM (EBML)
    if (eq(buf, len, "\x1a\x45\xdf\xa3", 4, 0))
        return "video/x-matroska";

    // FLV
    if (eq_str(buf, len, "FLV\x01"))
        return "video/x-flv";

    // AVI (RIFF + AVI)
    if (eq_str(buf, len, "RIFF") && eq_str(buf, len, "AVI", 8))
        return "video/x-msvideo";

    // MPEG-PS (pack start code)
    if (eq(buf, len, "\x00\x00\x01\xba", 4, 0))
        return "video/mpeg";

    // MPEG-ES (sequence header)
    if (eq(buf, len, "\x00\x00\x01\xb3", 4, 0))
        return "video/mpeg";

    // MPEG-TS (188-byte packets, sync byte 0x47)
    if (len >= 189 && buf[0] == 0x47 && buf[188] == 0x47)
        return "video/mp2t";

    // BDAV MPEG-TS (4-byte TP_extra_header + 188-byte packets)
    if (len >= 197 && buf[4] == 0x47 && buf[196] == 0x47)
        return "video/mp2t";

    // ASF / WMV / WMA
    if (eq(buf, len, "\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9", 10, 0))
        return "video/x-ms-asf";

    // --- Archives / Compressed ------------------------------------------

    // ZIP (PK\x03\x04)
    if (eq(buf, len, "PK\x03\x04", 4, 0))
        return "application/zip";

    // ZIP (empty / spanned — PK\x05\x06 or PK\x07\x08)
    if (eq(buf, len, "PK\x05\x06", 4, 0) || eq(buf, len, "PK\x07\x08", 4, 0))
        return "application/zip";

    // gzip
    if (eq(buf, len, "\x1f\x8b", 2, 0))
        return "application/gzip";

    // bzip2
    if (eq_str(buf, len, "BZh"))
        return "application/x-bzip2";

    // xz
    if (eq(buf, len, "\xfd""7zXZ\x00", 6, 0))
        return "application/x-xz";

    // zstd
    if (eq(buf, len, "\x28\xb5\x2f\xfd", 4, 0))
        return "application/zstd";

    // 7z
    if (eq(buf, len, "7z\xbc\xaf\x27\x1c", 6, 0))
        return "application/x-7z-compressed";

    // RAR
    if (eq(buf, len, "\x52\x61\x72\x21\x1a\x07", 6, 0))
        return "application/x-rar-compressed";

    // LZ4
    if (eq(buf, len, "\x04\x22\x4d\x18", 4, 0))
        return "application/x-lz4";

    // lzip
    if (eq_str(buf, len, "LZIP"))
        return "application/x-lzip";

    // Z (compress)
    if (eq(buf, len, "\x1f\xa0", 2, 0) || eq(buf, len, "\x1f\x9d", 2, 0))
        return "application/x-compress";

    // RPM
    if (eq(buf, len, "\xed\xab\xee\xdb", 4, 0))
        return "application/x-rpm";

    // Debian package
    if (eq_str(buf, len, "!<arch>\ndebian"))
        return "application/x-deb";

    // ar archive
    if (eq_str(buf, len, "!<arch>\n"))
        return "application/x-archive";

    // cpio (ASCII formats)
    if (eq_str(buf, len, "070707") || eq_str(buf, len, "070701") || eq_str(buf, len, "070702"))
        return "application/x-cpio";

    // cpio (binary format, little-endian magic 0xC771)
    if (eq(buf, len, "\xc7\x71", 2, 0))
        return "application/x-cpio";

    // TAR: POSIX (ustar at offset 257) or V7 (null bytes at 257 + valid checksum)
    if (len >= 512) {
        if (eq_str(buf, len, "ustar", 257) && tar_checksum_valid(buf, len))
            return "application/x-tar";
        // V7 tar: no ustar magic but valid checksum
        if (eq(buf, len, "\x00\x00\x00\x00\x00\x00", 6, 257) &&
            tar_checksum_valid(buf, len))
            return "application/x-tar";
    }

    // PCAP
    if (eq(buf, len, "\xd4\xc3\xb2\xa1", 4, 0) || eq(buf, len, "\xa1\xb2\xc3\xd4", 4, 0))
        return "application/vnd.tcpdump.pcap";

    // --- Documents ------------------------------------------------------

    // PDF
    if (eq_str(buf, len, "%PDF"))
        return "application/pdf";

    // MS Office Compound Binary (doc/xls/ppt)
    if (eq(buf, len, "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", 8, 0))
        return "application/x-cfb";

    // PostScript
    if (eq_str(buf, len, "%!"))
        return "application/postscript";

    // Apache Arrow
    if (eq_str(buf, len, "ARROW1\x00\x00"))
        return "application/x-arrow";

    // Apache Parquet
    if (eq_str(buf, len, "PAR1"))
        return "application/x-parquet";

    // SQLite
    if (eq_str(buf, len, "SQLite format 3\x00"))
        return "application/x-sqlite3";

    // --- Executables / Binary formats -----------------------------------

    // ELF
    if (eq(buf, len, "\x7f""ELF", 4, 0))
        return "application/x-executable";

    // Mach-O (32/64, big/little endian)
    if (eq(buf, len, "\xfe\xed\xfa\xce", 4, 0) ||
        eq(buf, len, "\xfe\xed\xfa\xcf", 4, 0) ||
        eq(buf, len, "\xce\xfa\xed\xfe", 4, 0) ||
        eq(buf, len, "\xcf\xfa\xed\xfe", 4, 0))
        return "application/x-mach-binary";

    // Mach-O universal / fat binary
    if (eq(buf, len, "\xca\xfe\xba\xbe", 4, 0) && len >= 8) {
        // Distinguish from Java class which also starts with CAFEBABE:
        // In Mach-O fat, bytes 4-7 are the arch count (small number).
        if (buf[4] == 0 && buf[5] == 0 && buf[6] == 0 && buf[7] < 20)
            return "application/x-mach-binary";
    }

    // PE / DOS executable
    if (eq_str(buf, len, "MZ"))
        return "application/x-dosexec";

    // Java class file
    if (eq(buf, len, "\xca\xfe\xba\xbe", 4, 0))
        return "application/java-vm";

    // DEX (Dalvik)
    if (eq_str(buf, len, "dex\n"))
        return "application/vnd.android.dex";

    // --- Fonts ----------------------------------------------------------

    // TrueType
    if (eq(buf, len, "\x00\x01\x00\x00\x00", 5, 0))
        return "font/ttf";

    // OpenType
    if (eq_str(buf, len, "OTTO"))
        return "font/otf";

    // WOFF
    if (eq_str(buf, len, "wOFF"))
        return "font/woff";

    // WOFF2
    if (eq_str(buf, len, "wOF2"))
        return "font/woff2";

    // --- Other binary ---------------------------------------------------

    // WebAssembly
    if (eq(buf, len, "\x00""asm", 4, 0))
        return "application/wasm";

    // Protocol Buffers (compiled)
    if (eq(buf, len, "\x0a", 1, 0) && len >= 4 && buf[1] < 0x80)
        return nullptr;  // Ambiguous, skip.

    // LLVM bitcode
    if (eq_str(buf, len, "BC\xc0\xde"))
        return "application/x-llvm";

    // glTF binary
    if (eq_str(buf, len, "glTF\x02\x00\x00\x00"))
        return "model/gltf-binary";

    // SWF (compressed or uncompressed)
    if (len >= 3 && (buf[0] == 'F' || buf[0] == 'C' || buf[0] == 'Z') &&
        buf[1] == 'W' && buf[2] == 'S')
        return "application/x-shockwave-flash";

    // NES ROM
    if (eq(buf, len, "\x4e\x45\x53\x1a", 4, 0))
        return "application/x-nes-rom";

    // --- Text format signatures (return nullptr to let heuristic handle) ---

    // UTF-8 BOM — text, not binary.
    if (eq(buf, len, "\xef\xbb\xbf", 3, 0))
        return nullptr;

    // UTF-16 BOM — could be text.
    if (eq(buf, len, "\xfe\xff", 2, 0) || eq(buf, len, "\xff\xfe", 2, 0))
        return nullptr;

    return nullptr;
}

// -------------------------------------------------------------------------
// Heuristic: control-character and NUL analysis.
// -------------------------------------------------------------------------

static bool is_binary_heuristic(const unsigned char *buf, size_t len) {
    // ISO-8859 and UTF-8 text should not contain NUL or C0 control bytes
    // other than HT (0x09), LF (0x0A), CR (0x0D).
    size_t suspicious = 0;
    for (size_t i = 0; i < len; ++i) {
        unsigned char c = buf[i];
        if (c == 0x00) return true;   // Any NUL means binary.
        if (c < 0x08) ++suspicious;   // SOH..BEL
        if (c == 0x0e || c == 0x0f) ++suspicious;  // SO, SI
        if (c >= 0x10 && c < 0x20 && c != 0x1b) ++suspicious;  // DLE..US except ESC
    }
    // > 2% suspicious bytes → binary.
    return suspicious > 0 && suspicious * 50 > len;
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

// Buffer-based detection: need at least 512 bytes for TAR detection.
static constexpr size_t kProbeSize = 8192;

FileType detect_file_type(const unsigned char *buf, size_t len) {
    if (len == 0)
        return {false, "inode/x-empty"};

    const char *mime = detect_mime(buf, len);
    if (mime)
        return {true, mime};

    if (is_binary_heuristic(buf, len))
        return {true, "application/octet-stream"};

    return {false, "text/plain"};
}

FileType detect_file_type(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    if (!f)
        return {false, "application/octet-stream"};

    unsigned char buf[kProbeSize];
    f.read(reinterpret_cast<char *>(buf), sizeof(buf));
    auto n = static_cast<size_t>(f.gcount());

    return detect_file_type(buf, n);
}

}  // namespace boxsh
