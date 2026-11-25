# dsh-fbq-bridge — 方案与测试计划

> 把 FileBrowser Quantum（下称 FBQ）作为 sidecar 嵌进 DeepSeek Harness，
> 提供「DSH 内嵌使用 + 独立端口访问 + 可配置鉴权」三种能力，共用同一个 FBQ 实例。

- 状态：已实现，v0.1.0 已发布（本文保留为设计与测试依据）
- 日期：2026-11-24
- 目标环境：Linux x86_64，DSH 0.2.1-rc.3，Node 22，FBQ v2.1.6-beta

---

## 1. 目标与验收标准

### 1.1 功能目标

| # | 需求 | 验收标准 |
|---|---|---|
| F1 | DSH 内嵌可用 | DSH Web 对话区内出现「文件」tab，点击后全宽渲染 FBQ 界面，可浏览/上传/下载/预览/管理 |
| F2 | 独立端口可用 | `https://<host>:<port>/` 直接访问同一个 FBQ，数据与 F1 完全一致 |
| F3 | 鉴权 | 两种模式可配：`password`（FBQ 自带账号体系，支持多用户）与 `proxy`（DSH 身份透传 + 独立端口口令门） |
| F4 | 单实例 | 两入口共用一份 FBQ 进程、一份数据库、一套用户/分享/配额 |
| F5 | 生命周期 | 插件加载即启动 FBQ；插件卸载/DSH 退出即回收；FBQ 崩溃自动重启 |
| F6 | 零手工 | 二进制自动获取（带 sha256 校验）、配置自动生成，用户只需改少量配置项 |

### 1.2 非目标（明确不做）

- 不重写 FBQ 功能（分享/配额/ACL/WebDAV/OnlyOffice 全部原样来自 FBQ）
- 不实现多入口的分享链接域名改写（见 §6 R3）
- 不支持 Windows/macOS 的完整验证（代码保留分支，仅在 Linux 上验收）

### 1.3 安全基线

- FBQ **只绑 Unix domain socket**，绝不监听 TCP 网卡（`proxy` 模式下这是硬要求，见 §6 R1）
- 独立端口默认强制 TLS；口令以 scrypt/sha256 存于配置文件
- 所有写入类 HTTP 方法在独立端口可按配置降级为只读

---

## 2. 架构

```
                         ┌──────────────────────────────┐
   DSH Web :3080  ───────┤ /-/fbq/*  → webServer 路由    │
   （conversation.view）  │   ① ctx.connection.admit()    │──┐
                         │   ② 可选注入 X-Dsh-User        │  │
                         └──────────────────────────────┘  │
                                                           ├──► FBQ 单实例
                         ┌──────────────────────────────┐  │    unix socket
   独立端口 :<port> ──────┤ 插件自有 http(s) 监听         │  │    baseURL=/-/fbq
   （浏览器/手机）         │   ① 口令门                    │──┘    database + sources
                         │   ② 可选注入 X-Dsh-User        │
                         └──────────────────────────────┘
```

**关键设计**：两个前门把请求以**完全相同的路径前缀** `/-/fbq/...` 转发给 FBQ，
不做任何路径重写。FBQ 内部生成的静态资源、跳转、分享链接在两边一致，
避免 baseURL 重写导致的双前缀问题。

独立端口额外把 `GET /` 302 到 `/-/fbq/`，所以打开根路径即可进入。

---

## 3. 组件清单

### 3.1 Host 平面（`src/index.js`）

| 模块 | 职责 |
|---|---|
| `config.js` | 读 `$DSH_HOME/fbq/config.json` + 插件 row config 覆盖；校验；生成 FBQ 的 `fbq.yaml` |
| `binary.js` | 按 `platform-arch` 选 release asset；下载到 `$DSH_HOME/fbq/bin/<ver>/`；sha256 校验；`chmod +x` |
| `supervisor.js` | spawn FBQ、健康检查（socket 可连 + `/api/health` 或首页 200）、崩溃指数退避重启、`ctx.effect` 卸载时 SIGTERM→SIGKILL |
| `proxy.js` | 通用反代：`http.request({ socketPath })`，透传 method/headers/body/Range，剔除 hop-by-hop 头，不缓冲 body |
| `gate.js` | DSH 门：`ctx.connection.admit()` / `requestRejection()`；独立端口门：口令校验 + TLS + 可选只读 |
| `index.js` | 组装：注册 `/-/fbq` prefix 路由 + 启动独立监听；暴露 `ctx.fbqBridge` 状态服务供 UI 读取 |

