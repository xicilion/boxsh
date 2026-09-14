#ifndef BOXSH_IMAGE_RESIZE_H
#define BOXSH_IMAGE_RESIZE_H

#include <string>

namespace boxsh {

// Default inline-image budget: 4.5 MB of base64 payload.
inline constexpr size_t kMaxImageBase64Bytes = 4718592;

// Upper bound on the *declared* pixel count of an image.  Headers are checked
// before any pixel buffer is allocated, so a small file claiming huge
// dimensions ("decompression bomb") cannot push the process into OOM
// (contract §2.3).  100 MP is far beyond what a screenshot or diagram needs,
// and still allows downscaling to the 2000px budget.
inline constexpr long long kMaxImagePixels = 100LL * 1000 * 1000;

enum class ImageResizeStatus {
    Ok,            // data holds a usable base64 image
    DecodeFailed,  // the input could not be decoded (unsupported/corrupt)
    TooLarge,      // decoded fine but no encoding fits max_bytes
    TooManyPixels, // declared dimensions exceed kMaxImagePixels (not decoded)
};

struct ResizedImage {
    std::string data;       // base64-encoded image data (empty unless status == Ok)
    std::string mime_type;  // output MIME type (may differ from input if re-encoded)
    int width = 0;
    int height = 0;
    int original_width = 0;
    int original_height = 0;
    bool was_resized = false;
    ImageResizeStatus status = ImageResizeStatus::DecodeFailed;
    // Header-declared dimensions of the source; set for TooManyPixels so the
    // caller can report {pixels, limit} without re-parsing the header.
    long long declared_pixels = 0;
    long long pixel_limit = 0;
};

// Resize an image to fit within max dimensions and base64 size limit.
// Returns status == DecodeFailed on unsupported/corrupt input and
// status == TooLarge when no encoding fits max_bytes.
//
// Strategy (following pi's approach):
//   1. If already within limits and !always_reencode → return base64 of original
//   2. Resize to maxWidth×maxHeight
//   3. Try both PNG and JPEG, pick smaller
//   4. If still over maxBytes, reduce JPEG quality
//   5. If still over, reduce dimensions progressively
//
// raw: raw file bytes (not base64)
// mime: detected MIME type of the input
// always_reencode: skip the "return the original bytes" fast path — used for
//                  animated sources (contract §2.3) and for formats outside
//                  the model-native set (jpeg/png/gif/webp): BMP, TIFF, … are
//                  converted to PNG/JPEG so multimodal models can ingest them.
ResizedImage resize_image(const std::string &raw, const std::string &mime,
                          int max_width = 2000, int max_height = 2000,
                          size_t max_bytes = kMaxImageBase64Bytes,
                          bool always_reencode = false);

}  // namespace boxsh

#endif  // BOXSH_IMAGE_RESIZE_H
