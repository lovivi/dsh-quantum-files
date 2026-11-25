# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，并记录所固定的 FBQ 版本。

## [0.1.0] — 2026-11-25

首个可用版本。

### 新增

- **sidecar 桥接**：把 FileBrowser Quantum 作为子进程托管（Unix socket + `baseURL=/-/fbq`），
  两个同源前门反代到同一实例。
- **三个界面入口**：会话头「📁 文件」按钮、右侧栏 tab（含 guide 卡片）、对话区全宽 tab。
- **两种鉴权**：`proxy`（复用 DSH 浏览器会话，身份头透传 FBQ）与 `password`（FBQ 自管账号）。
- **独立端口**：TLS + Basic 口令门，可配置只读（仅 `GET/HEAD/OPTIONS/PROPFIND`）。
- **二进制管理**：按平台自动下载 FBQ 并校验 sha256；`scripts/update-binaries.js` 可重建摘要清单。
- **进程守护**：健康检查、崩溃指数退避重启、卸载时回收 socket。
- **测试**：36 条用例（单测 / 客户端契约 / 假上游集成），不需要 DSH 也不需要真 FBQ。

### 修复

- `sidebar.right.pane.tab` 是 keyed 槽位，注册选项必须是 `key` 而非 `id`；
  之前传错导致「这类内容还没有可用的查看方式」。
- 独立端口关闭（`direct.enabled: false`）时，状态端点 `/__bridge/status` 会抛
  `ReferenceError`（闭包里的 `tls` / `server` 尚未初始化），DSH 的 webserver 把它转成
  400。打包验收时发现，已加回归测试。
- DSH 的 `Principal` 是对象（`{kind:'owner'}`），直接字符串化会把 `[object Object]`
  写进 FBQ 用户表；现映射为系统用户名。

### 固定版本

- FileBrowser Quantum `v2.1.6-beta`（commit `487e52a`）

### 已知限制

- 分享链接的 `http.externalUrl` 只能填一个，两个入口域名不同时会指向配置的那个。
- 仅 Linux 实测；macOS/Windows 分支未验证。
