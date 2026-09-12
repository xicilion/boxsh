#!/bin/sh
# boxsh installer — download the latest release binary for your platform.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xicilion/boxsh/master/install.sh | sh
#
# Options (via environment variables):
#   BOXSH_VERSION   — specific version tag (default: latest)
#   BOXSH_INSTALL   — installation directory (default: /usr/local/bin)

set -e

REPO="xicilion/boxsh"
INSTALL_DIR="${BOXSH_INSTALL:-/usr/local/bin}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Linux)  OS_TAG="linux" ;;
    Darwin) OS_TAG="darwin" ;;
    *)      echo "Error: unsupported OS: $OS" >&2; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64)   ARCH_TAG="x64" ;;
    i686|i386)       ARCH_TAG="ia32" ;;
    aarch64|arm64)   ARCH_TAG="arm64" ;;
    armv7l|armhf)    ARCH_TAG="arm" ;;
    mips64*)         ARCH_TAG="mips64" ;;
    ppc64le)         ARCH_TAG="ppc64" ;;
    riscv64)         ARCH_TAG="riscv64" ;;
    loongarch64)     ARCH_TAG="loong64" ;;
    *)               echo "Error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# macOS uses different arch tags in uname vs release
if [ "$OS_TAG" = "darwin" ] && [ "$ARCH_TAG" = "x64" ]; then
    ARCH_TAG="x86_64"
fi

# Resolve version
if [ -z "$BOXSH_VERSION" ]; then
    BOXSH_VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')"
    if [ -z "$BOXSH_VERSION" ]; then
        echo "Error: failed to determine latest version" >&2
        exit 1
    fi
fi

FILENAME="boxsh-${BOXSH_VERSION}-${OS_TAG}-${ARCH_TAG}"
URL="https://github.com/${REPO}/releases/download/${BOXSH_VERSION}/${FILENAME}"

echo "Installing boxsh ${BOXSH_VERSION} (${OS_TAG}/${ARCH_TAG})..."
echo "  from: ${URL}"
echo "  to:   ${INSTALL_DIR}/boxsh"

# Download
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if ! curl -fSL -o "$TMP" "$URL"; then
    echo "Error: download failed. Check that the version and architecture are correct." >&2
    exit 1
fi
# 必须是 0755（而不是 `chmod +x`）：mktemp 创建的文件是 0600，`chmod +x` 只会得到
# 0711（组/其他无读权限）。以非 root 用户执行「自己不可读」的二进制会被内核置为
# non-dumpable，进而 /proc/self/setgroups 写入返回 EPERM —— 容器里以 `--user`
# 运行时 boxsh 的一切 sandbox 请求都会失败：
#   sandbox_apply failed: write setgroups deny: Permission denied
chmod 0755 "$TMP"

resign_if_macos() {
    target="$1"
    if [ "$OS_TAG" != "darwin" ]; then
        return 0
    fi
    if ! command -v codesign >/dev/null 2>&1; then
        echo "Warning: codesign not found; installed binary may be rejected by macOS until re-signed manually." >&2
        return 0
    fi
    if ! codesign -f -s - "$target" >/dev/null 2>&1; then
        echo "Warning: failed to ad-hoc sign $target; macOS may refuse to launch it." >&2
        return 0
    fi
}

# Install
if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP" "${INSTALL_DIR}/boxsh"
    resign_if_macos "${INSTALL_DIR}/boxsh"
else
    echo "  (need sudo to write to ${INSTALL_DIR})"
    sudo mv "$TMP" "${INSTALL_DIR}/boxsh"
    if [ "$OS_TAG" = "darwin" ]; then
        sudo codesign -f -s - "${INSTALL_DIR}/boxsh" >/dev/null 2>&1 || \
            echo "Warning: failed to ad-hoc sign ${INSTALL_DIR}/boxsh; macOS may refuse to launch it." >&2
    fi
fi

echo "Done! Run 'boxsh --help' to get started."
