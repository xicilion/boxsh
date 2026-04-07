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
# libedit (built from vendored source via autotools)
# ---------------------------------------------------------------------------
include(ExternalProject)

set(LIBEDIT_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/libedit-20230828-3.1)
set(LIBEDIT_PREFIX  ${CMAKE_CURRENT_BINARY_DIR}/libedit-prefix)

ExternalProject_Add(libedit_ext
    SOURCE_DIR      ${LIBEDIT_SRC_DIR}
    BINARY_DIR      ${CMAKE_CURRENT_BINARY_DIR}/libedit-build
    PREFIX          ${LIBEDIT_PREFIX}
    CONFIGURE_COMMAND
        ${LIBEDIT_SRC_DIR}/configure
            --prefix=${LIBEDIT_PREFIX}
            --enable-static
            --disable-shared
            --with-pic
    BUILD_COMMAND   $(MAKE)
    INSTALL_COMMAND $(MAKE) install
    BUILD_BYPRODUCTS ${LIBEDIT_PREFIX}/lib/libedit.a
)

# Pre-create the install include dir so CMake accepts it as an INTERFACE path
file(MAKE_DIRECTORY ${LIBEDIT_PREFIX}/include)

add_library(libedit_vendored STATIC IMPORTED GLOBAL)
add_dependencies(libedit_vendored libedit_ext)
set_target_properties(libedit_vendored PROPERTIES
    IMPORTED_LOCATION             ${LIBEDIT_PREFIX}/lib/libedit.a
    INTERFACE_INCLUDE_DIRECTORIES ${LIBEDIT_PREFIX}/include
)

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
        ${LIBEDIT_SRC_DIR}/src
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
        libedit_vendored
        tinfo
        pthread
)

# ---------------------------------------------------------------------------
# Copy binary to SDK after build
# ---------------------------------------------------------------------------
set(SDK_EXEC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/sdk/js/src/exec)
add_custom_command(TARGET boxsh POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory ${SDK_EXEC_DIR}
    COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_FILE:boxsh> ${SDK_EXEC_DIR}/boxsh
    COMMENT "Copying boxsh to sdk/js/src/exec/"
)

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
install(TARGETS boxsh RUNTIME DESTINATION bin)
