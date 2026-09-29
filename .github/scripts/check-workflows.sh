#!/usr/bin/env bash
set -euo pipefail

# Check source-controlled workflow syntax without running any deployment.
tool_directory="$(mktemp -d)"
trap 'rm -f "$tool_directory/actionlint.tar.gz" "$tool_directory/actionlint"; rmdir "$tool_directory"' EXIT
curl --fail --silent --show-error --location \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
  --output "$tool_directory/actionlint.tar.gz"
actual="$(sha256sum "$tool_directory/actionlint.tar.gz" | cut -d ' ' -f 1)"
[[ "$actual" == 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ]] || { echo "Archive Actionlint non vérifiée." >&2; exit 1; }
tar -xzf "$tool_directory/actionlint.tar.gz" -C "$tool_directory" actionlint
command -v shellcheck >/dev/null || { echo "ShellCheck est requis." >&2; exit 1; }
"$tool_directory/actionlint" -color
# Bash expands the files itself: no optional tool or hidden subprocess failure.
# Fail rather than reporting success if there are no scripts to check.
shopt -s globstar failglob
shellcheck .github/scripts/**/*.sh
