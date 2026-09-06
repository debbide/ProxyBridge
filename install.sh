#!/usr/bin/env bash

set -Eeuo pipefail

SERVICE_NAME="proxybridge"
INSTALL_DIR="/opt/proxybridge"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
RELEASE_API_URL="https://api.github.com/repos/debbide/ProxyBridge/releases/latest"
TEMP_DIR=""
BACKUP_DIR=""

cleanup() {
  [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]] && rm -rf "${TEMP_DIR}"
}

trap cleanup EXIT

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "请使用 root 权限运行：curl -fsSL https://raw.githubusercontent.com/debbide/ProxyBridge/master/install.sh | sudo bash"
    exit 1
  fi
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "错误：当前系统未使用 systemd。"
    exit 1
  fi
}

require_terminal() {
  if [[ ! -r /dev/tty ]]; then
    echo "错误：交互式管理需要可用的终端。"
    exit 1
  fi
  exec 3</dev/tty
}

require_download_tools() {
  for command in curl tar sed head; do
    if ! command -v "${command}" >/dev/null 2>&1; then
      echo "错误：缺少必要命令 ${command}。"
      exit 1
    fi
  done
}

download_latest_release() {
  local metadata release_tag archive_url

  require_download_tools
  echo "正在查询 GitHub 最新正式版本..."
  metadata="$(curl -fsSL --connect-timeout 10 --max-time 30 \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: ProxyBridge-Installer" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${RELEASE_API_URL}")" || {
      echo "错误：无法获取最新 Release 信息。"
      exit 1
    }

  release_tag="$(printf '%s' "${metadata}" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [[ -z "${release_tag}" || ! "${release_tag}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "错误：GitHub 仓库尚未发布有效的正式版本。"
    exit 1
  fi

  archive_url="https://github.com/debbide/ProxyBridge/archive/refs/tags/${release_tag}.tar.gz"
  TEMP_DIR="$(mktemp -d)"
  echo "正在下载 ProxyBridge ${release_tag}..."
  curl -fsSL --connect-timeout 10 --max-time 120 "${archive_url}" \
    | tar -xz -C "${TEMP_DIR}" --strip-components=1

  if [[ ! -f "${TEMP_DIR}/backend/package.json" || ! -f "${TEMP_DIR}/backend/server.js" ]]; then
    echo "错误：下载的 Release 文件不完整。"
    exit 1
  fi

  RELEASE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${TEMP_DIR}/backend/package.json" | head -n 1)"
  if [[ -z "${RELEASE_VERSION}" ]]; then
    echo "错误：无法读取 Release 版本号。"
    exit 1
  fi
  echo "最新正式版本：v${RELEASE_VERSION}"
}

ensure_runtime() {
  if ! command -v node >/dev/null 2>&1; then
    echo "未检测到 Node.js，正在安装 Node.js 20.x..."
    if ! command -v apt-get >/dev/null 2>&1; then
      echo "错误：自动安装 Node.js 仅支持 Debian/Ubuntu。"
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

  if ! command -v npm >/dev/null 2>&1; then
    echo "错误：未找到 npm。"
    exit 1
  fi

  local node_major
  node_major="$(node -p "process.versions.node.split('.')[0]")"
  if (( node_major < 18 )); then
    echo "错误：ProxyBridge 需要 Node.js 18 或更高版本，当前版本为 $(node --version)。"
    exit 1
  fi
}

copy_release_files() {
  mkdir -p "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend"
  find "${INSTALL_DIR}/backend" -mindepth 1 -maxdepth 1 \
    ! -name data ! -name .env -exec rm -rf {} +
  find "${INSTALL_DIR}/frontend" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

  for source in "${TEMP_DIR}/backend/"* "${TEMP_DIR}/backend/".[!.]* "${TEMP_DIR}/backend/"..?*; do
    [[ -e "${source}" ]] || continue
    case "$(basename "${source}")" in
      node_modules|data|.env) continue ;;
    esac
    cp -a "${source}" "${INSTALL_DIR}/backend/"
  done
  cp -a "${TEMP_DIR}/frontend/." "${INSTALL_DIR}/frontend/"
}

