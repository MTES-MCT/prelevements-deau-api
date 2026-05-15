#!/usr/bin/env bash
set -euo pipefail

node scripts/import-zones.js
node scripts/dropt/import-point-prelevements.js
node scripts/dropt/import-declarants.js
node scripts/dropt/import-exploitations.js
