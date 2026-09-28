# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ARG PI_VERSION=0.87.1
ARG GH_VERSION=2.101.0
ARG IMAGE_VERSION=0.1.0
ARG DEV_UID=10001
ARG DEV_GID=10001
ARG TARGETARCH

LABEL org.opencontainers.image.title="dev-farm Pi developer base" \
      org.opencontainers.image.description="Non-root developer image with Pi and repository tooling" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      io.dev-farm.pi.version="${PI_VERSION}" \
      io.dev-farm.github-cli.version="${GH_VERSION}"

ENV HOME=/home/dev \
    WORKSPACE=/workspace

# The GitHub CLI archive is selected by target architecture and verified before
# it is unpacked. Pi is installed from its exact npm version; npm verifies the
# package and its dependency integrity from the registry metadata.
RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      ripgrep \
      tmux; \
    target_arch="${TARGETARCH:-amd64}"; \
    case "${target_arch}" in \
      amd64) gh_arch=amd64; gh_sha256=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8 ;; \
      arm64) gh_arch=arm64; gh_sha256=b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f ;; \
      *) echo "Unsupported target architecture: ${target_arch}" >&2; exit 1 ;; \
    esac; \
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" \
      --output /tmp/gh.tar.gz; \
    echo "${gh_sha256}  /tmp/gh.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file /tmp/gh.tar.gz --directory /tmp; \
    install --mode=0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
    npm install --global --omit=dev --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}"; \
    npm cache clean --force; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${gh_arch}"; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    groupadd --gid "${DEV_GID}" dev; \
    useradd --uid "${DEV_UID}" --gid "${DEV_GID}" --create-home --shell /bin/bash dev; \
    install --directory --owner=dev --group=dev /workspace /workspace/project /home/dev/.config

WORKDIR /workspace/project
USER dev

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "command -v pi >/dev/null && pi --version >/dev/null 2>&1 && command -v git >/dev/null && command -v gh >/dev/null && command -v tmux >/dev/null && command -v rg >/dev/null && command -v curl >/dev/null && test -w /workspace/project"]

CMD ["pi"]
