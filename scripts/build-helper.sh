#!/usr/bin/env bash
# Builds the native Windows helper. Works on Windows (MSYS2 MinGW-w64),
# Linux or macOS (cross-compiling with mingw-w64: `brew install mingw-w64`,
# `apt install gcc-mingw-w64-x86-64`).
set -euo pipefail
cd "$(dirname "$0")/.."
CC="${CC:-x86_64-w64-mingw32-gcc}"
OUT=com.monxas.bridgesuits.sdPlugin/native/bridge-paste-helper.exe
mkdir -p "$(dirname "$OUT")"
"$CC" -std=c11 -O2 -Wall -Wextra -Werror -mwindows -static -s \
	-Wl,--no-insert-timestamp \
	-o "$OUT" native/bridge-paste-helper.c -luser32 -lkernel32 -ladvapi32 -lgdi32
echo "built $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
