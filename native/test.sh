#!/bin/sh
set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
    printf 'Usage: sh native/test.sh /absolute/path/to/DSHTouchIDAuth\n' >&2
    exit 2
fi
BINARY=$1
mkdir -p "$ROOT/.lab/m3/native"
TEST_DIR=$(mktemp -d "$ROOT/.lab/m3/native/tests.XXXXXXXX")
trap 'rm -f "$TEST_DIR/native-tests"; rmdir "$TEST_DIR"' EXIT HUP INT TERM

xcrun swiftc -parse-as-library -framework LocalAuthentication \
    native/Arguments.swift native/CompletionState.swift native/ErrorClassification.swift native/Response.swift \
    native/tests/NativeTests.swift -o "$TEST_DIR/native-tests"
"$TEST_DIR/native-tests"
node native/tests/check.test.mjs "$BINARY"
lipo "$BINARY" -verify_arch arm64
lipo "$BINARY" -verify_arch x86_64
APP=$(dirname "$(dirname "$(dirname "$BINARY")")")
codesign --verify --strict "$APP"
SIGNATURE=$(codesign -dv --verbose=2 "$APP" 2>&1)
case "$SIGNATURE" in
    *"Signature=adhoc"*) ;;
    *) printf 'Expected an ad-hoc signed local experiment bundle.\n' >&2; exit 1 ;;
esac
printf 'Universal architecture and ad-hoc bundle signature verified.\n'
