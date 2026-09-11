#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:?Référence immuable de l’image requise}"
if [[ ! "$image_ref" =~ @sha256:[0-9a-f]{64}$ && ! "$image_ref" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Une image identifiée par digest est obligatoire." >&2
  exit 1
fi
mkdir -p .artifacts/security
trivy image --scanners vuln --format json --timeout 15m \
  --exit-code 1 --exit-on-eol 1 --output .artifacts/security/image-audit.json "$image_ref"
