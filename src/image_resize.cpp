// Image resize using stb libraries (decode: stb + libwebp, encode: stb).
// Decodes image, resizes if needed, re-encodes as JPEG or PNG.  Pixels that
// carry transparency are only ever re-encoded as PNG: JPEG has no alpha
// channel and would flatten them onto whatever RGB the transparent pixels
// hold (usually black), turning a transparent background opaque.

#include "image_resize.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#include "../third_party/stb/stb_image.h"

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "../third_party/stb/stb_image_resize2.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "../third_party/stb/stb_image_write.h"

#ifdef BOXSH_HAVE_WEBP
#include <webp/decode.h>
#include <webp/demux.h>
#endif

namespace boxsh {

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// Decoded pixels plus ownership.  Pixels come either from stb (malloc'ed by
// stb_image, freed with stbi_image_free) or from libwebp (copied into the
// vector, because WebPDecodeRGBA / WebPAnimDecoder own their buffers).
struct DecodedPixels {
    const unsigned char *data = nullptr;
    int width = 0;
    int height = 0;
    int channels = 0;
    unsigned char *stb_owned = nullptr;
    std::vector<unsigned char> webp_owned;

    ~DecodedPixels() {
        if (stb_owned) stbi_image_free(stb_owned);
    }
};

#ifdef BOXSH_HAVE_WEBP

// Decode a WebP file into RGBA pixels.  Animated files yield their first
// frame (composited onto the canvas), so the caller always receives a single
// still image.
static bool decode_webp(const std::string &raw, DecodedPixels &out) {
    const uint8_t *data = reinterpret_cast<const uint8_t *>(raw.data());
    const size_t size = raw.size();

    WebPBitstreamFeatures features;
    if (WebPGetFeatures(data, size, &features) != VP8_STATUS_OK)
        return false;

    if (features.has_animation) {
        WebPData webp_data = {data, size};
        WebPAnimDecoderOptions opts;
        if (!WebPAnimDecoderOptionsInit(&opts))
            return false;
        opts.color_mode = MODE_RGBA;

        WebPAnimDecoder *dec = WebPAnimDecoderNew(&webp_data, &opts);
        if (dec == nullptr)
            return false;

        WebPAnimInfo info;
        uint8_t *frame = nullptr;
        int timestamp = 0;
        const bool ok = WebPAnimDecoderGetInfo(dec, &info) &&
                        WebPAnimDecoderGetNext(dec, &frame, &timestamp);
        if (ok && frame != nullptr) {
            const size_t bytes = static_cast<size_t>(info.canvas_width) *
                                 static_cast<size_t>(info.canvas_height) * 4;
            out.webp_owned.assign(frame, frame + bytes);
            out.width    = static_cast<int>(info.canvas_width);
            out.height   = static_cast<int>(info.canvas_height);
            out.channels = 4;
        }
        WebPAnimDecoderDelete(dec);
        if (!ok) return false;
    } else {
        int w = 0, h = 0;
        uint8_t *rgba = WebPDecodeRGBA(data, size, &w, &h);
        if (rgba == nullptr) return false;
        out.webp_owned.assign(rgba, rgba + static_cast<size_t>(w) *
                                    static_cast<size_t>(h) * 4);
        WebPFree(rgba);
        out.width    = w;
        out.height   = h;
        out.channels = 4;
    }

    out.data = out.webp_owned.data();
    return true;
}

#endif  // BOXSH_HAVE_WEBP

// Decode any supported format.  WebP goes through libwebp (when vendored),
// everything else through stb_image.
static bool decode_image(const std::string &raw, const std::string &mime,
                         DecodedPixels &out) {
#ifdef BOXSH_HAVE_WEBP
    if (mime == "image/webp")
        return decode_webp(raw, out);
#else
    (void)mime;
#endif

    int w = 0, h = 0, channels = 0;
    unsigned char *pixels = stbi_load_from_memory(
        reinterpret_cast<const unsigned char *>(raw.data()),
        static_cast<int>(raw.size()), &w, &h, &channels, 0);
    if (!pixels) return false;

    out.stb_owned = pixels;
    out.data      = pixels;
    out.width     = w;
    out.height    = h;
    out.channels  = channels;
    // Every consumer below assumes interleaved 1–4 channel pixels; anything
    // else would silently misread the buffer, so reject it as undecodable.
    return channels >= 1 && channels <= 4;
}

// Base64 encoding (duplicated here to keep image_resize self-contained).
static const char b64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string b64_encode(const unsigned char *src, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t n = static_cast<uint32_t>(src[i]) << 16;
        if (i + 1 < len) n |= static_cast<uint32_t>(src[i + 1]) << 8;
        if (i + 2 < len) n |= static_cast<uint32_t>(src[i + 2]);
        out.push_back(b64_table[(n >> 18) & 0x3F]);
        out.push_back(b64_table[(n >> 12) & 0x3F]);
        out.push_back((i + 1 < len) ? b64_table[(n >> 6) & 0x3F] : '=');
        out.push_back((i + 2 < len) ? b64_table[n & 0x3F] : '=');
    }
    return out;
}

