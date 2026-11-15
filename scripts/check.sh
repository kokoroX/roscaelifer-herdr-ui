#!/usr/bin/env bash
set -euo pipefail

HERDR_HOME="${HERDR_APP_HOME:-${HOME}/.config/herdr-app}"
MOD_PATH="${1:-${HERDR_HOME}/mods/roscaelifer-queue}"

exec herdr-app check "${MOD_PATH}"
