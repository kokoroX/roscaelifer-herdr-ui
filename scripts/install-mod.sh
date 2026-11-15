#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MOD_SRC="${UI_ROOT}/mods/roscaelifer-queue"
HERDR_HOME="${HERDR_APP_HOME:-${HOME}/.config/herdr-app}"
MOD_DST="${HERDR_HOME}/mods/roscaelifer-queue"

mkdir -p "${HERDR_HOME}/mods"

if [ -L "${MOD_DST}" ]; then
  rm -f "${MOD_DST}"
elif [ -e "${MOD_DST}" ]; then
  echo "Refusing to overwrite existing non-symlink at ${MOD_DST}; remove or move it first." >&2
  exit 1
fi

ln -s "${MOD_SRC}" "${MOD_DST}"
echo "Linked ${MOD_DST} -> ${MOD_SRC}"

if [ "${1:-}" = "--with-layout" ] && [ -f "${UI_ROOT}/layouts/roscaelifer.json" ]; then
  mkdir -p "${HERDR_HOME}/layouts"
  LAYOUT_DST="${HERDR_HOME}/layouts/roscaelifer.json"
  if [ -L "${LAYOUT_DST}" ]; then
    rm -f "${LAYOUT_DST}"
  fi
  if [ ! -e "${LAYOUT_DST}" ]; then
    ln -s "${UI_ROOT}/layouts/roscaelifer.json" "${LAYOUT_DST}"
    echo "Linked ${LAYOUT_DST} -> ${UI_ROOT}/layouts/roscaelifer.json"
  else
    echo "Skipping layout symlink (${LAYOUT_DST} exists and is not a symlink)." >&2
  fi
fi
