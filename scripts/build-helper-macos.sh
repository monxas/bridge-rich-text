#!/usr/bin/env bash
# Builds the macOS helper as a universal (arm64 + x86_64) binary. Needs Xcode
# or the Command Line Tools (swiftc). Must run on macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=com.monxas.bridgesuits.sdPlugin/native/bridge-paste-helper-macos
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for arch in arm64 x86_64; do
	swiftc -O -target "$arch-apple-macos12" -o "$TMP/$arch" native/macos/BridgePasteHelper.swift
done
lipo -create -output "$OUT" "$TMP/arm64" "$TMP/x86_64"
codesign --force --sign - --identifier com.monxas.bridgesuits.helper "$OUT"
echo "built $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes, $(lipo -archs "$OUT"))"
