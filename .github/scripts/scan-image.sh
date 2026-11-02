#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:?Référence immuable de l’image requise}"
if [[ ! "$image_ref" =~ @sha256:[0-9a-f]{64}$ && ! "$image_ref" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Une image identifiée par digest est obligatoire." >&2
  exit 1
fi
mkdir -p .artifacts/security
# Never let a failed scan reuse a report from an earlier candidate.
rm -f .artifacts/security/image-audit.json
scan_status=0
trivy image --scanners vuln --format json --timeout 15m \
  --exit-code 2 --exit-on-eol 1 --output .artifacts/security/image-audit.json "$image_ref" || scan_status=$?
node scripts/security/audit-image.js .artifacts/security/image-audit.json "$image_ref" "$scan_status"
