# 完整配置参考

改 `~/.dsh/fbq/config.json`，然后 `~/.dsh/start-web.sh restart`。

优先级：插件 row 的 `config`（`cordis.patch.yml`）> 该文件 > 内置默认值。`$DSH_HOME` 默认 `~/.dsh`。

## 进程与二进制

| 键 | 默认 | 说明 |
|---|---|---|
| `fbq.binary` | `null` | 绝对路径时直接用，跳过下载。`null` = 先找 `$DSH_HOME/fbq/bin/<version>/`，再找包内 `vendor/`，最后下载 |
| `fbq.version` | 内置清单版本 | 下载用的 release tag |
| `fbq.allowDownload` | `true` | 允许自动下载（摘要已固定，校验通过才落盘） |
| `fbq.allowUnverifiedDownload` | `false` | 清单里没有该平台摘要时，是否仍允许下载 |
| `fbq.sha256` | `null` | 覆盖内置摘要，仅自建二进制时用 |

## 路径与来源

| 键 | 默认 | 说明 |
|---|---|---|
| `fbq.basePath` | `/-/fbq` | FBQ 的 `http.baseURL`，也是两个前门的路径前缀 |
| `fbq.workspaceRoot` | 进程启动目录 | 未配 `sources` 时的唯一来源目录 |
| `fbq.sources` | `[{name:"workspace", path:"<workspaceRoot>"}]` | 多目录挂载：`[{name, path, defaultPermissions}]` |
| `fbq.dataDir` | `$DSH_HOME/fbq/data` | FBQ 的数据库、缓存、`fbq.yaml` 都在这 |
| `fbq.socketPath` | `<dataDir>/fbq.sock` | FBQ 监听的 Unix socket |
| `fbq.extraConfig` | `{}` | 原样并入生成的 `fbq.yaml`，逃生口 |

## 认证

| 键 | 默认 | 说明 |
|---|---|---|
| `auth.mode` | `proxy` | `proxy` / `password` / `none` |
| `auth.dshGate` | `true` | 同源路由是否强制校验 DSH 会话（关掉等于裸奔，别关） |
| `auth.proxyHeader` | `X-Dsh-User` | 透传给 FBQ 的身份头名 |
| `auth.proxyGroups` | `[]` | 非空则同时注入组头，并把第一个值设为 FBQ 的 `adminGroup` |
| `auth.defaultUser` | `dsh` | 拿不到身份时的兜底用户名 |

三种模式的区别：

| 模式 | 谁认证 | 适用 |
|---|---|---|
| `proxy` | DSH 会话门 + 独立端口口令门，身份头注入 FBQ | 单人自用，进 DSH 免登录 |
| `password` | FBQ 自己的登录页 | 多人各自账号，能用 FBQ 的用户/配额/分享 |
| `none` | 无 | 仅 loopback 调试 |

## 独立端口

| 键 | 默认 | 说明 |
|---|---|---|
| `direct.enabled` | `false` | 开一个自己的监听，让手机/别的电脑访问 |
| `direct.host` / `direct.port` | `127.0.0.1` / `3090` | 监听地址与端口 |
| `direct.readOnly` | `false` | 只放行 `GET/HEAD/OPTIONS/PROPFIND` |
| `direct.requireTlsOnLan` | `true` | 绑非 loopback 时必须 TLS，否则拒绝启动该监听 |
| `direct.tls` | `null` | `null`=复用 `~/.dsh/tls/` 的 DSH 自签证书；`{cert,key}`=指定；`false`=不加密（仅 loopback） |

`direct.username` 默认 `dsh`。`direct.password` 留空时首次启动会生成随机口令并**写回本文件**，日志里也会打一行。

## 客户端与守护

| 键 | 默认 | 说明 |
|---|---|---|
| `client.tabLabel` | `文件` | 内嵌 tab 的标题 |
| `client.tabOrder` | `27` | 对话区 tab 的排序 |
| `fbq.startTimeoutMs` | `30000` | 等 FBQ 就绪的超时 |
| `fbq.restartDelayMs` | `3000` | 崩溃后基础退避（按次数递增） |
| `fbq.maxRestarts` | `5` | 连续重启上限，超过就停手 |
| `fbq.logLines` | `200` | 保留多少行子进程日志（状态端点里能看到最近 20 行） |

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 覆盖 `~/.dsh`，决定配置与数据的根目录 |
| `DSH_FBQ_CONFIG` | JSON 字符串，最高优先级覆盖层。旁路实例/测试用，例如 `{"direct":{"enabled":false},"fbq":{"socketPath":"/tmp/side/fbq.sock"}}` |

## 生成物

`$DSH_HOME/fbq/` 下：

1. `config.json` — 你的配置（插件会写回自动生成的口令）
2. `data/fbq.yaml` — 每次启动按配置重新生成，别手改
3. `data/filebrowser.sqlite` — FBQ 的库：用户、分享、配额
4. `data/fbq.sock` — 前门与 FBQ 之间的 socket
5. `bin/<version>/filebrowser` — 校验过的二进制

## 排查

| 现象 | 看这里 |
|---|---|
| 前门返回 503 `fbq-not-ready` | `GET <basePath>/__bridge/status`，看 `recentLog` |
| 身份串了 / 用户名不对 | 确认 `auth.mode=proxy` 且 `proxyHeader` 与 FBQ 的 `auth.methods.proxy.header` 一致（自动生成的 `fbq.yaml` 里已对齐） |
| 独立端口起不来 | 绑了非 loopback 但没 TLS 证书 → 配 `direct.tls` 或改回 `127.0.0.1` |