### 3.2 Client 平面（`client/index.js` → `client/bundle.js`）

| 模块 | 职责 |
|---|---|
| tab | 通过 `ctx.slots.inject('conversation.view', …)` 注册「文件」tab（order 可配） |
| iframe | 全宽 `<iframe src="/-/fbq/">`；`allow="clipboard-read; clipboard-write"` |
| 工具条 | 刷新、全屏、在独立端口打开、状态指示（FBQ 启动中/就绪/崩溃） |

客户端零依赖，走 `window.__ModuleLoader__.load({ id, factory })` 静态 bundle 协议，
`require("react")` 取 platform module（同 `@weibaohui/dsh-file-share` 的做法）。

### 3.3 目录结构

```
03_dshfile/
├─ docs/PLAN.md
├─ vendor/filebrowser              # 二进制（自动下载）
├─ package.json                    # name: dsh-fbq-bridge
├─ cordis.patch.yml                # insert 插件 row
├─ src/{index,config,binary,supervisor,proxy,gate}.js
├─ client/{index.js,bundle.js}
├─ scripts/build-client.mjs
├─ scripts/dev-server.js           # 带真 FBQ 的旁路 harness（不依赖 DSH）
├─ scripts/verify.js               # 对跑起来的端点压端到端用例
└─ test/{unit,client,integration}.test.js
```

---

## 4. 鉴权设计

三种模式，配置项 `auth.mode`：

### 4.1 `password`（默认推荐，支持多用户）

- FBQ `authentication.method: password`
- 两个前门都是纯透传；用户在 DSH 内嵌页看到 FBQ 登录页（DSH 已登录仍需再登一次 FBQ）
- 用户/配额/分享/ACL 全由 FBQ 管理
- 独立端口 = 同一套账号

### 4.2 `proxy`（单用户 SSO，体验最好）

- FBQ `authentication.method: proxy`，`header: X-Dsh-User`
- DSH 门：`admit()` → `peer.principal` → 注入 `X-Dsh-User`
- 独立端口：口令门通过后注入固定身份（配置 `auth.directPort.user`）
- **前提**：FBQ 只绑 socket；否则任何人伪造 header 即可提权

### 4.3 `none`（仅 loopback 调试）

- 独立端口不启用；FBQ `noauth`；只允许 `127.0.0.1` 访问 DSH 门

### 4.4 独立端口的额外限制（可配）

| 配置 | 作用 |
|---|---|
| `direct.readOnly` | 拦掉 `POST/PUT/PATCH/DELETE/MKCOL/MOVE/COPY/PROPPATCH`（放行 `GET/HEAD/OPTIONS/PROPFIND`） |
| `direct.password` | 口令（明文存储仅允许 loopback 场景；默认存 sha256） |
| `direct.tls.{cert,key}` | 证书；缺省则拒绝绑定非 loopback 地址 |

---

## 5. 配置契约

`$DSH_HOME/fbq/config.json`（可被插件 row 的 `config` 覆盖）：

```jsonc
{
  "fbq": {
    "version": "v2.1.6-beta",
    "binary": null,                    // null = 自动下载；或给绝对路径
    "socket": "/run/user/1000/dsh-fbq.sock",
    "basePath": "/-/fbq",
    "database": "~/.dsh/fbq/fbq.db",
    "sources": [{ "name": "workspace", "path": "~/work/appdev/03_dshfile", "readOnly": false }],
    "extraConfig": {}                  // 原样并入 fbq.yaml，逃生口
  },
  "auth": {
    "mode": "password",                // password | proxy | none
    "proxyHeader": "X-Dsh-User",
    "proxyDefaultUser": "dsh"
  },
  "direct": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3090,
    "readOnly": false,
    "passwordHash": null,              // scrypt:<salt>:<hash>
    "tls": { "cert": "~/.dsh/tls/cert.pem", "key": "~/.dsh/tls/key.pem" }
  },
  "client": { "tabLabel": "文件", "tabOrder": 27 }
}
```

