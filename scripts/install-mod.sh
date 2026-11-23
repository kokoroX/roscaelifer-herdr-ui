#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MOD_SRC="${UI_ROOT}/mods/roscaelifer-queue"
LAYOUT_SRC="${UI_ROOT}/layouts/roscaelifer.json"
HERDR_HOME="${HERDR_APP_HOME:-${HOME}/.config/herdr-app}"
MOD_DST="${HERDR_HOME}/mods/roscaelifer-queue"
LAYOUT_DST="${HERDR_HOME}/layouts/roscaelifer.json"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Install the roscaelifer-queue mod into \$HERDR_APP_HOME (default:
~/.config/herdr-app). The default mode copies the mod so the installed copy is
a stable, self-contained snapshot; use --symlink for local development.

Options:
  --copy           Copy the mod and layout (default)
  --symlink        Symlink the mod and layout from this checkout (dev mode)
  --with-layout    Also install layouts/roscaelifer.json
  --uninstall      Remove the installed mod (and layout when --with-layout)
  --force          Replace targets that do not look like previous installs
                   and overwrite a locally modified roscaelifer.json layout
  -h, --help       Show this help

Environment:
  HERDR_APP_HOME   Herdr config directory (default: ~/.config/herdr-app)
EOF
}

MODE="copy"
WITH_LAYOUT=0
UNINSTALL=0
FORCE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --copy) MODE="copy" ;;
    --symlink) MODE="symlink" ;;
    --with-layout) WITH_LAYOUT=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --force) FORCE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

is_previous_mod_install() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/mod.json" ]
}

remove_mod_target() {
  if [ -L "$MOD_DST" ]; then
    rm -f "$MOD_DST"
  elif [ -e "$MOD_DST" ]; then
    if is_previous_mod_install "$MOD_DST" || [ "$FORCE" = 1 ]; then
      rm -rf "$MOD_DST"
    else
      echo "Refusing to replace ${MOD_DST}: it is not a previous mod install (use --force)." >&2
      exit 1
    fi
  fi
}

install_mod() {
  mkdir -p "${HERDR_HOME}/mods"
  remove_mod_target
  if [ "$MODE" = "symlink" ]; then
    ln -s "${MOD_SRC}" "${MOD_DST}"
    echo "Linked ${MOD_DST} -> ${MOD_SRC}"
  else
    cp -R "${MOD_SRC}" "${MOD_DST}"
    echo "Copied ${MOD_SRC} -> ${MOD_DST}"
  fi
}

install_layout() {
  if [ ! -f "${LAYOUT_SRC}" ]; then
    echo "Skipping layout: ${LAYOUT_SRC} not found." >&2
    return 0
  fi

  mkdir -p "${HERDR_HOME}/layouts"
  if [ -L "${LAYOUT_DST}" ]; then
    rm -f "${LAYOUT_DST}"
  elif [ -f "${LAYOUT_DST}" ]; then
    if [ "${FORCE}" != 1 ] && ! cmp -s "${LAYOUT_SRC}" "${LAYOUT_DST}"; then
      echo "Skipping layout update: ${LAYOUT_DST} differs from the example layout (kept local edits, use --force to overwrite)." >&2
      return 0
    fi
    rm -f "${LAYOUT_DST}"
  fi

  if [ "$MODE" = "symlink" ]; then
    ln -s "${LAYOUT_SRC}" "${LAYOUT_DST}"
    echo "Linked ${LAYOUT_DST} -> ${LAYOUT_SRC}"
  else
    cp "${LAYOUT_SRC}" "${LAYOUT_DST}"
    echo "Copied ${LAYOUT_SRC} -> ${LAYOUT_DST}"
  fi
}

uninstall() {
  if [ -L "${MOD_DST}" ] || is_previous_mod_install "${MOD_DST}" || [ "$FORCE" = 1 ]; then
    rm -rf "${MOD_DST}"
    echo "Removed ${MOD_DST}"
  elif [ -e "${MOD_DST}" ]; then
    echo "Refusing to remove ${MOD_DST}: it is not a previous mod install (use --force)." >&2
    return 1
  else
    echo "Nothing to remove at ${MOD_DST}"
  fi

  if [ "${WITH_LAYOUT}" = 1 ]; then
    if [ -L "${LAYOUT_DST}" ] || { [ -f "${LAYOUT_DST}" ] && cmp -s "${LAYOUT_SRC}" "${LAYOUT_DST}"; } || [ "$FORCE" = 1 ]; then
      rm -f "${LAYOUT_DST}"
      echo "Removed ${LAYOUT_DST}"
    elif [ -f "${LAYOUT_DST}" ]; then
      echo "Skipping layout removal: ${LAYOUT_DST} has local edits (use --force to remove)." >&2
    else
      echo "Nothing to remove at ${LAYOUT_DST}"
    fi
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  uninstall
  exit 0
fi

install_mod
if [ "$WITH_LAYOUT" = 1 ]; then
  install_layout
fi