// ---------------------------------------------------------------------------
// Alpha policy
// ---------------------------------------------------------------------------

// What the decoded pixels say about transparency.  Every format decoded here
// stores alpha in the last channel (PNG/TGA/TIFF/BMP/GIF from stb, WebP from
// libwebp), and stb's JPEG decoder always reports 1 or 3 channels (CMYK is
// converted to RGB), so a colour channel can never be mistaken for alpha.
enum class AlphaMode {
    None,         // no alpha channel (RGB, greyscale): JPEG is safe
    Opaque,       // alpha channel present but every pixel is 255: JPEG is lossless
    Transparent,  // some pixel is not fully opaque: JPEG would drop it
};

static AlphaMode classify_alpha(const unsigned char *pixels, int w, int h,
                                int channels) {
    if (channels != 2 && channels != 4) return AlphaMode::None;
    const size_t step  = static_cast<size_t>(channels);
    const size_t total = static_cast<size_t>(w) * static_cast<size_t>(h) * step;
    for (size_t i = step - 1; i < total; i += step) {
        if (pixels[i] != 255) return AlphaMode::Transparent;
    }
    return AlphaMode::Opaque;
}

// stb_image_resize2 pixel layout for a decoded channel count.  The count must
// not be cast straight to stbir_pixel_layout: 2 would become STBIR_2CHANNEL,
// which means "there is no alpha channel here", so a greyscale+alpha image
// would be resized with the transparent pixels' grey bleeding into their
// neighbours.  STBIR_RA and STBIR_RGBA point the resizer at alpha, so it
// premultiplies, filters, un-premultiplies and keeps fully transparent pixels
// from contaminating the edge.  PNG/WebP alpha is not premultiplied, so the
// plain (_PM-less) layouts are the correct ones.
static stbir_pixel_layout pixel_layout_for(int channels) {
    switch (channels) {
        case 1:  return STBIR_1CHANNEL;
        case 2:  return STBIR_RA;
        case 3:  return STBIR_RGB;
        default: return STBIR_RGBA;
    }
}

// stb_image_write callback: accumulate bytes into a std::string.
static void write_callback(void *ctx, void *data, int size) {
    auto *out = static_cast<std::string *>(ctx);
    out->append(static_cast<const char *>(data), static_cast<size_t>(size));
}

// Byte length of the base64 encoding of `raw_len` bytes — the unit used by
// the max_bytes budget.
static size_t b64_size(size_t raw_len) {
    return ((raw_len + 2) / 3) * 4;
}

// One encoded still.  File bytes stay unencoded until a candidate is known to
// fit, so the loser of a PNG/JPEG comparison never pays for base64.
struct Candidate {
    std::string bytes;
    std::string mime;
};

// Encode pixels as PNG.  Returns false when the encoder fails.
static bool encode_png(const unsigned char *pixels, int w, int h, int channels,
                       Candidate &out) {
    std::string buf;
    if (!stbi_write_png_to_func(write_callback, &buf, w, h, channels, pixels,
                                w * channels))
        return false;
    out.bytes = std::move(buf);
    out.mime  = "image/png";
    return true;
}

// Encode pixels as JPEG.  The encoder ignores alpha, so transparent pixels
// must never reach this function (see AlphaMode).
static bool encode_jpeg(const unsigned char *pixels, int w, int h, int channels,
                        int quality, Candidate &out) {
    std::string buf;
    if (!stbi_write_jpg_to_func(write_callback, &buf, w, h, channels, pixels,
                                quality))
        return false;
    out.bytes = std::move(buf);
    out.mime  = "image/jpeg";
    return true;
}

// Pick an encoding whose base64 payload fits max_bytes.
//
// Transparent pixels may only go to PNG: JPEG has no alpha channel, so a
// transparent background would be flattened onto the RGB values stored under
// it (usually black).  Without transparency the historical policy is kept —
// PNG once, then the JPEG quality ladder, smallest fitting candidate wins.
// PNG is encoded once per dimension attempt: its size does not depend on the
// quality knob.
static bool encode_fitting(const unsigned char *pixels, int w, int h,
                           int channels, AlphaMode alpha, size_t max_bytes,
                           Candidate &out) {
    Candidate png;
    if (!encode_png(pixels, w, h, channels, png))
        return false;

    if (alpha == AlphaMode::Transparent) {
        if (b64_size(png.bytes.size()) > max_bytes)
            return false;
        out = std::move(png);
        return true;
    }

    static const int jpeg_qualities[] = {80, 60, 40, 20};
    for (int q : jpeg_qualities) {
        Candidate jpg;
        if (!encode_jpeg(pixels, w, h, channels, q, jpg))
            continue;
        const bool jpeg_wins = jpg.bytes.size() < png.bytes.size();
        const size_t smallest = jpeg_wins ? jpg.bytes.size() : png.bytes.size();
        if (b64_size(smallest) > max_bytes)
            continue;  // lower JPEG qualities may still fit; PNG is fixed
        out = jpeg_wins ? std::move(jpg) : std::move(png);
        return true;
    }
    return false;
}

