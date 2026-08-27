#!/usr/bin/env bash
set -euo pipefail

BOTMUX_BIN="${BOTMUX_BIN:-botmux}"
DATA_DIR="${SESSION_DATA_DIR:-$HOME/.botmux/data}"
HOST="${BOTMUX_ANALYTICS_HOST:-127.0.0.1}"
PORT="${BOTMUX_ANALYTICS_PORT:-17870}"
DB="${BOTMUX_ANALYTICS_DB:-$DATA_DIR/botmux-conversations.sqlite}"

exec "$BOTMUX_BIN" analytics serve --host "$HOST" --port "$PORT" --db "$DB"
