# Knowledge Atlas 云端插件 0.2.0

插件通过云端账号读取和更新地图；桌面 App 登录同一账号后自动同步。个人电脑关闭也能通过插件写入，不再需要每个人维护 tunnel。

## 在 ChatGPT 中连接

1. 在 https://littlefish.sarl/atlas/ 或 0.2.0 App 注册账号
2. 在支持自定义 MCP 的 ChatGPT 设置中添加连接，服务器地址填 `https://littlefish.sarl/atlas/mcp`
3. 选择 OAuth；如果需要指定客户端注册方式，选择动态客户端注册（DCR），无需填写共享客户端密钥
4. 在授权页面登录同一个 Atlas 账号并允许连接
5. 让 ChatGPT「列出我的知识地图」或「创建一张知识地图」，App 打开时约每 5 秒检查变化

账号密码只在 Atlas 登录页填写，不要粘贴到聊天中。各账号地图隔离。App 的账号设置可以撤销该账号全部插件授权；之后需重新连接。登录会话保留在当前窗口，完全退出 App 后需要重新登录。当前不提供密码找回。

这是 MCP 连接，不要求安装 ZIP；ChatGPT 是否提供自定义连接入口取决于账号功能。服务接口、OAuth 与数据隔离已验证，用户自己的 ChatGPT 连接仍需按上述步骤授权。

## 插件包

```sh
# 默认：远程 Streamable HTTP + OAuth，无本地进程
python scripts/package-plugin.py
# 如所在产品要求绑定已注册连接，使用该账号实际得到的 App ID
python scripts/package-plugin.py --app-id plugin_asdk_app_YOUR_ACTUAL_ID
# 显式兼容旧本地模式：需要本机 App 和 Node.js 22
python scripts/package-plugin.py --local
```

绑定包只引用已有连接，不会替你注册连接；不要把示例 App ID 当成真实值。默认云端包不含本地 adapter 或任何账号凭据。支持仓库插件的客户端可安装本分支 `plugins/knowledge-atlas`，默认连接云端。

旧地图仍在原电脑，可在 App 账号设置中确认导入云端。旧本地插件与云端插件使用不同数据源，切换后请停用旧连接，避免写到不同位置。导入不删除本地原件，不自动覆盖同 ID 地图，不导入撤销历史。

[OAuth 机制](https://developers.openai.com/plugins/build/auth) · [服务部署说明](../../cloud/README.md)
