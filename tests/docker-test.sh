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
# Security model: boxsh inside a container always runs the unprivileged userns
# engine (host-equivalent isolation).  Root containers have no isolation
# (rootful Docker: container root == host root), so boxsh refuses every sandbox
# request there — the runner validates that refusal in a ROOT container, and
# runs every functional suite in a --user container (host semantics).
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

# Privileges for boxsh inside Docker (no --cap-add SYS_ADMIN needed — the
# user namespace provides the mount capability inside the sandbox):
#   --security-opt seccomp=unconfined  allow unshare/mount syscalls
#   --security-opt apparmor=unconfined allow mount-propagation changes
#                                      (make-rslave / fails under the default
#                                       AppArmor profile)
#   --device /dev/fuse          fuse-overlayfs COW (overlay-on-overlay)
#
# All functional suites run in a --user 65534:65534 container (boxsh runs
# natively unprivileged, host-equivalent semantics).  One additional run in
# a ROOT container validates that every sandbox request is refused there.
PRIV="--security-opt seccomp=unconfined --security-opt apparmor=unconfined --device /dev/fuse"
PRIV_USER="--user 65534:65534 $PRIV"
# Negative-path privileges (--user, no /dev/fuse; apparmor=unconfined still
# needed so sandbox_apply reaches the COW step before failing).
PRIV_USER_NEG="--user 65534:65534 --security-opt seccomp=unconfined --security-opt apparmor=unconfined"

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

  # In bind mode /src/temp is gitignored (absent in a fresh checkout) and
  # owned by the host user; create it and make it writable for uid 65534
  # (all suites run as --user 65534).
  case "$mode" in
    bind)
      docker run --rm -v "$PROJECT_ROOT:/src" $IMAGE_TAG \
        sh -c 'mkdir -p /src/temp && chmod 1777 /src/temp'
      ;;
  esac

  echo ""
  echo "========== Root container rejection ($LABEL) =========="
  # A root sandbox has no isolation (rootful Docker: container root == host
  # root).  boxsh must refuse every sandbox request with an actionable error
  # before any namespace syscall — no privilege flags needed for this run.
  docker run --rm $VOL_OPTS $COMMON \
    sh -c 'node --test tests/docker-root-reject.test.mjs'

  echo ""
  echo "========== Container engine contract — --user container ($LABEL) =========="
  # boxsh runs as a natively unprivileged container user (no drop involved)
  # and uses the host-equivalent userns engine.
  docker run --rm $PRIV_USER $VOL_OPTS $COMMON \
    sh -c 'node --test tests/docker.test.mjs'

  echo ""
  echo "========== Full suite — --user container ($LABEL) =========="
  # Host-style suites run as a natively unprivileged container user, matching
  # host semantics.
  docker run --rm $PRIV_USER $VOL_OPTS $COMMON \
    sh -c 'node --test tests/index.test.mjs'

  echo ""
  echo "========== SDK suite — --user container ($LABEL) =========="
  docker run --rm $PRIV_USER $VOL_OPTS $COMMON \
    sh -c 'node --test sdk/js/test/all.test.mjs'

  echo ""
  echo "========== Negative path — --user container without /dev/fuse ($LABEL) =========="
  # A COW request must fail with an actionable /dev/fuse error (root
  # containers never get this far — they are rejected up front).
  docker run --rm $PRIV_USER_NEG $VOL_OPTS $COMMON \
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
