#!/usr/bin/env bash
set -euo pipefail

REPO="${AGENT_PLUGINS_REPO:-jaon13/agent-plugins}"
STAGE_DIR="${AGENT_PLUGINS_HOME:-$HOME/.agents/agent-plugins}"
WITH_CODE_XRAY="${WITH_CODE_XRAY:-0}"
INIT_CONFIG="${AGENT_PLUGINS_INIT_CONFIG:-0}"

for arg in "$@"; do
  case "$arg" in
    --with-code-xray) WITH_CODE_XRAY=1 ;;
    --init-config) INIT_CONFIG=1 ;;
    *) ;;
  esac
done

PY_BIN="$(command -v python3 || command -v python || true)"
if [[ -z "$PY_BIN" ]]; then
  echo "Error: Python 3.10+ is required." >&2
  exit 1
fi

mkdir -p "$(dirname "$STAGE_DIR")"

if command -v git >/dev/null 2>&1; then
  if [[ -d "$STAGE_DIR/.git" ]]; then
    echo "[agent-plugins] Updating $STAGE_DIR ..."
    git -C "$STAGE_DIR" pull --ff-only
  else
    rm -rf "$STAGE_DIR"
    echo "[agent-plugins] Cloning https://github.com/$REPO.git -> $STAGE_DIR ..."
    git clone --depth 1 "https://github.com/$REPO.git" "$STAGE_DIR"
  fi
else
  TMP_ZIP="$(mktemp /tmp/agent-plugins-XXXXXX.zip)"
  TMP_DIR="$(mktemp -d /tmp/agent-plugins-XXXXXX)"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.zip" -o "$TMP_ZIP"
  unzip -qo "$TMP_ZIP" -d "$TMP_DIR"
  mkdir -p "$STAGE_DIR"
  cp -R "$TMP_DIR"/*/* "$STAGE_DIR/"
  rm -rf "$TMP_ZIP" "$TMP_DIR"
fi

INSTALL_ARGS=("$STAGE_DIR/scripts/install_plugins.py" "--enable")
if [[ "$INIT_CONFIG" == "1" ]]; then
  INSTALL_ARGS+=("--init-config")
fi
"$PY_BIN" "${INSTALL_ARGS[@]}"

if [[ "$WITH_CODE_XRAY" == "1" ]]; then
  echo "[agent-plugins] Installing companion CodeXray ..."
  curl -fsSL https://raw.githubusercontent.com/jaon13/code-xray/main/install.sh | bash
fi
