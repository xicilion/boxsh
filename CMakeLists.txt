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
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/libedit/include
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
        -include ${DASH_ROOT}/config.h
)

# ---------------------------------------------------------------------------
# nlohmann/json (header-only, single-file)
# ---------------------------------------------------------------------------
add_library(nlohmann_json INTERFACE)
target_include_directories(nlohmann_json INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

# ---------------------------------------------------------------------------
# boxsh executable
# ---------------------------------------------------------------------------

add_executable(boxsh
    src/main.cpp
    src/rpc.cpp
    src/sandbox.cpp
    src/worker_pool.cpp
)

target_include_directories(boxsh
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${DASH_SRC_DIR}
        ${DASH_ROOT}
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party
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
        -L${CMAKE_CURRENT_SOURCE_DIR}/third_party/libedit
        edit
        tinfo
        pthread
)

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
install(TARGETS boxsh RUNTIME DESTINATION bin)
