#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:?Image digest required}"
[[ "$image_ref" =~ @sha256:[0-9a-f]{64}$ || "$image_ref" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1

docker run --rm --network none --env NODE_ENV=test --entrypoint node "$image_ref" --input-type=module -e '
  const profiling = await import("@sentry/profiling-node");
  profiling.nodeProfilingIntegration();
  await import("@prisma/client");
  console.log("Prisma client and native Sentry profiling load successfully");
'
