# ProxyBridge

ProxyBridge 是一个轻量的本地代理端口管理器，支持集中添加上游代理、自动分配本地端口、启停节点和代理测速。

## 一键安装

适用于使用 systemd 的 Debian 或 Ubuntu。执行后会交互选择管理面板监听 `127.0.0.1` 或 `0.0.0.0`，并要求设置管理端口和管理员密码。

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/ProxyBridge/master/install.sh | sudo bash
```

脚本默认安装到 `/opt/proxybridge`，创建并启动 `proxybridge.service`。代理节点端口默认仅监听 `127.0.0.1`。

## 一键更新

更新会保留现有的管理员配置、加密密钥和代理数据库，并在失败时自动恢复更新前版本：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/ProxyBridge/master/update.sh | sudo bash
```

## 服务管理

```bash
sudo systemctl status proxybridge
sudo systemctl restart proxybridge
sudo journalctl -u proxybridge -f
```

如果管理面板监听 `0.0.0.0`，请使用服务器实际 IP 地址访问，并通过防火墙限制管理端口仅允许可信来源连接。
