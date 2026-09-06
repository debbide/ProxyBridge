# ProxyBridge

ProxyBridge 是一个轻量的本地代理端口管理器，支持集中添加上游代理、自动分配本地端口、启停节点和代理测速。

## 交互式管理

适用于使用 systemd 的 Debian 或 Ubuntu。一个交互式脚本统一提供安装、更新和卸载功能：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/ProxyBridge/master/install.sh | sudo bash
```

脚本会显示操作菜单。安装和更新都会通过 GitHub Releases API 获取最新正式版本并显示版本号。更新会保留管理员配置、加密密钥和代理数据库，启动失败时自动恢复更新前版本。卸载可选择保留配置和数据，或输入 `DELETE` 彻底删除。

程序默认安装到 `/opt/proxybridge`，创建并启动 `proxybridge.service`。代理节点端口默认仅监听 `127.0.0.1`。

## 服务管理

```bash
sudo systemctl status proxybridge
sudo systemctl restart proxybridge
sudo journalctl -u proxybridge -f
```

如果管理面板监听 `0.0.0.0`，请使用服务器实际 IP 地址访问，并通过防火墙限制管理端口仅允许可信来源连接。