// Read the dimensions declared in the header *without* decoding any pixels.
// Used to reject decompression bombs before stb/libwebp allocate a buffer
// (contract §2.3).
static bool probe_dimensions(const std::string &raw, const std::string &mime,
                             int &w, int &h) {
#ifdef BOXSH_HAVE_WEBP
    if (mime == "image/webp") {
        WebPBitstreamFeatures features;
        if (WebPGetFeatures(reinterpret_cast<const uint8_t *>(raw.data()),
                            raw.size(), &features) != VP8_STATUS_OK)
            return false;
        w = features.width;
        h = features.height;
        return w > 0 && h > 0;
    }
#else
    (void)mime;
#endif
    int channels = 0;
    if (!stbi_info_from_memory(reinterpret_cast<const unsigned char *>(raw.data()),
                               static_cast<int>(raw.size()), &w, &h, &channels))
        return false;
    return w > 0 && h > 0;
}

ResizedImage resize_image(const std::string &raw, const std::string &mime,
                          int max_width, int max_height, size_t max_bytes,
                          bool always_reencode) {
    // Reject declared-huge images before touching the pixel data.
    int declared_w = 0, declared_h = 0;
    if (probe_dimensions(raw, mime, declared_w, declared_h)) {
        const long long pixels = static_cast<long long>(declared_w) *
                                 static_cast<long long>(declared_h);
        if (pixels > kMaxImagePixels) {
            ResizedImage out;
            out.status = ImageResizeStatus::TooManyPixels;
            out.original_width = declared_w;
            out.original_height = declared_h;
            out.declared_pixels = pixels;
            out.pixel_limit = kMaxImagePixels;
            return out;
        }
    }

    DecodedPixels decoded;
    if (!decode_image(raw, mime, decoded))
        return {};  // status stays DecodeFailed

    const unsigned char *pixels = decoded.data;
    const int w = decoded.width;
    const int h = decoded.height;
    const int channels = decoded.channels;

    // Check if dimensions are already within limits — only then compute
    // the original base64 (avoids wasting CPU on large images that will
    // be resized anyway).
    if (!always_reencode && w <= max_width && h <= max_height) {
        std::string orig_b64 = b64_encode(
            reinterpret_cast<const unsigned char *>(raw.data()), raw.size());
        if (orig_b64.size() <= max_bytes) {
            return {std::move(orig_b64), mime, w, h, w, h, false,
                    ImageResizeStatus::Ok};
        }
    }

    int orig_w = w, orig_h = h;

    // Calculate initial target dimensions.
    int tw = w, th = h;
    if (tw > max_width) {
        th = static_cast<int>(std::round(static_cast<double>(th) * max_width / tw));
        tw = max_width;
    }
    if (th > max_height) {
        tw = static_cast<int>(std::round(static_cast<double>(tw) * max_height / th));
        th = max_height;
    }

    // Try encoding at target dimensions, halving the size whenever nothing
    // fits the budget.  Transparent pixels force PNG; opaque images keep the
    // JPEG quality ladder.  Sixteen halvings always reach 1×1, where every
    // encoder fits.
    const AlphaMode alpha = classify_alpha(pixels, w, h, channels);
    const stbir_pixel_layout layout = pixel_layout_for(channels);

    for (int attempt = 0; attempt < 16 && tw > 0 && th > 0; ++attempt) {
        // Resize pixels.  A null return means the resizer could not allocate
        // its working buffers; encoding the untouched (zero-filled) vector
        // would produce a black image.
        std::vector<unsigned char> resized(
            static_cast<size_t>(tw) * static_cast<size_t>(th) *
            static_cast<size_t>(channels));
        if (!stbir_resize_uint8_linear(pixels, w, h, w * channels,
                                       resized.data(), tw, th, tw * channels,
                                       layout))
            break;

        Candidate chosen;
        if (encode_fitting(resized.data(), tw, th, channels, alpha, max_bytes,
                           chosen)) {
            ResizedImage out;
            out.data = b64_encode(
                reinterpret_cast<const unsigned char *>(chosen.bytes.data()),
                chosen.bytes.size());
            out.mime_type      = std::move(chosen.mime);
            out.width          = tw;
            out.height         = th;
            out.original_width = orig_w;
            out.original_height = orig_h;
            out.was_resized    = tw != orig_w || th != orig_h;
            out.status         = ImageResizeStatus::Ok;
            return out;
        }

        // Reduce dimensions by 50%.
        tw /= 2;
        th /= 2;
    }

    // All attempts failed — the image decoded but cannot fit the budget.
    return ResizedImage{"", "", 0, 0, orig_w, orig_h, true,
                        ImageResizeStatus::TooLarge};
}

}  // namespace boxsh
