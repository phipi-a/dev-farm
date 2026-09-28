#!/usr/bin/env bash
# Build and exercise the developer base image. Requires Docker or a compatible
# Docker CLI/context; no credentials are read or passed to the build.
set -euo pipefail

image_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
image_tag=${IMAGE_TAG:-dev-farm/pi-agent-base:smoke}
pi_version=${PI_VERSION:-0.87.1}
image_version=${IMAGE_VERSION:-smoke}

docker build \
  --pull \
  --tag "${image_tag}" \
  --build-arg "PI_VERSION=${pi_version}" \
  --build-arg "IMAGE_VERSION=${image_version}" \
  "${image_dir}"

docker run --rm --entrypoint sh "${image_tag}" -ceu '
  test "$(id -u)" != 0
  test "$(id -un)" = dev
  test "$HOME" = /home/dev
  test "$WORKSPACE" = /workspace
  test "$PWD" = /workspace/project
  test -w /workspace/project
  for tool in pi git gh tmux rg curl; do command -v "$tool" >/dev/null; done
  pi --version
  git --version
  gh --version | head -n 1
  tmux -V
  rg --version | head -n 1
  curl --version | head -n 1
'

echo "Smoke validation passed for ${image_tag}"
