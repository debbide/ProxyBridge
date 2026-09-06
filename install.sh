#!/usr/bin/env bash

set -Eeuo pipefail

SERVICE_NAME="proxybridge"
INSTALL_DIR="/opt/proxybridge"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
REPOSITORY_ARCHIVE="https://github.com/debbide/ProxyBridge/archive/refs/heads/master.tar.gz"
SOURCE_TEMP_DIR=""

cleanup() {
  if [[ -n "${SOURCE_TEMP_DIR}" && -d "${SOURCE_TEMP_DIR}" ]]; then
    rm -rf "${SOURCE_TEMP_DIR}"
  fi
}

trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 权限运行：sudo bash install.sh"
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "错误：当前系统未使用 systemd，暂不支持自动安装。"
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE-$0}")" && pwd)"
if [[ ! -f "${SCRIPT_DIR}/backend/package.json" || ! -f "${SCRIPT_DIR}/backend/server.js" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "错误：curl 管道安装需要系统预先安装 curl。"
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "错误：未找到 tar，无法解压项目文件。"
    exit 1
  fi

  echo "正在下载 ProxyBridge 最新版本..."
  SOURCE_TEMP_DIR="$(mktemp -d)"
  curl -fsSL "${REPOSITORY_ARCHIVE}" | tar -xz -C "${SOURCE_TEMP_DIR}" --strip-components=1
  SCRIPT_DIR="${SOURCE_TEMP_DIR}"

  if [[ ! -f "${SCRIPT_DIR}/backend/package.json" || ! -f "${SCRIPT_DIR}/backend/server.js" ]]; then
    echo "错误：下载的项目文件不完整。"
    exit 1
  fi
fi

if [[ ! -r /dev/tty ]]; then
  echo "错误：交互式安装需要可用的终端。"
  exit 1
fi
exec 3</dev/tty

echo "========================================"
echo "        ProxyBridge 一键安装程序"
echo "========================================"
echo

echo "请选择 Web 管理面板的监听地址："
echo "  1) 127.0.0.1  仅本机访问（推荐）"
echo "  2) 0.0.0.0    允许局域网或公网访问"
while true; do
  read -r -u 3 -p "请输入选项 " LISTEN_CHOICE
  LISTEN_CHOICE="${LISTEN_CHOICE:-1}"
  case "${LISTEN_CHOICE}" in
    1) HOST="127.0.0.1"; break ;;
    2) HOST="0.0.0.0"; break ;;
    *) echo "请输入 1 或 2。" ;;
  esac
done

while true; do
  read -r -u 3 -p "管理面板端口 " PORT
  PORT="${PORT:-3000}"
  if [[ "${PORT}" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )); then
    break
  fi
  echo "请输入 1 到 65535 之间的有效端口。"
done

while true; do
  read -r -s -u 3 -p "请设置管理密码（至少 8 个字符）: " ADMIN_PASSWORD
  echo
  if (( ${#ADMIN_PASSWORD} < 8 )); then
    echo "密码长度不能少于 8 个字符。"
    continue
  fi
  read -r -s -u 3 -p "请再次输入管理密码: " ADMIN_PASSWORD_CONFIRM
  echo
  if [[ "${ADMIN_PASSWORD}" == "${ADMIN_PASSWORD_CONFIRM}" ]]; then
    break
  fi
  echo "两次输入的密码不一致，请重新输入。"
done

if [[ "${HOST}" == "0.0.0.0" ]]; then
  echo
  echo "提示：管理面板将允许远程访问，请在防火墙中仅向可信来源开放 ${PORT} 端口。"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，正在安装 Node.js 20.x..."
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "错误：自动安装 Node.js 目前仅支持 Debian/Ubuntu。"
    exit 1
  fi
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs build-essential python3
fi

if ! command -v openssl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y openssl
  else
    echo "错误：未找到 openssl，无法生成安全密钥。"
    exit 1
  fi
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 18 )); then
  echo "错误：ProxyBridge 需要 Node.js 18 或更高版本，当前版本为 $(node --version)。"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未找到 npm。"
  exit 1
fi

JWT_SECRET="$(openssl rand -hex 32)"
PROXY_ENCRYPTION_KEY="$(openssl rand -hex 32)"

echo
echo "正在安装到 ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  systemctl stop "${SERVICE_NAME}"
fi

mkdir -p "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend"
find "${INSTALL_DIR}/backend" -mindepth 1 -maxdepth 1 \
  ! -name data ! -name .env -exec rm -rf {} +
find "${INSTALL_DIR}/frontend" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

for source in "${SCRIPT_DIR}/backend/"* "${SCRIPT_DIR}/backend/".[!.]* "${SCRIPT_DIR}/backend/"..?*; do
  [[ -e "${source}" ]] || continue
  case "$(basename "${source}")" in
    node_modules|data|.env) continue ;;
  esac
  cp -a "${source}" "${INSTALL_DIR}/backend/"
done
cp -a "${SCRIPT_DIR}/frontend/." "${INSTALL_DIR}/frontend/"
mkdir -p "${INSTALL_DIR}/backend/data"

cat > "${INSTALL_DIR}/backend/.env" <<EOF
HOST=${HOST}
PORT=${PORT}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
JWT_SECRET=${JWT_SECRET}
PROXY_ENCRYPTION_KEY=${PROXY_ENCRYPTION_KEY}
DATABASE_PATH=${INSTALL_DIR}/backend/data/data.db
LOCAL_PROXY_HOST=127.0.0.1
LOCAL_PORT_START=8001
LOCAL_PORT_END=8999
JWT_EXPIRES_IN=12h
EOF
chmod 600 "${INSTALL_DIR}/backend/.env"

cd "${INSTALL_DIR}/backend"
npm ci --omit=dev

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=ProxyBridge proxy management service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/backend
ExecStart=$(command -v node) ${INSTALL_DIR}/backend/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

sleep 2
if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "安装完成，但服务启动失败。最近日志如下："
  journalctl -u "${SERVICE_NAME}" -n 30 --no-pager
  exit 1
fi

echo
echo "========================================"
echo "ProxyBridge 安装成功"
echo "管理地址：http://${HOST}:${PORT}/"
if [[ "${HOST}" == "0.0.0.0" ]]; then
  echo "远程访问时请将 0.0.0.0 替换为服务器 IP 地址。"
fi
echo "服务状态：systemctl status ${SERVICE_NAME}"
echo "查看日志：journalctl -u ${SERVICE_NAME} -f"
echo "重新启动：systemctl restart ${SERVICE_NAME}"
echo "========================================"