优先级：`row config` > `config.json` > 内置默认值。

---

## 6. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | `proxy` 模式下 FBQ 盲信 header | 任何人伪装管理员 | FBQ 只绑 socket；socket 文件权限 0600；启动前断言未监听 TCP |
| R2 | `admit()` 在非 `/api` 路由上的行为未验证 | 鉴权门失效或误拦 | **测试计划第 2 阶段首要验证项**；失败则退化为「校验 DSH cookie 名+密钥」自定义实现 |
| R3 | 分享链接的 `externalUrl` 只能填一个 | 另一入口链接指向错误域名 | 文档告知；后续可在反代层改写 Location/HTML 中的绝对地址 |
| R4 | 二进制供应链 | 执行未经验证的代码 | 固定 version + sha256 + 首次安装需显式 `allowDownload: true` |
| R5 | iframe 被 FBQ 响应头拦 | 内嵌白屏 | 反代层剥离 `X-Frame-Options` / `frame-ancestors`（同源，安全可接受） |
| R6 | Unix socket 残留 | 重启失败 | 启动前 unlink 残留 socket；SIGTERM 后等待进程退出再清 |
| R7 | DSH 宿主重启会中断当前会话 | 安装期风险 | 开发/验证全部在旁路实例（:3081）；仅最后一步切线上 |

---

## 7. 测试计划

### 阶段 0 — 前置冒烟（不写插件）

| 用例 | 方法 | 通过标准 |
|---|---|---|
| T0.1 二进制可运行 | `./vendor/filebrowser version` | 输出 v2.1.6-beta |
| T0.2 socket + baseURL 启动 | 手动起 FBQ，curl socket | `GET /-/fbq/` 返回 HTML，静态资源 200 |
| T0.3 子路径完整性 | curl 首页 HTML 提取资源路径 | 所有资源 URL 以 `/-/fbq/` 开头 |
| T0.4 帧头 | `curl -I` 检查 `X-Frame-Options`/CSP | 记录实际值，决定 R5 是否触发 |

### 阶段 1 — 反代单元测试（`test/unit.test.js` + `test/integration.test.js`）

用 mock upstream（node http server）验证，不依赖 FBQ：

| 用例 | 断言 |
|---|---|
| T1.1 方法透传 | `GET/POST/PUT/DELETE/PROPFIND/MKCOL` 全部到达 upstream，method 不变 |
| T1.2 头部透传 | `Range`/`Content-Type`/`Cookie`/`Authorization` 到达；`Connection`/`Keep-Alive`/`Transfer-Encoding` 被剔除 |
| T1.3 响应头透传 | `Content-Range`/`ETag`/`Set-Cookie` 回传；帧头被剥离 |
| T1.4 大 body 流式 | 100 MiB 上传不驻留内存（RSS 增量 < 50 MiB），耗时线性 |
| T1.5 Range | `Range: bytes=100-199` → upstream 收到同样头，响应 206 + `Content-Range` 回传 |
| T1.6 客户端中断 | 发送方 abort 后 upstream 连接关闭，无句柄泄漏 |
| T1.7 上游不可达 | 返回 502 且不崩溃 |

### 阶段 2 — 鉴权测试（`test/unit.test.js` + `test/integration.test.js`）

| 用例 | 断言 |
|---|---|
| T2.1 `admit()` 可用性 | 构造带有效 DSH cookie 的请求 → 放行；无 cookie → 401 |
| T2.2 跨站拒绝 | `sec-fetch-site: cross-site` → 403 |
| T2.3 口令门 | 独立端口无口令 → 401；错口令 → 401；对口令 → 200 |
| T2.4 只读模式 | `direct.readOnly` 下 `POST/PUT/DELETE/MKCOL/PROPFIND` 的处置符合预期（PROPFIND 放行） |
| T2.5 proxy 注入 | DSH 门注入 `X-Dsh-User: owner`；客户端伪造同名头被覆盖 |
| T2.6 头伪造防护 | 客户端自带 `X-Dsh-User: admin` → 被重写，不能提权 |

