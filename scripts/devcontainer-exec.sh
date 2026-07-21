#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: scripts/devcontainer-exec.sh <workspace-folder> <command> [args...]" >&2
  exit 2
fi

workspace_folder="$1"
shift

if command -v devcontainer >/dev/null 2>&1; then
  exec devcontainer exec --workspace-folder "${workspace_folder}" "$@"
fi

find_bundled_cli() {
  local search_root
  for search_root in \
    "${HOME}/.vscode/extensions" \
    "${HOME}/.vscode-insiders/extensions" \
    "${HOME}/.cursor/extensions"; do
    [[ -d "${search_root}" ]] || continue
    find "${search_root}" \
      -path '*/ms-vscode-remote.remote-containers-*/dist/spec-node/devContainersSpecCLI.js' \
      -print 2>/dev/null | sort -V | tail -n 1
  done
}

bundled_cli="$(find_bundled_cli | tail -n 1)"
if [[ -n "${bundled_cli}" ]]; then
  exec node "${bundled_cli}" exec --workspace-folder "${workspace_folder}" "$@"
fi

cat >&2 <<'EOF'
Could not find the Dev Containers CLI.

Install it on the host with:
  npm install -g @devcontainers/cli

Or install the VS Code Dev Containers extension so Selection Bridge can use its bundled CLI.
EOF
exit 127
