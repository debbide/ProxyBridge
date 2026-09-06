#!/usr/bin/env bash

set -Eeuo pipefail

SERVICE_NAME="proxybridge"
INSTALL_DIR="/opt/proxybridge"
REPOSITORY_ARCHIVE="https://github.com/debbide/ProxyBridge/archive/refs/heads/master.tar.gz"
TEMP_DIR=""
BACKUP_DIR=""

cleanup() {
  [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]] && rm -rf "${TEMP_DIR}"
}

trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 权限运行更新脚本。"
  exit 1
fi

if [[ ! -f "${INSTALL_DIR}/backend/.env" || ! -d "${INSTALL_DIR}/backend/data" ]]; then
  echo "错误：未找到现有 ProxyBridge 安装，请先执行一键安装。"
  exit 1
fi

for command in curl tar node npm systemctl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "错误：缺少必要命令 ${command}。"
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d)"
BACKUP_DIR="${INSTALL_DIR}.backup.$(date +%Y%m%d%H%M%S)"

echo "正在下载 ProxyBridge 最新版本..."
curl -fsSL "${REPOSITORY_ARCHIVE}" | tar -xz -C "${TEMP_DIR}" --strip-components=1

if [[ ! -f "${TEMP_DIR}/backend/package.json" || ! -f "${TEMP_DIR}/backend/server.js" ]]; then
  echo "错误：下载的项目文件不完整。"
  exit 1
fi

echo "正在安装生产依赖..."
cd "${TEMP_DIR}/backend"
npm ci --omit=dev

echo "正在停止服务并备份当前版本..."
systemctl stop "${SERVICE_NAME}"
cp -a "${INSTALL_DIR}" "${BACKUP_DIR}"

rollback() {
  echo "更新失败，正在恢复更新前版本..."
  rm -rf "${INSTALL_DIR}"
  mv "${BACKUP_DIR}" "${INSTALL_DIR}"
  systemctl start "${SERVICE_NAME}" || true
}

trap rollback ERR

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

systemctl daemon-reload
systemctl start "${SERVICE_NAME}"
sleep 2

if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "服务未能正常启动。"
  false
fi

trap - ERR
rm -rf "${BACKUP_DIR}"

echo "ProxyBridge 已更新到最新版本。"
echo "服务状态：systemctl status ${SERVICE_NAME}"
echo "查看日志：journalctl -u ${SERVICE_NAME} -f"
