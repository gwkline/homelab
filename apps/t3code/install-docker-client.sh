#!/bin/sh
# Client binaries only: the daemon runs behind the separate guest kernel.
# Release hashes come from docker-library/docker's official versions.json.
# Bump versions and both architecture hashes together.
set -eu

DOCKER_VERSION=29.10.0
COMPOSE_VERSION=5.8.0
BUILDX_VERSION=0.39.0
case "$(uname -m)" in
  x86_64|amd64)
    darch=x86_64; barch=amd64
    docker_sha=7c1ebadc65c716cdc6d35fc78759ed0e4317debf43c21dd12f066f2006999def
    compose_sha=b8840f5008c447f41fce0a57ae3adeab42c89b1eb6e6012524bcabbfb4ffbaf6
    buildx_sha=5fb31a097304fbf6dd4038649a0decf32c2b9510e4047acd7d68b9d700c46194
    ;;
  aarch64|arm64)
    darch=aarch64; barch=arm64
    docker_sha=6e5159e8b5615e0c0c2954a2a1a2a12bc65f5d9b603595dba24a10cb367408cd
    compose_sha=1a9c918b2fb49b9c87f0018c64b5abd0d30715155e98dc939779fbaee6c414d3
    buildx_sha=722cdcdfdd6f3fb943fa1ba75102d057feb18ba72aab93b1b0a8cf2b2b48a25f
    ;;
  *) printf '%s\n' 'unsupported Docker client architecture' >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fetch() {
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "$1" -o "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum -c -
}
fetch "https://download.docker.com/linux/static/stable/${darch}/docker-${DOCKER_VERSION}.tgz" "$work/docker.tgz" "$docker_sha"
# Never extract/install dockerd, containerd, runc or their sockets in T3.
tar -xzf "$work/docker.tgz" -C "$work" docker/docker
install -m 0755 "$work/docker/docker" /usr/local/bin/docker
plugins=/usr/local/lib/docker/cli-plugins
mkdir -p "$plugins"
fetch "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${darch}" "$work/compose" "$compose_sha"
fetch "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${barch}" "$work/buildx" "$buildx_sha"
install -m 0755 "$work/compose" "$plugins/docker-compose"
install -m 0755 "$work/buildx" "$plugins/docker-buildx"

docker --version
docker compose version
docker buildx version
case "$(docker --version)" in
  "Docker version ${DOCKER_VERSION}, "*) ;;
  *) printf '%s\n' 'Docker CLI version mismatch' >&2; exit 1 ;;
esac
[ "$(docker compose version --short)" = "$COMPOSE_VERSION" ]
case "$(docker buildx version)" in
  "github.com/docker/buildx v${BUILDX_VERSION} "*) ;;
  *) printf '%s\n' 'Buildx version mismatch' >&2; exit 1 ;;
esac
