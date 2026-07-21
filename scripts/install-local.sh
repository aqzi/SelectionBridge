#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
extension_target="${HOME}/.vscode/extensions/selection-bridge-local"
legacy_extension_target="${HOME}/.vscode/extensions/this-pointer-local"
skill_home="${CODEX_HOME:-${HOME}/.codex}/skills"
skill_target="${skill_home}/selection-bridge"
legacy_skill_target="${skill_home}/this-pointer"

if [[ ! -d "${repo_root}/node_modules" ]]; then
  echo "Missing node_modules. Run: npm install" >&2
  exit 1
fi

if [[ ! -f "${repo_root}/out/extension.js" ]]; then
  echo "Missing compiled extension output. Run: npm run compile" >&2
  exit 1
fi

mkdir -p "$(dirname "${extension_target}")"
mkdir -p "${skill_home}"

link_or_fail() {
  local source="$1"
  local target="$2"

  if [[ -e "${target}" || -L "${target}" ]]; then
    local existing
    existing="$(readlink "${target}" || true)"
    if [[ "${existing}" != "${source}" ]]; then
      echo "Refusing to replace existing path: ${target}" >&2
      exit 1
    fi
  fi

  ln -sfn "${source}" "${target}"
}

remove_legacy_link() {
  local source="$1"
  local target="$2"

  if [[ -L "${target}" && "$(readlink "${target}")" == "${source}" ]]; then
    rm -f "${target}"
  fi
}

remove_legacy_link "${repo_root}" "${legacy_extension_target}"
remove_legacy_link "${repo_root}/skills/this-pointer" "${legacy_skill_target}"
link_or_fail "${repo_root}" "${extension_target}"
link_or_fail "${repo_root}/skills/selection-bridge" "${skill_target}"

echo "Linked VS Code extension: ${extension_target}"
echo "Linked Codex skill: ${skill_target}"
echo "Removed legacy this-pointer links if they pointed at this repo."
echo "Reload VS Code so the extension activates."
