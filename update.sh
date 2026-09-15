#!/usr/bin/env bash
#
# ProxyBridge self-update worker, invoked by proxybridge-update.service.
#
# Ordering matters: everything that can fail (network, extraction, npm install)
# happens BEFORE the running service is touched. If the new version then fails
# to come up, the previous release is restored automatically.

set -Eeuo pipefail

SERVICE_NAME="proxybridge"
INSTALL_DIR="/opt/proxybridge"
LATEST_RELEASE_URL="https://github.com/debbide/ProxyBridge/releases/latest"
HEALTH_TIMEOUT_SECONDS="${PROXYBRIDGE_HEALTH_TIMEOUT:-30}"
TEMP_DIR=""
BACKUP_DIR=""

cleanup() {
  [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]] && rm -rf "${TEMP_DIR}"
  [[ -n "${BACKUP_DIR}" && -d "${BACKUP_DIR}" ]] && rm -rf "${BACKUP_DIR}"
}

log() {
  echo "[update] $*"
}

fail() {
  echo "[update] 错误：$*" >&2
  exit 1
}

trap cleanup EXIT

# Serialise updates so two panel clicks cannot interleave.
exec 9>/run/proxybridge-update.lock
flock -n 9 || { log "已有更新任务在运行，退出。"; exit 75; }

release_url="$(curl -fsSL --connect-timeout 10 --max-time 30 \
  -o /dev/null -w '%{url_effective}' "${LATEST_RELEASE_URL}")"
release_tag="${release_url##*/tag/}"

if [[ -z "${release_tag}" || ! "${release_tag}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  fail "GitHub 仓库尚未发布有效的正式版本。"
fi

release_version="${release_tag#v}"
archive_url="https://github.com/debbide/ProxyBridge/archive/refs/tags/${release_tag}.tar.gz"
TEMP_DIR="$(mktemp -d)"

log "正在下载 ProxyBridge ${release_tag}..."
curl -fsSL --connect-timeout 10 --max-time 120 "${archive_url}" \
  | tar -xz -C "${TEMP_DIR}" --strip-components=1

if [[ ! -f "${TEMP_DIR}/backend/package.json" || ! -f "${TEMP_DIR}/backend/server.js" ]]; then
  fail "下载的 Release 文件不完整。"
fi

# Complete all network and dependency work before stopping the running service.
(cd "${TEMP_DIR}/backend" && npm pkg set "version=${release_version}")
log "正在安装生产依赖..."
(cd "${TEMP_DIR}/backend" && npm ci --omit=dev) || fail "依赖安装失败，已取消更新，当前版本保持运行。"

current_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "${INSTALL_DIR}/backend/package.json" 2>/dev/null | head -n 1)"

# Snapshot the parts of the install the update replaces. data/ and .env are
# never touched, so they are deliberately excluded from the backup.
BACKUP_DIR="$(mktemp -d)"
log "正在备份当前版本 v${current_version:-未知}..."
cp -a "${INSTALL_DIR}/backend" "${BACKUP_DIR}/backend"
cp -a "${INSTALL_DIR}/frontend" "${BACKUP_DIR}/frontend"
[[ -f "${INSTALL_DIR}/update.sh" ]] && cp -a "${INSTALL_DIR}/update.sh" "${BACKUP_DIR}/update.sh"

restore_backup() {
  log "正在回滚到更新前的版本..."
  [[ -d "${INSTALL_DIR}/backend" ]] && rm -rf "${INSTALL_DIR}/backend"
  [[ -d "${INSTALL_DIR}/frontend" ]] && rm -rf "${INSTALL_DIR}/frontend"
  cp -a "${BACKUP_DIR}/backend" "${INSTALL_DIR}/backend"
  cp -a "${BACKUP_DIR}/frontend" "${INSTALL_DIR}/frontend"
  [[ -f "${BACKUP_DIR}/update.sh" ]] && install -m 0755 "${BACKUP_DIR}/update.sh" "${INSTALL_DIR}/update.sh"
  systemctl daemon-reload
  systemctl restart "${SERVICE_NAME}" || true
}

wait_until_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

install_release_files() {
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
}

log "正在停止服务并安装 v${release_version}..."
pkill -f "node ${INSTALL_DIR}/backend/server.js" || true
sleep 1

# Any failure from here on leaves a half-replaced install, so every step is
# checked explicitly and falls through to the rollback below.
deploy_failed=0
if ! install_release_files; then
  log "替换程序文件失败。"
  deploy_failed=1
elif ! systemctl daemon-reload; then
  log "systemd 重新加载失败。"
  deploy_failed=1
elif ! systemctl restart "${SERVICE_NAME}"; then
  log "服务重启失败。"
  deploy_failed=1
fi

if (( deploy_failed == 0 )) && wait_until_healthy; then
  log "更新成功：已更新到 v${release_version}。"
  exit 0
fi

log "新版本启动失败，正在收集日志..."
journalctl -u "${SERVICE_NAME}" -n 30 --no-pager || true
restore_backup

if wait_until_healthy; then
  fail "v${release_version} 启动失败，已回滚到 v${current_version:-更新前版本}。"
fi

fail "v${release_version} 启动失败，回滚后服务仍未恢复，请手动检查。"
