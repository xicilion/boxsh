cmake_minimum_required(VERSION 3.16)
project(boxsh LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# Build type default
# ---------------------------------------------------------------------------
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "" FORCE)
endif()



# ---------------------------------------------------------------------------
# Dash static library
#
# We vendor dash 0.5.12 and compile it as a static library.  The generated
# source files (nodes.c, syntax.c, builtins.c, init.c, signames.c) were
# produced by running `make` once in third_party/dash-0.5.12/src/ and are
# committed alongside the hand-written sources.
#
# dash's main() is renamed to dash_main() via a compile-time define so that
# our own main() in main.cpp can call it for normal (non-RPC) mode.
# ---------------------------------------------------------------------------

set(DASH_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/dash-0.5.12/src)
set(DASH_ROOT    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/dash-0.5.12)

set(DASH_SOURCES
    ${DASH_SRC_DIR}/alias.c
    ${DASH_SRC_DIR}/arith_yacc.c
    ${DASH_SRC_DIR}/arith_yylex.c
    ${DASH_SRC_DIR}/cd.c
    ${DASH_SRC_DIR}/error.c
    ${DASH_SRC_DIR}/eval.c
    ${DASH_SRC_DIR}/exec.c
    ${DASH_SRC_DIR}/expand.c
    ${DASH_SRC_DIR}/histedit.c
    ${DASH_SRC_DIR}/input.c
    ${DASH_SRC_DIR}/jobs.c
    ${DASH_SRC_DIR}/mail.c
    ${DASH_SRC_DIR}/main.c
    ${DASH_SRC_DIR}/memalloc.c
    ${DASH_SRC_DIR}/miscbltin.c
    ${DASH_SRC_DIR}/mystring.c
    ${DASH_SRC_DIR}/options.c
    ${DASH_SRC_DIR}/output.c
    ${DASH_SRC_DIR}/parser.c
    ${DASH_SRC_DIR}/redir.c
    ${DASH_SRC_DIR}/show.c
    ${DASH_SRC_DIR}/system.c
    ${DASH_SRC_DIR}/trap.c
    ${DASH_SRC_DIR}/var.c
    ${DASH_SRC_DIR}/bltin/printf.c
    ${DASH_SRC_DIR}/bltin/test.c
    ${DASH_SRC_DIR}/bltin/times.c
    # Generated sources (pre-generated in-tree)
    ${DASH_SRC_DIR}/builtins.c
    ${DASH_SRC_DIR}/init.c
    ${DASH_SRC_DIR}/nodes.c
    ${DASH_SRC_DIR}/signames.c
    ${DASH_SRC_DIR}/syntax.c
)

add_library(dash_static STATIC ${DASH_SOURCES})

target_include_directories(dash_static
    PUBLIC
        ${DASH_SRC_DIR}
        ${DASH_ROOT}       # for config.h
)

target_compile_definitions(dash_static
    PRIVATE
        BSD=1
        SHELL
        # Rename dash's main() to dash_main() so it does not clash with ours.
        main=dash_main
)

target_compile_options(dash_static
    PRIVATE
        -Wall
        -Wno-unused-result
        # dash uses implicit fallthrough in some switch statements.
        -Wno-implicit-fallthrough
        # suppress sign-compare warnings from dash internals.
        -Wno-sign-compare
        # dash uses some GNU extensions.
        -D_GNU_SOURCE
        # dash's Makefile uses -include config.h; replicate that here.
        # On macOS, use config_darwin.h which overrides three incompatible defines.
        $<IF:$<BOOL:${APPLE}>,-include ${DASH_ROOT}/config_darwin.h,-include ${DASH_ROOT}/config.h>
)

