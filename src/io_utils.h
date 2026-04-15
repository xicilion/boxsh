#pragma once

#include <cstddef>

namespace boxsh {

bool write_all(int fd, const void *buf, size_t len);
bool read_all(int fd, void *buf, size_t len);

} // namespace boxsh