write_service() {
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
}

install_proxybridge() {
  local host port admin_password admin_password_confirm jwt_secret encryption_key

  if [[ -f "${INSTALL_DIR}/backend/.env" ]]; then
    if [[ -f "${INSTALL_DIR}/backend/server.js" && -e "${SERVICE_FILE}" ]]; then
      echo "检测到已有安装，请从主菜单选择更新。"
      return
    fi

    echo "检测到保留的配置和代理数据，将恢复安装并继续使用原有数据。"
    download_latest_release
    ensure_runtime
    copy_release_files
    (cd "${INSTALL_DIR}/backend" && npm ci --omit=dev)
    write_service
    systemctl daemon-reload
    systemctl enable --now "${SERVICE_NAME}"
    sleep 2

    if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
      echo "恢复安装完成，但服务启动失败。"
      journalctl -u "${SERVICE_NAME}" -n 30 --no-pager
      exit 1
    fi

    echo "ProxyBridge v${RELEASE_VERSION} 已恢复安装，原配置和代理数据保持不变。"
    return
  fi

  echo "请选择 Web 管理面板监听地址："
  echo "  1) 127.0.0.1  仅本机访问（推荐）"
  echo "  2) 0.0.0.0    允许远程访问"
  while true; do
    read -r -u 3 -p "请输入选项 " listen_choice
    listen_choice="${listen_choice:-1}"
    case "${listen_choice}" in
      1) host="127.0.0.1"; break ;;
      2) host="0.0.0.0"; break ;;
      *) echo "请输入 1 或 2。" ;;
    esac
  done

  while true; do
    read -r -u 3 -p "管理面板端口 " port
    port="${port:-3000}"
    if [[ "${port}" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )); then
      break
    fi
    echo "请输入 1 到 65535 之间的有效端口。"
  done

  while true; do
    read -r -s -u 3 -p "请设置管理密码（至少 8 个字符）: " admin_password
    echo
    if (( ${#admin_password} < 8 )); then
      echo "密码长度不能少于 8 个字符。"
      continue
    fi
    read -r -s -u 3 -p "请再次输入管理密码: " admin_password_confirm
    echo
    [[ "${admin_password}" == "${admin_password_confirm}" ]] && break
    echo "两次输入的密码不一致。"
  done

  if ! command -v openssl >/dev/null 2>&1; then
    echo "错误：安装前请先安装 openssl。"
    exit 1
  fi

  download_latest_release
  ensure_runtime
  jwt_secret="$(openssl rand -hex 32)"
  encryption_key="$(openssl rand -hex 32)"

  echo "正在安装 ProxyBridge v${RELEASE_VERSION}..."
  copy_release_files
  mkdir -p "${INSTALL_DIR}/backend/data"
  cat > "${INSTALL_DIR}/backend/.env" <<EOF
HOST=${host}
PORT=${port}
ADMIN_PASSWORD=${admin_password}
JWT_SECRET=${jwt_secret}
PROXY_ENCRYPTION_KEY=${encryption_key}
DATABASE_PATH=${INSTALL_DIR}/backend/data/data.db
LOCAL_PROXY_HOST=127.0.0.1
LOCAL_PORT_START=8001
LOCAL_PORT_END=8999
JWT_EXPIRES_IN=12h
EOF
  chmod 600 "${INSTALL_DIR}/backend/.env"

  (cd "${INSTALL_DIR}/backend" && npm ci --omit=dev)
  write_service
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
  sleep 2

  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "安装完成，但服务启动失败。"
    journalctl -u "${SERVICE_NAME}" -n 30 --no-pager
    exit 1
  fi

  echo "ProxyBridge v${RELEASE_VERSION} 安装成功。"
  echo "管理地址：http://${host}:${port}/"
}

rollback_update() {
  echo "更新失败，正在恢复更新前版本..."
  rm -rf "${INSTALL_DIR}"
  mv "${BACKUP_DIR}" "${INSTALL_DIR}"
  systemctl start "${SERVICE_NAME}" || true
}

update_proxybridge() {
  if [[ ! -f "${INSTALL_DIR}/backend/.env" || ! -d "${INSTALL_DIR}/backend/data" ]]; then
    echo "未找到现有安装，请先选择安装。"
    return
  fi

  download_latest_release
  ensure_runtime

  local current_version
  current_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${INSTALL_DIR}/backend/package.json" | head -n 1)"
  echo "当前版本：v${current_version:-未知}"
  read -r -u 3 -p "确认更新到 v${RELEASE_VERSION}？[Y/n]: " confirm
  case "${confirm:-Y}" in
    y|Y) ;;
    *) echo "已取消更新。"; return ;;
  esac

  echo "正在安装生产依赖..."
  (cd "${TEMP_DIR}/backend" && npm ci --omit=dev)
  BACKUP_DIR="${INSTALL_DIR}.backup.$(date +%Y%m%d%H%M%S)"

  echo "正在停止服务并备份当前版本..."
  systemctl stop "${SERVICE_NAME}"
  cp -a "${INSTALL_DIR}" "${BACKUP_DIR}"
  trap rollback_update ERR

  copy_release_files
  write_service
  systemctl daemon-reload
  systemctl start "${SERVICE_NAME}"
  sleep 2

  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "服务未能正常启动。"
    false
  fi

  trap - ERR
  rm -rf "${BACKUP_DIR}"
  BACKUP_DIR=""
  echo "ProxyBridge 已更新到 v${RELEASE_VERSION}。"
}

