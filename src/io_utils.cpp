#include "io_utils.h"

#include <cerrno>

#include <unistd.h>

namespace boxsh {

bool write_all(int fd, const void *buf, size_t len) {
    const char *ptr = static_cast<const char *>(buf);
    size_t written = 0;
    while (written < len) {
        ssize_t n = write(fd, ptr + written, len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;
        written += (size_t)n;
    }
    return true;
}

bool read_all(int fd, void *buf, size_t len) {
    char *ptr = static_cast<char *>(buf);
    size_t received = 0;
    while (received < len) {
        ssize_t n = read(fd, ptr + received, len - received);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;
        received += (size_t)n;
    }
    return true;
}

} // namespace boxsh