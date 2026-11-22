#!/usr/bin/env sh
set -eu
exec node "$(dirname "$0")/scripts/pi-mnemonic-install.mjs" --uninstall "$@"
