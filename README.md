# ProxyBridge

ProxyBridge 是一个轻量的本地代理端口管理器，支持集中添加上游代理、自动分配本地端口、启停节点和代理测速。

## 交互式管理

适用于使用 systemd 的 Debian 或 Ubuntu。一个交互式脚本统一提供安装、更新和卸载功能：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/ProxyBridge/master/install.sh | sudo bash
```

脚本会显示操作菜单。安装和更新都会通过 GitHub 最新 Release 地址获取最新正式版本并显示版本号，不依赖容易触发限流的 GitHub API。

更新会保留管理员配置、加密密钥和代理数据库。更新过程先把新版本下载并安装好依赖，再替换正在运行的文件；替换后会等待服务健康检查，如果新版本启动失败，会自动回滚到更新前的版本并重启服务。卸载可选择保留配置和数据或彻底删除。选择保留数据后，可以再次选择安装，脚本会恢复程序和服务并继续使用原配置与代理数据库；选择彻底卸载后会直接删除程序和全部数据，不再二次确认。

程序默认安装到 `/opt/proxybridge`，创建并启动 `proxybridge.service`。代理节点端口与安装时选择的面板监听地址保持一致：选择 `127.0.0.1` 时仅本机访问，选择 `0.0.0.0` 时可通过服务器地址访问。

## 面板内更新

登录面板后，右上角会显示当前版本。检测到新版本时可以直接在面板中点击更新，后端会通过 `proxybridge-update.service` 执行与 `update.sh` 相同的更新流程（同样带备份和失败回滚）。面板每 2 秒轮询一次版本状态，服务端有 60 秒缓存，不会对 GitHub 造成额外压力。

## 配置

配置位于 `/opt/proxybridge/backend/.env`，可参考 `backend/.env.example`。

`ADMIN_PASSWORD`、`JWT_SECRET`、`PROXY_ENCRYPTION_KEY` 三个密钥没有默认值：缺失、过短或仍是示例值时，服务会拒绝启动并给出明确错误，而不是退回弱默认值。注意 `PROXY_ENCRYPTION_KEY` 用于加密数据库中的上游代理地址，更换该值后服务会拒绝启动，需先清空或迁移数据库。

`TRUST_PROXY` 仅在面板前方有可信反向代理（会设置 `X-Forwarded-For`）时设为 `1`，否则登录限流会把所有客户端视为同一来源。

## 安全说明

- 管理面板密码使用恒定时间比较，连续失败会触发限流（默认 5 次后锁定 15 分钟），可用 `LOGIN_MAX_ATTEMPTS`、`LOGIN_WINDOW_MS`、`LOGIN_BLOCK_MS` 调整。
- 上游代理地址以 AES-256-GCM 加密后写入 SQLite。
- 前端依赖的 Vue 随程序分发（`frontend/vendor/`），不依赖外部 CDN，离线环境也能打开面板。

## 服务管理

```bash
sudo systemctl status proxybridge
sudo systemctl restart proxybridge
sudo journalctl -u proxybridge -f
```

如果管理面板监听 `0.0.0.0`，请使用服务器实际 IP 地址访问，并通过防火墙限制管理端口仅允许可信来源连接。

## 本地开发

```bash
cd backend
npm install
npm test
```

后端在缺少密钥时会拒绝启动，因此本地运行前需要先准备 `.env`：

```bash
cp .env.example .env
# 编辑 .env，把三个密钥换成真实值
npm start
```