### 阶段 3 — 集成测试（真实 FBQ）

| 用例 | 断言 |
|---|---|
| T3.1 端到端浏览 | 经反代 `GET /-/fbq/` 200，HTML 与阶段 0 一致 |
| T3.2 上传下载 | 经反代上传 10 MiB 文件 → 落盘校验 sha256；下载回来一致 |
| T3.3 ZIP 下载 | 目录下载返回 `application/zip`，解压校验 |
| T3.4 视频 Range | 拖动式多段 Range 请求全部 206，拼回后 sha256 一致 |
| T3.5 WebDAV | `PROPFIND /-/fbq/webdav` 返回 207 multistatus |
| T3.6 分享链接 | 创建 share → 匿名访问该链接可用；删除后 404 |
| T3.7 双入口一致性 | 同一文件经 3080 门与 3090 门读取，字节一致；分享链接两入口都能开 |
| T3.8 崩溃恢复 | `kill -9` FBQ → 插件在退避后重启，`/-/fbq/` 恢复 200 |
| T3.9 卸载清理 | 停插件 → FBQ 进程退出、socket 文件被清、无残留子进程 |

### 阶段 4 — DSH 内真实加载（旁路实例 :3081）

| 用例 | 断言 |
|---|---|
| T4.1 插件加载 | 日志无报错，Loader 中出现 `dsh-fbq-bridge` row |
| T4.2 客户端 bundle | `GET /plugins/...` 返回 bundle，浏览器控制台无错 |
| T4.3 tab 出现 | 对话区出现「文件」tab（人工确认） |
| T4.4 iframe 可用 | tab 内 FBQ 界面渲染、可点击（人工确认） |
| T4.5 与现有插件共存 | better-sidebar 等已装插件不报错、不冲突 |

### 阶段 5 — 回归与切换

| 用例 | 断言 |
|---|---|
| T5.1 旧会话可用 | 重启后历史会话正常打开 |
| T5.2 端口/证书 | 3080 TLS 正常；3090 TLS 正常 |
| T5.3 回滚 | 从 profile 移除插件后 DSH 正常启动 |

**自动化入口**：`npm test` 覆盖阶段 0–3 中可脱离环境的部分（34 条用例，不到 1 秒，纯 Node），
其中：

- `test/unit.test.js` — 头处理、鉴权门、配置生成
- `test/client.test.js` — 在假 DOM 里执行 `client/bundle.js`，按**真实槽位契约**校验三个入口的注册
- `test/integration.test.js` — 假上游 unix socket，跑通两个前门（T0.x/T1.x/T2.x/T3.x 的可自动化子集）

不可自动化的部分（阶段 4 的视觉确认、阶段 5 的切换）由 `scripts/dev-server.js` + `scripts/verify.js` + 浏览器实测完成。

---

## 8. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M0 | 二进制 + 手动 FBQ 验证 | `vendor/filebrowser` 可运行，配置跑通 |
| M1 | proxy/binary/supervisor 骨架 | 能起停 FBQ，反代可用 |
| M2 | gate + 双前门 | 鉴权三种模式工作 |
| M3 | client tab | DSH 内嵌可用 |
| M4 | 测试全绿 + 安装 | profile 装载，旁路实例验证 |
| M5 | 切线上 | 重启 `dsh-web.service`，交付访问说明 |

**实际完成情况**：M0–M5 全部完成。验收时用无头 chromium 实测了三个入口（会话头按钮、
右侧栏 guide、对话区 tab），截图见 `docs/shots/`。过程中修复了两个真问题：

1. `sidebar.right.pane.tab` 是 keyed 槽位，必须传 `key` 而不是 `id`——传错时类型注册成功、
   body 没注册，界面显示「这类内容还没有可用的查看方式」。
2. DSH 的 `Principal` 是对象（`{kind:'owner'}`），直接字符串化会把 `[object Object]` 写进
   FBQ 用户表；现映射为系统用户名。

这两条都已加入单测断言，防止回归。
