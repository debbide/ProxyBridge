#!/usr/bin/env bash

set -Eeuo pipefail

SERVICE_NAME="proxybridge"
INSTALL_DIR="/opt/proxybridge"
LATEST_RELEASE_URL="https://github.com/debbide/ProxyBridge/releases/latest"
TEMP_DIR=""

cleanup() {
  [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]] && rm -rf "${TEMP_DIR}"
}

trap cleanup EXIT

exec 9>/run/proxybridge-update.lock
flock -n 9 || exit 75

release_url="$(curl -fsSL --connect-timeout 10 --max-time 30 \
  -o /dev/null -w '%{url_effective}' "${LATEST_RELEASE_URL}")"
release_tag="${release_url##*/tag/}"

if [[ -z "${release_tag}" || ! "${release_tag}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "错误：GitHub 仓库尚未发布有效的正式版本。"
  exit 1
fi

release_version="${release_tag#v}"
archive_url="https://github.com/debbide/ProxyBridge/archive/refs/tags/${release_tag}.tar.gz"
TEMP_DIR="$(mktemp -d)"

curl -fsSL --connect-timeout 10 --max-time 120 "${archive_url}" \
  | tar -xz -C "${TEMP_DIR}" --strip-components=1

if [[ ! -f "${TEMP_DIR}/backend/package.json" || ! -f "${TEMP_DIR}/backend/server.js" ]]; then
  echo "错误：下载的 Release 文件不完整。"
  exit 1
fi

# Complete all network and dependency work before stopping the running service.
(cd "${TEMP_DIR}/backend" && npm pkg set "version=${release_version}")
(cd "${TEMP_DIR}/backend" && npm ci --omit=dev)

systemctl stop "${SERVICE_NAME}"

mkdir -p "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend"
find "${INSTALL_DIR}/backend" -mindepth 1 -maxdepth 1 \
  ! -name data ! -name .env -exec rm -rf {} +
find "${INSTALL_DIR}/frontend" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

for source in "${TEMP_DIR}/backend/"* "${TEMP_DIR}/backend/".[!.]* "${TEMP_DIR}/backend/"..?*; do
  [[ -e "${source}" ]] || continue
  case "$(basename "${source}")" in
    data|.env) continue ;;
  esac
  cp -a "${source}" "${INSTALL_DIR}/backend/"
done

cp -a "${TEMP_DIR}/frontend/." "${INSTALL_DIR}/frontend/"
install -m 0755 "${TEMP_DIR}/update.sh" "${INSTALL_DIR}/update.sh"

systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"
