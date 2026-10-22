#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="$(cd -- "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${BOTMUX_LOGISTICS_ANALYSIS_NODE:-node}"
: "${BOTMUX_LOGISTICS_ANALYSIS_DB:?set BOTMUX_LOGISTICS_ANALYSIS_DB to the dedicated four-table database}"
if [[ ! -f "$WORKTREE/dist/cli.js" ]]; then
  echo "missing built CLI: $WORKTREE/dist/cli.js" >&2
  exit 1
fi
: "${BOTMUX_LOGISTICS_ANALYSIS_BOT:?set BOTMUX_LOGISTICS_ANALYSIS_BOT to the bot app id}"
: "${BOTMUX_LOGISTICS_ANALYSIS_HARNESS_ROOT:?set BOTMUX_LOGISTICS_ANALYSIS_HARNESS_ROOT to the Harness root}"

exec 9>"${BOTMUX_LOGISTICS_ANALYSIS_DB}.hourly.lock"
if ! flock -n 9; then
  exit 0
fi

cd "$WORKTREE"
args=(
  logistics analysis run --apply
  --db "$BOTMUX_LOGISTICS_ANALYSIS_DB"
  --bot "$BOTMUX_LOGISTICS_ANALYSIS_BOT"
  --harness-root "$BOTMUX_LOGISTICS_ANALYSIS_HARNESS_ROOT"
)
if [[ -n "${BOTMUX_LOGISTICS_ANALYSIS_MODEL:-}" ]]; then
  args+=(--model "$BOTMUX_LOGISTICS_ANALYSIS_MODEL")
fi

"$NODE_BIN" "$WORKTREE/dist/cli.js" "${args[@]}"
"$NODE_BIN" "$WORKTREE/scripts/logistics-reviewed-report.mjs" check-source \
  --db "$BOTMUX_LOGISTICS_ANALYSIS_DB"
