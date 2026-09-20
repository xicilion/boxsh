#pragma once

// ---------------------------------------------------------------------------
// Stable tool error codes.
//
// These strings are part of the tool result contract (README.md "Error model",
// enforced by tests/tool-contract.test.mjs): once a code ships, its spelling is
// fixed.  They live in their own header so that both the RPC layer and the
// subsystems that raise them (terminal.cpp, io_utils.cpp, …) can name them
// without pulling in nlohmann/json.
// ---------------------------------------------------------------------------

namespace boxsh {
namespace error_code {

inline constexpr const char *kInvalidArgument   = "E_INVALID_ARGUMENT";
inline constexpr const char *kNotFound          = "E_NOT_FOUND";
inline constexpr const char *kNotText           = "E_NOT_TEXT";
inline constexpr const char *kNotImage          = "E_NOT_IMAGE";
inline constexpr const char *kUnsupportedFormat = "E_UNSUPPORTED_FORMAT";
inline constexpr const char *kTooLarge          = "E_TOO_LARGE";
inline constexpr const char *kTimeout           = "E_TIMEOUT";
inline constexpr const char *kSandbox           = "E_SANDBOX";
inline constexpr const char *kInternal          = "E_INTERNAL";
inline constexpr const char *kTooManySessions   = "E_TOO_MANY_SESSIONS";

} // namespace error_code
} // namespace boxsh