uninstall_proxybridge() {
  if [[ ! -e "${SERVICE_FILE}" && ! -d "${INSTALL_DIR}" ]]; then
    echo "未检测到 ProxyBridge 安装。"
    return
  fi

  echo "请选择卸载方式："
  echo "  1) 卸载程序，保留配置和代理数据"
  echo "  2) 彻底卸载，删除全部数据"
  echo "  3) 返回主菜单"
  read -r -u 3 -p "请输入选项: " uninstall_choice

  case "${uninstall_choice}" in
    1)
      systemctl disable --now "${SERVICE_NAME}" >/dev/null 2>&1 || true
      rm -f "${SERVICE_FILE}"
      systemctl daemon-reload
      if [[ -d "${INSTALL_DIR}" ]]; then
        find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 ! -name backend -exec rm -rf {} +
        if [[ -d "${INSTALL_DIR}/backend" ]]; then
          find "${INSTALL_DIR}/backend" -mindepth 1 -maxdepth 1 \
            ! -name data ! -name .env -exec rm -rf {} +
        fi
      fi
      echo "程序已卸载，配置和代理数据保留在 ${INSTALL_DIR}/backend。"
      ;;
    2)
      systemctl disable --now "${SERVICE_NAME}" >/dev/null 2>&1 || true
      rm -f "${SERVICE_FILE}"
      systemctl daemon-reload
      rm -rf "${INSTALL_DIR}"
      echo "ProxyBridge 及全部数据已删除。"
      ;;
    3) return ;;
    *) echo "无效选项。" ;;
  esac
}

main() {
  require_root
  require_systemd
  require_terminal

  while true; do
    echo
    echo "========================================"
    echo "          ProxyBridge 管理脚本"
    echo "========================================"
    echo "  1) 安装"
    echo "  2) 更新"
    echo "  3) 卸载"
    echo "  4) 退出"
    read -r -u 3 -p "请选择操作: " action

    case "${action}" in
      1) install_proxybridge ;;
      2) update_proxybridge ;;
      3) uninstall_proxybridge ;;
      4) echo "已退出。"; exit 0 ;;
      *) echo "请输入 1 到 4。" ;;
    esac
  done
}

main "$@"
