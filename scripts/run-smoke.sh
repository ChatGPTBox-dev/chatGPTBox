#!/bin/sh
# Compatibility entry point; Node owns resources and the exit status.
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 2
exec node "$script_dir/xvfb-smoke.mjs" "$@"
