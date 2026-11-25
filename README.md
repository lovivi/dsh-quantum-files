# dsh-fbq-bridge

把 [FileBrowser Quantum](https://filebrowserquantum.com/)（FBQ）以 **sidecar** 方式嵌进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的桥接插件。

三个能力，共用一个 FBQ 实例、一份数据、一套账号：

1. **DSH 内嵌** —— 右侧栏 tab / 对话区 tab，里面是同源 `<iframe>` 的 FBQ 界面
2. **独立端口** —— `https://<host>:<port>/` 直接访问同一个 FBQ（手机 / 别的电脑）
3. **鉴权** —— DSH 会话门（复用 DSH 的浏览器 cookie）+ 独立端口 Basic 口令门；
   身份以 `X-Dsh-User` 头透传给 FBQ（proxy 认证），或让 FBQ 自己管账号（password 认证）

FBQ 本体**只监听 Unix domain socket**，两个前门是它唯一的入口。这样 proxy 认证下
「伪造 header 提权」的路径被物理封死。

```
DSH :3080  /-/fbq/*  → [admit 门] ─┐
                                    ├─→ FBQ（unix socket，baseURL=/-/fbq）
独立 :3090  /-/fbq/*  → [口令门] ──┘     database / sources / 分享 / 配额 / WebDAV
```

## 三个入口

装好并刷新页面后，同一个 FBQ 有三个入口：

| 入口 | 位置 | 说明 |
|---|---|---|
| **会话头按钮「📁 文件」** | 会话标题右侧那一排 | 一键把右侧栏打开到 FBQ（调用 `sidebarRight.openTab('fbq-files')`） |
| **右侧栏 tab** | 右侧栏 → `+` → 指南「文件 (FBQ)」 | 窄栏形态，工具条压缩为 `FBQ｜刷新｜新窗口｜全屏` |
| **对话区 view tab** | 顶部 `Chat｜Trajectory｜…｜文件` | 全宽形态，适合当主文件管理器 |

> 实现提醒：`sidebar.right.pane.tab` 是 **keyed** 槽位，注册选项必须是 `{ name, key }`；
> 传 `id` 会抛 `keyed slot ... requires options.key`，现象是「这类内容还没有可用的查看方式」
> （类型注册成功、body 没注册）。单测 `test/client.test.js` 会按真实契约校验这一点。

## 安装

```sh
# 从 npm（发布后）
dsh plugin --profile web add dsh-fbq-bridge

# 从 GitHub
dsh plugin --profile web add github:<you>/dsh-fbq-bridge

# 本地开发
dsh plugin --profile web add link:/path/to/dsh-fbq-bridge
```

装完执行一次 `~/.dsh/start-web.sh restart`，然后**刷新浏览器页面**。

首次启动会自动下载 FBQ 二进制（约 29 MB，按 `src/binaries.js` 里的固定 sha256 校验），
放到 `$DSH_HOME/fbq/bin/<version>/`。不想让它下载就把二进制放好并用 `fbq.binary` 指过去。

## 配置

配置优先级：插件 row 的 `config` > `$DSH_HOME/fbq/config.json` > 内置默认值。
（`$DSH_HOME` 默认 `~/.dsh`；nix 环境可用 `DSH_HOME` 覆盖）

最小配置 `~/.dsh/fbq/config.json`：

```json
{
  "fbq": { "workspaceRoot": "/home/me/work/my-project" },
  "auth": { "mode": "proxy" },
  "direct": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3090,
    "requireTlsOnLan": true,
    "username": "dsh"
  }
}
```

首次启动若 `direct.password` 未配置，插件会自动生成一个随机口令**并写回该文件**，
日志里也会打一行。独立端口绑定非 loopback 时强制要求 TLS：优先用 `direct.tls`
指定的证书，否则复用 `~/.dsh/tls/` 下的 DSH 自签证书；两者都没有就拒绝启动该监听
（可用 `direct.requireTlsOnLan: false` 绕过，不建议）。

### 关键配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `fbq.binary` | `null` | `null` = 用自动下载/包内自带；也可给绝对路径（完全跳过下载） |
| `fbq.version` | 内置清单版本 | 自动下载使用的 release tag |
| `fbq.allowDownload` | `true` | 是否允许自动下载二进制（摘要已固定） |
| `fbq.allowUnverifiedDownload` | `false` | 清单里没有摘要时是否仍允许下载（默认拒绝） |
| `fbq.sha256` | `null` | 覆盖内置摘要，仅自建二进制时用 |
| `fbq.basePath` | `/-/fbq` | FBQ 的 `http.baseURL`，也是两个前门的路径前缀 |
| `fbq.sources` | 自动单 source | `[{name, path, defaultPermissions}]`；默认指向 `workspaceRoot` |
| `fbq.extraConfig` | `{}` | 原样并入生成的 `fbq.yaml`（逃生口） |
| `auth.mode` | `proxy` | `proxy` / `password` / `none` |
| `auth.proxyHeader` | `X-Dsh-User` | 透传给 FBQ 的身份头名 |
| `auth.proxyGroups` | `[]` | 非空则注入组头，并把第一个值设为 FBQ 的 `adminGroup` |
| `auth.dshGate` | `true` | 同源路由是否强制校验 DSH 会话 |
| `direct.readOnly` | `false` | 只读：只放行 `GET/HEAD/OPTIONS/PROPFIND` |
| `direct.requireTlsOnLan` | `true` | 绑非 loopback 时必须 TLS |
| `direct.tls` | `null` | `null`=自动复用 DSH 证书；`{cert,key}`=指定；`false`=不加密（仅 loopback） |
| `client.tabLabel` | `文件` | 内嵌 tab 标题 |

### 三种认证模式

| 模式 | 谁认证 | 适用 |
|---|---|---|
| `proxy`（默认） | DSH 会话门 + 独立端口口令门，身份头注入 FBQ | 单用户 SSO，进 DSH 免登录 |
| `password` | FBQ 自己的登录页（多用户 / 配额 / 分享） | 多人共用，希望各自有账号 |
| `none` | 无 | 仅 loopback 调试 |

> `proxy` 模式下 FBQ 是**盲信身份头**的（这是 FBQ 的文档明示行为），所以插件强制 FBQ
> 只绑 socket，并在反代层丢弃浏览器自带的同名头。**不要**把 `fbq.yaml` 改成让 FBQ 监听
> TCP —— 那等于把管理员权限挂在网上。

## 运行时

- 生成物都在 `$DSH_HOME/fbq/`：`config.json`（你的配置）、`data/fbq.yaml`（自动生成）、
  `data/fbq.sock`、`data/filebrowser.sqlite`、`bin/<version>/filebrowser`
- 崩溃自动重启（指数退避，上限 `fbq.maxRestarts`）
- 插件卸载 / DSH 退出时 SIGTERM → 等待 → SIGKILL，并清理 socket

状态端点：`GET <basePath>/__bridge/status`（同源路由带 DSH 会话，独立端口带口令）

## 测试

```sh
npm test          # 34 条用例，全部不需要 DSH、不需要真 FBQ
```

| 文件 | 覆盖 |
|---|---|
| `test/unit.test.js` | 头过滤、身份头丢弃/覆盖、CSP `frame-ancestors` 剥离、`admit` 三态、Basic 口令、只读白名单、配置生成 |
| `test/client.test.js` | 在假 DOM + 假 slots 里执行 `client/bundle.js`，按**真实槽位契约**校验三个入口的注册（keyed 必须给 `key`、list 必须给 `id`） |
| `test/integration.test.js` | 用假上游（unix socket）跑通两个前门：fail-closed、身份注入、伪造防护、Range、大 body、PROPFIND、502、独立端口口令与只读 |

### 需要真环境的验证

```sh
node scripts/build-client.mjs             # 改完 client/index.js 必须重跑（CI 会检查是否同步）
node scripts/dev-server.js --port 3091    # 起真 FBQ + 反代，不依赖 DSH
node scripts/verify.js --base http://127.0.0.1:3091   # 对跑起来的端点压集成用例
node scripts/update-binaries.js v2.1.6-beta            # 升级 FBQ 版本时重建摘要清单
```

## 安全

- 插件运行在 DSH 宿主进程内，**不受会话文件沙箱（workspace-write）限制**，能读整盘。
- `proxy` 模式的身份头只由插件注入；FBQ 侧若被改成监听 TCP 就等同于把管理员权限暴露出去。
- 自动下载的二进制按内置 sha256 校验；清单外的平台默认拒绝下载。
- 本插件不收集遥测、不主动联网（除首次下载二进制）。

## 目录结构

```
src/                host 平面：config / binaries / supervisor / proxy / gate / direct / index
client/             client 平面：index.js（源码）+ bundle.js（构建产物，必须提交）
scripts/            build-client / dev-server / verify / update-binaries
test/               unit / client / integration 三层测试
docs/PLAN.md        设计与测试计划
docs/PUBLISHING.md  发布清单
docs/shots/         README 用的实机截图
```

## 已知限制

- 分享链接的绝对地址由 FBQ 的 `http.externalUrl` 决定，**只能填一个**；两个入口域名不同时，
  另一边的分享链接会指向配置的那个。
- 内嵌 tab 里 FBQ 是完整应用界面，右栏/窄屏下会比较挤，工具条提供「全屏」。
- 不在 `proxy` 模式下时，插件不注入身份，FBQ 侧需要一个可用的登录方式。
- 仅 Linux 实测；macOS/Windows 的二进制分支与清单已备好但未验证。
- FBQ 版本固定在 `src/binaries.js`；升级要走 `scripts/update-binaries.js` 并重新冒烟。

## License

MIT。运行时下载的 FileBrowser Quantum 为 Apache-2.0，遵循其自身许可。
