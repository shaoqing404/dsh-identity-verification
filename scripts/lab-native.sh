#!/bin/sh
set -eu
umask 077

root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
lab="$root/.lab"
native="$lab/native-rc3"
electron="$lab/20261117/electron/unpacked/Electron.app/Contents/MacOS/Electron"
official="$lab/desktop/0.2.2-rc.3/DeepSeek Harness.app/Contents/Resources"
temporary=$(cat "$native/temp-root.txt")
case "$temporary" in /private/tmp/dshti.*) ;; *) exit 1 ;; esac
if [ -L "$temporary" ] || [ ! -d "$temporary" ]; then exit 1; fi
if [ -L "$lab" ] || [ ! -x "$electron" ] || [ ! -f "$native/shell/lab-main.mjs" ]; then
    printf '%s\n' 'Native lab files have not been prepared.' >&2
    exit 1
fi
for directory in "$native" "$native/state" "$native/workspace" "$native/shell"; do
    if [ "$(CDPATH= cd -P "$directory" && pwd)" != "$directory" ]; then
        printf '%s\n' 'An experiment directory has been redirected.' >&2
        exit 1
    fi
done
for directory in home dsh agents tmp zdot xdg-config xdg-cache xdg-data; do
    target="$native/state/$directory"
    if [ -L "$target" ]; then exit 1; fi
    mkdir -p "$target"
done
cd "$native/workspace"
exec /usr/bin/env -i \
    "PATH=$lab/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "HOME=$native/state/home" "ZDOTDIR=$native/state/zdot" "TMPDIR=$temporary/" "MAC_CHROMIUM_TMPDIR=$temporary" \
    "DSH_HOME=$native/state/dsh" "DSH_AGENTS_HOME=$native/state/agents" \
    "XDG_CONFIG_HOME=$native/state/xdg-config" "XDG_CACHE_HOME=$native/state/xdg-cache" \
    "XDG_DATA_HOME=$native/state/xdg-data" \
    "DSH_TOUCH_ID_LAB=$lab" "DSH_DESKTOP_DSH_DIR=$native/shell/dsh" \
    "DSH_DESKTOP_PRIMARY_RUNTIME_DIR=$official/runtime/primary-runtime" \
    "DSH_DESKTOP_PNPM_ENTRY=$official/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
    "DSH_DESKTOP_OPEN_DEVTOOLS=0" "DSH_DESKTOP_DIAGNOSTIC_FILE=$native/startup-error.log" \
    "$electron" "$native/shell" --user-data-dir="$native/state/electron"