# ---------------------------------------------------------------------------
# nlohmann/json (header-only, single-file)
# ---------------------------------------------------------------------------
add_library(nlohmann_json INTERFACE)
target_include_directories(nlohmann_json INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

# ---------------------------------------------------------------------------
# libedit (built from vendored source via autotools)
# ---------------------------------------------------------------------------
include(ExternalProject)

set(LIBEDIT_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/libedit-20230828-3.1)
set(LIBEDIT_BUILD_DIR ${CMAKE_BINARY_DIR}/libedit-build)
set(LIBEDIT_INSTALL_DIR ${CMAKE_BINARY_DIR}/libedit-prefix)

# Find the ncurses include directory (may be in a subdirectory like ncurses/)
find_path(NCURSES_INCLUDE_DIR ncurses.h PATH_SUFFIXES ncurses)
set(LIBEDIT_CFLAGS "${CMAKE_C_FLAGS}")
if(NCURSES_INCLUDE_DIR)
    set(LIBEDIT_CFLAGS "${LIBEDIT_CFLAGS} -I${NCURSES_INCLUDE_DIR}")
endif()

# Build the autotools --host flag and CFLAGS/LDFLAGS for libedit.
# On macOS cross-compile (e.g. x86_64 on arm64), pass -arch; on Linux
# cross-compile, CMAKE_C_COMPILER_TARGET is set by the toolchain.
set(LIBEDIT_HOST_FLAG "")
set(LIBEDIT_EXTRA_CFLAGS "")
set(LIBEDIT_EXTRA_LDFLAGS "")
if(CMAKE_C_COMPILER_TARGET)
    set(LIBEDIT_HOST_FLAG --host=${CMAKE_C_COMPILER_TARGET})
endif()
if(CMAKE_OSX_ARCHITECTURES)
    set(LIBEDIT_EXTRA_CFLAGS "-arch ${CMAKE_OSX_ARCHITECTURES}")
    set(LIBEDIT_EXTRA_LDFLAGS "-arch ${CMAKE_OSX_ARCHITECTURES}")
    if(CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64")
        set(LIBEDIT_HOST_FLAG --host=x86_64-apple-darwin)
    elseif(CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
        set(LIBEDIT_HOST_FLAG --host=aarch64-apple-darwin)
    endif()
endif()


# On macOS the SDK sysroot must be forwarded to the autotools build so that
# the linker can find libSystem and other system libraries.
set(LIBEDIT_SYSROOT_LDFLAGS "")
if(APPLE AND CMAKE_OSX_SYSROOT)
    set(LIBEDIT_SYSROOT_LDFLAGS "-isysroot ${CMAKE_OSX_SYSROOT}")
endif()

ExternalProject_Add(libedit_vendored
    SOURCE_DIR ${LIBEDIT_SRC_DIR}
    # Touch autotools-generated files so make does not try to regenerate
    # them (aclocal-1.16 etc. are not available on CI).
    PATCH_COMMAND
        find ${LIBEDIT_SRC_DIR} -name aclocal.m4 -exec touch {} + &&
        find ${LIBEDIT_SRC_DIR} -name configure -exec touch {} + &&
        find ${LIBEDIT_SRC_DIR} -name config.h.in -exec touch {} + &&
        find ${LIBEDIT_SRC_DIR} -name Makefile.in -exec touch {} +
    CONFIGURE_COMMAND ${LIBEDIT_SRC_DIR}/configure
        --prefix=${LIBEDIT_INSTALL_DIR}
        --enable-static --disable-shared
        ${LIBEDIT_HOST_FLAG}
        "CC=${CMAKE_C_COMPILER}"
        "CFLAGS=${CMAKE_C_FLAGS} ${LIBEDIT_EXTRA_CFLAGS} ${LIBEDIT_CFLAGS}"
        "LDFLAGS=${CMAKE_EXE_LINKER_FLAGS} ${LIBEDIT_EXTRA_LDFLAGS} ${LIBEDIT_SYSROOT_LDFLAGS}"
    BUILD_COMMAND make -j4
    INSTALL_COMMAND make install
    BUILD_IN_SOURCE 0
    BINARY_DIR ${LIBEDIT_BUILD_DIR}
    BUILD_BYPRODUCTS ${LIBEDIT_INSTALL_DIR}/lib/libedit.a
)

# ---------------------------------------------------------------------------
# boxsh executable
# ---------------------------------------------------------------------------

add_executable(boxsh
    src/main.cpp
    src/rpc.cpp
    src/worker_pool.cpp
)

# Platform-specific sandbox implementation.
if(APPLE)
    target_sources(boxsh PRIVATE src/sandbox_darwin.cpp)
else()
    target_sources(boxsh PRIVATE src/sandbox.cpp)
endif()

target_include_directories(boxsh
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${DASH_SRC_DIR}
        ${DASH_ROOT}
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party
        ${LIBEDIT_INSTALL_DIR}/include
)

target_compile_definitions(boxsh
    PRIVATE
        _GNU_SOURCE
)

target_compile_options(boxsh
    PRIVATE
        -Wall
        -Wextra
        -Wno-unused-parameter
)

target_link_libraries(boxsh
    PRIVATE
        dash_static
        nlohmann_json
        ${LIBEDIT_INSTALL_DIR}/lib/libedit.a
        ncurses
        pthread
)

add_dependencies(boxsh libedit_vendored)


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
install(TARGETS boxsh RUNTIME DESTINATION bin)
