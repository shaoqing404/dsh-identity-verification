#!/bin/sh
set -eu
umask 077

root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
lab="$root/.lab"
node="$lab/bin/node"
cli="$lab/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"

if [ -L "$lab" ] || [ ! -x "$node" ] || [ ! -f "$cli" ]; then
    printf '%s\n' '请先按隔离手册准备项目内 .lab 和固定版本的运行时。' >&2
    exit 1
fi

for directory in home dsh agents tmp workspace xdg-config xdg-cache xdg-data; do
    target="$lab/$directory"
    if [ -L "$target" ]; then
        printf '%s\n' "实验目录不能是符号链接：$target" >&2
        exit 1
    fi
    mkdir -p "$target"
done

cd "$lab/workspace"
exec /usr/bin/sandbox-exec -D "LAB=$lab" -p '
    (version 1)
    (allow default)
    (deny file-read-data (subpath "/Users"))
    (allow file-read-data (subpath (param "LAB")))
    (deny file-write*)
    (allow file-write* (subpath (param "LAB")) (literal "/dev/null"))
    (deny network-inbound)
    (allow network-inbound (local ip "localhost:38483"))
    (deny network-outbound)
' /usr/bin/env -i \
    "PATH=$lab/bin:/usr/bin:/bin:/usr/sbin:/sbin" "HOME=$lab/home" "TMPDIR=$lab/tmp" \
    "DSH_HOME=$lab/dsh" "DSH_AGENTS_HOME=$lab/agents" \
    "XDG_CONFIG_HOME=$lab/xdg-config" "XDG_CACHE_HOME=$lab/xdg-cache" "XDG_DATA_HOME=$lab/xdg-data" \
    "$node" "$cli" --profile web --host 127.0.0.1 --port 38483 --no-open
