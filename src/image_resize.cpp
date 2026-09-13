// Image resize using stb libraries (decode: stb + libwebp, encode: stb).
// Decodes image, resizes if needed, re-encodes as JPEG or PNG.

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
    out.channels  = (channels > 4) ? 4 : channels;  // stb may report >4 for HDR
    return true;
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

// stb_image_write callback: accumulate bytes into a std::string.
static void write_callback(void *ctx, void *data, int size) {
    auto *out = static_cast<std::string *>(ctx);
    out->append(static_cast<const char *>(data), static_cast<size_t>(size));
}

// Encode pixels as JPEG, return base64.
static std::string encode_jpeg(const unsigned char *pixels,
                               int w, int h, int channels, int quality) {
    std::string buf;
    stbi_write_jpg_to_func(write_callback, &buf, w, h, channels, pixels, quality);
    return b64_encode(reinterpret_cast<const unsigned char *>(buf.data()), buf.size());
}

// Encode pixels as PNG, return base64.
static std::string encode_png(const unsigned char *pixels,
                              int w, int h, int channels) {
    std::string buf;
    stbi_write_png_to_func(write_callback, &buf, w, h, channels, pixels, w * channels);
    return b64_encode(reinterpret_cast<const unsigned char *>(buf.data()), buf.size());
}

// Pick the smallest encoding from PNG and JPEG candidates.
struct Candidate {
    std::string data;
    std::string mime;
};

static Candidate best_encoding(const unsigned char *pixels,
                               int w, int h, int channels,
                               int jpeg_quality) {
    Candidate png_c = {encode_png(pixels, w, h, channels), "image/png"};
    Candidate jpg_c = {encode_jpeg(pixels, w, h, channels, jpeg_quality), "image/jpeg"};
    return (png_c.data.size() <= jpg_c.data.size()) ? std::move(png_c) : std::move(jpg_c);
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

    // Try encoding at target dimensions with decreasing JPEG quality.
    static const int jpeg_qualities[] = {80, 60, 40, 20};

    for (int attempt = 0; attempt < 8 && tw > 0 && th > 0; ++attempt) {
        // Resize pixels.
        std::vector<unsigned char> resized(tw * th * channels);
        stbir_resize_uint8_linear(
            pixels, w, h, w * channels,
            resized.data(), tw, th, tw * channels,
            static_cast<stbir_pixel_layout>(channels));

        // Try all JPEG qualities.
        for (int q : jpeg_qualities) {
            auto c = best_encoding(resized.data(), tw, th, channels, q);
            if (c.data.size() <= max_bytes) {
                return {std::move(c.data), std::move(c.mime),
                        tw, th, orig_w, orig_h,
                        tw != orig_w || th != orig_h, ImageResizeStatus::Ok};
            }
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
