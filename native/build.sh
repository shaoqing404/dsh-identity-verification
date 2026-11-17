#!/bin/sh
set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# A new task-local output directory prevents overwriting another build or installed app.
mkdir -p "$ROOT/.lab/m3/native"
BUILD_DIR=$(mktemp -d "$ROOT/.lab/m3/native/build.XXXXXXXX")
APP="$BUILD_DIR/DSH Touch ID.app"
mkdir -p "$APP/Contents/MacOS" "$BUILD_DIR/slices"
cp native/Info.plist "$APP/Contents/Info.plist"
SDK=$(xcrun --show-sdk-path)

for ARCH in arm64 x86_64; do
    xcrun swiftc -O -parse-as-library -sdk "$SDK" -target "$ARCH-apple-macosx13.0" \
        -framework AppKit -framework LocalAuthentication \
        native/Arguments.swift native/CompletionState.swift native/ErrorClassification.swift native/Response.swift \
        native/DSHTouchIDAuth.swift -o "$BUILD_DIR/slices/$ARCH"
done
lipo -create "$BUILD_DIR/slices/arm64" "$BUILD_DIR/slices/x86_64" \
    -output "$APP/Contents/MacOS/DSHTouchIDAuth"
rm "$BUILD_DIR/slices/arm64" "$BUILD_DIR/slices/x86_64"
rmdir "$BUILD_DIR/slices"
plutil -lint "$APP/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict --verbose=2 "$APP"
printf 'Built local ad-hoc signed helper: %s\n' "$APP/Contents/MacOS/DSHTouchIDAuth"
