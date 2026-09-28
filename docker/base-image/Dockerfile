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

# Debian package metadata and versions are fixed to one signed snapshot. The
# base has no CA certificates, so ca-certificates is bootstrapped over HTTP;
# apt verifies the signed Release metadata and package hash, then all further
# snapshot access uses HTTPS. Direct package versions are explicit so a rebuild
# cannot silently select newer bookworm updates.
RUN set -eux; \
    rm -f /etc/apt/sources.list; \
    rm -f /etc/apt/sources.list.d/*; \
    printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260918T000000Z bookworm main' \
      > /etc/apt/sources.list.d/debian-snapshot.list; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      ca-certificates=20230311+deb12u1; \
    rm -rf /var/lib/apt/lists/*; \
    printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260918T000000Z bookworm main' \
      > /etc/apt/sources.list.d/debian-snapshot.list; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      bash=5.2.15-2+b13 \
      curl=7.88.1-10+deb12u15 \
      git=1:2.39.5-0+deb12u3 \
      ripgrep=13.0.0-4+b2 \
      tmux=3.3a-3; \
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
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${gh_arch}"; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# npm ci cannot consume a lockfile in global mode. Install the committed
# lockfile locally instead and expose its immutable bin shim on PATH.
COPY package.json package-lock.json /opt/pi/
RUN set -eux; \
    test "${PI_VERSION}" = 0.87.1; \
    cd /opt/pi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    npm cache clean --force
ENV PATH=/opt/pi/node_modules/.bin:${PATH}

RUN set -eux; \
    groupadd --gid "${DEV_GID}" dev; \
    useradd --uid "${DEV_UID}" --gid "${DEV_GID}" --create-home --shell /bin/bash dev; \
    install --directory --owner=dev --group=dev /workspace /workspace/project /home/dev/.config

WORKDIR /workspace/project
USER dev

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "command -v pi >/dev/null && pi --version >/dev/null 2>&1 && command -v git >/dev/null && command -v gh >/dev/null && command -v tmux >/dev/null && command -v rg >/dev/null && command -v curl >/dev/null && test -w /workspace/project"]

CMD ["pi"]
