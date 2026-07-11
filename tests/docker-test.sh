#!/bin/sh
# tests/docker-test.sh — run the boxsh test suite inside Docker, reusing the
# host-compiled binary.  Single entry point for local dev and CI (the
# docker-test job in .github/workflows/ci.yml).
#
# Design: boxsh is built ONCE on the host/runner and the resulting binary is
# mounted into the container.  The container only provides node + fuse-overlayfs
# (see tests/Dockerfile).  This keeps a single binary for host and container,
# avoids a redundant in-container rebuild, and side-steps the CMakeCache path
# mismatch that an in-container build would cause.
#
# Two volume modes are tested to verify both host-mapped and ephemeral storage:
#   1. bind-mount  (–vol=bind):  project is mounted read-write, temp/ lives on
#      the host filesystem (fast, no size limit, leaves root-owned stragglers).
#   2. tmpfs       (–vol=tmpfs): project is mounted read-only, temp/ is an
#      in-memory tmpfs (isolated, self-cleaning, verifies boxsh works on
#      non-persistent storage inside the container).
#
# Usage:
#   bash tests/docker-test.sh              # run both modes (default)
#   bash tests/docker-test.sh --vol=bind   # bind-mount only
#   bash tests/docker-test.sh --vol=tmpfs  # tmpfs only

set -e

VOL_MODE="${1:-both}"
case "$VOL_MODE" in
  --vol=bind)  VOL_MODE="bind" ;;
  --vol=tmpfs) VOL_MODE="tmpfs" ;;
  both|bind|tmpfs) ;;
  *) echo "Usage: $0 [--vol=bind|--vol=tmpfs]" >&2; exit 1 ;;
esac

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
BINARY="$PROJECT_ROOT/build/boxsh"

# --- 1. Ensure the host binary exists --------------------------------------

if [ ! -x "$BINARY" ]; then
    echo "==> Building boxsh on the host (build/boxsh not found)"
    cmake -B "$PROJECT_ROOT/build" -S "$PROJECT_ROOT" -DCMAKE_BUILD_TYPE=Debug
    cmake --build "$PROJECT_ROOT/build" --parallel "$(nproc)"
fi
echo "==> Using binary: $BINARY"

# --- 2. Build the test image (cached after first run) ----------------------

IMAGE_TAG="boxsh-test"
echo "==> Building test image: $IMAGE_TAG"
docker build -t "$IMAGE_TAG" -f "$SCRIPT_DIR/Dockerfile" "$PROJECT_ROOT"

# Privilege flags required for boxsh's container sandbox engine.
#   --cap-add SYS_ADMIN               mount/pivot_root/unshare(CLONE_NEWNS)
#   --security-opt seccomp=unconfined  allow unshare/mount syscalls
#   --security-opt apparmor=unconfined allow mount-propagation changes
#                                      (make-rslave / fails under the default
#                                       AppArmor profile even with SYS_ADMIN)
#   --device /dev/fuse                fuse-overlayfs COW (overlay-on-overlay)
PRIV_FULL="--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined --device /dev/fuse"
# Negative-path privileges (no /dev/fuse, but apparmor=unconfined still needed
# so sandbox_apply reaches the COW step before failing).
PRIV_NEG="--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined"

# ---------------------------------------------------------------------------
# run_suites <vol_mode>
#
#   vol_mode: "bind" or "tmpfs"
#     bind  — project mounted read-write, temp/ on host filesystem
#     tmpfs — project mounted read-only, temp/ is an in-memory tmpfs
# ---------------------------------------------------------------------------
run_suites() {
  local mode="$1"

  case "$mode" in
    bind)
      local VOL_OPTS="-v $PROJECT_ROOT:/src"
      local LABEL="bind-mount"
      ;;
    tmpfs)
      local VOL_OPTS="-v $PROJECT_ROOT:/src:ro --tmpfs /src/temp:rw,size=512m"
      local LABEL="tmpfs"
      ;;
  esac

  local COMMON="-w /src -e BOXSH=/src/build/boxsh $IMAGE_TAG"

  echo ""
  echo "========== Full suite ($LABEL) =========="
  docker run --rm $PRIV_FULL $VOL_OPTS $COMMON \
    sh -c 'node --test tests/index.test.mjs'

  echo ""
  echo "========== SDK suite ($LABEL) =========="
  docker run --rm $PRIV_FULL $VOL_OPTS $COMMON \
    sh -c 'node --test sdk/js/test/all.test.mjs'

  echo ""
  echo "========== Negative path ($LABEL) =========="
  docker run --rm $PRIV_NEG $VOL_OPTS $COMMON \
    sh -c 'BOXSH=/src/build/boxsh node --test tests/docker-negative.test.mjs'
}

# --- Run -------------------------------------------------------------------

if [ "$VOL_MODE" = "both" ]; then
  run_suites "bind"
  run_suites "tmpfs"
else
  run_suites "$VOL_MODE"
fi

echo ""
echo "==> All Docker tests passed ($VOL_MODE)."
