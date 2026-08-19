#!/bin/sh
set -eu

image=${1:?Usage: deploy/check-image-size.sh IMAGE}
max_bytes=${DOCKER_IMAGE_MAX_BYTES:-1000000000}

case "$max_bytes" in
  ''|*[!0-9]*)
    echo "DOCKER_IMAGE_MAX_BYTES must be a positive integer" >&2
    exit 2
    ;;
esac

if [ "$max_bytes" -eq 0 ]; then
  echo "DOCKER_IMAGE_MAX_BYTES must be greater than zero" >&2
  exit 2
fi

image_bytes=$(docker image inspect --format '{{.Size}}' "$image")
image_mib=$((image_bytes / 1024 / 1024))
max_mib=$((max_bytes / 1024 / 1024))

echo "Uncompressed Docker image size: ${image_mib} MiB (budget: < ${max_mib} MiB)"

if [ "$image_bytes" -ge "$max_bytes" ]; then
  echo "Docker image exceeds the ${max_bytes}-byte budget" >&2
  exit 1
fi
