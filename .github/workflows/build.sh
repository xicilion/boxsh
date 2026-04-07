#!/bin/bash
set -ev

HOST_OS=$(uname)

get_target_triple() {
    case "$1" in
        x64)     echo "x86_64-linux-gnu" ;;
        ia32)    echo "i686-linux-gnu" ;;
        arm64)   echo "aarch64-linux-gnu" ;;
        arm)     echo "arm-linux-gnueabihf" ;;
        mips64)  echo "mips64el-linux-gnuabi64" ;;
        ppc64)   echo "powerpc64le-linux-gnu" ;;
        riscv64) echo "riscv64-linux-gnu" ;;
        *)       echo "unknown" ;;
    esac
}

if [[ "${HOST_OS}" == "Linux" ]]; then
    CUR=$(pwd)
    BUILD_DIR="build"
    TARGET=$(get_target_triple ${BUILD_ARCH})

    if [[ "${BUILD_ARCH}" == "x64" ]]; then
        # Native build
        docker run -t --rm -v ${CUR}:${CUR} fibjs/linux-build-env:x64 \
            bash -c "cd ${CUR} && \
                cmake -B ${BUILD_DIR} \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DCMAKE_C_COMPILER=clang-18 \
                    -DCMAKE_CXX_COMPILER=clang++-18 && \
                cmake --build ${BUILD_DIR} --parallel 2"
    elif [[ "${BUILD_ARCH}" == "loong64" || "${BUILD_ARCH}" == "loong64ow" ]]; then
        # LoongArch uses its own GCC cross-toolchain (no clang support)
        docker run -t --rm -v ${CUR}:${CUR} fibjs/linux-build-env:${BUILD_ARCH} \
            bash -c "cd ${CUR} && \
                cmake -B ${BUILD_DIR} \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DCMAKE_SYSTEM_NAME=Linux \
                    -DCMAKE_C_COMPILER_TARGET=loongarch64-unknown-linux-gnu \
                    -DCMAKE_FIND_ROOT_PATH=/usr/cross-tools/target && \
                cmake --build ${BUILD_DIR} --parallel 2"
    else
        # Cross-compilation via clang --target
        docker run -t --rm -v ${CUR}:${CUR} fibjs/linux-build-env:${BUILD_ARCH} \
            bash -c "cd ${CUR} && \
                GCC_VER=\$(gcc -dumpversion) && \
                cmake -B ${BUILD_DIR} \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DCMAKE_SYSTEM_NAME=Linux \
                    -DCMAKE_C_COMPILER=clang-18 \
                    -DCMAKE_CXX_COMPILER=clang++-18 \
                    -DCMAKE_C_FLAGS=\"--target=${TARGET} -I/usr/${TARGET}/include -I/usr/${TARGET}/include/c++/\${GCC_VER}/${TARGET}\" \
                    -DCMAKE_CXX_FLAGS=\"--target=${TARGET} -I/usr/${TARGET}/include -I/usr/${TARGET}/include/c++/\${GCC_VER}/${TARGET}\" \
                    -DCMAKE_EXE_LINKER_FLAGS=\"--target=${TARGET} -L/usr/${TARGET}/lib\" \
                    -DCMAKE_FIND_ROOT_PATH=/usr/${TARGET} && \
                cmake --build ${BUILD_DIR} --parallel 2"
    fi

    echo "=== Verify ==="
    file ${BUILD_DIR}/boxsh
elif [[ "${HOST_OS}" == "Darwin" ]]; then
    BUILD_DIR="build"
    CMAKE_EXTRA=""
    if [[ "${BUILD_ARCH}" == "x86_64" ]]; then
        CMAKE_EXTRA="-DCMAKE_OSX_ARCHITECTURES=x86_64"
    fi
    cmake -B ${BUILD_DIR} -DCMAKE_BUILD_TYPE=Release ${CMAKE_EXTRA}
    cmake --build ${BUILD_DIR} --parallel $(sysctl -n hw.logicalcpu)
fi

# Package release
if [[ "${BUILD_TAG}" != "" ]]; then
    mkdir -p release
    cp ${BUILD_DIR}/boxsh release/boxsh-${BUILD_TAG}-linux-${BUILD_ARCH}
fi
