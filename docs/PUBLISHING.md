# 发布清单

总耗时约 30 分钟（不含审核排队）。按顺序做，每步都能独立验证。

## 0. 先搞清楚分发渠道（3 分钟读完）

**DSH 没有官方插件市场。** 官方市场 bundle 的 README 原话：

> There is no official market; Discover lists only the index sources the user adds.

所以分发靠三条路，互不冲突，可以都做：

| 渠道 | 用户怎么装 | 你要做什么 |
|---|---|---|
| **npm（主渠道）** | `dsh plugin --profile web add dsh-quantum-files` | `npm publish` |
| **GitHub** | `dsh plugin --profile web add github:lovivi/dsh-quantum-files` | 推仓库，不用发布 |
| **社区市场索引** | Plugins → Discover → 添加索引 URL | 往索引仓库提 PR（见第 6 步） |

两条硬要求（缺了装上也白装）：

1. `package.json` 必须声明 `dsh.bundle`。插件管理器源码里写得很直白：没有它就把包当作
   "installed as a plain dependency, not a profile layer"，即装了也不会进组合。
2. `dsh.client.platform = "web"` 且导出 `./client`，否则界面上不会有任何入口。

装的时候管理器会**自动把包名追加到 `dsh.profile.bundles`**（实测：`dsh plugin add` 一个
tarball 之后，profile 的 `package.json` 自己多了这一条），不用手工改。

## 1. 替换占位（5 分钟）

| 位置 | 改成 |
|---|---|
| `package.json` | 加 `repository` / `bugs` / `homepage`，填你的仓库地址 |
| `LICENSE` 第 3 行 | 你的名字或组织名 |
| `README.md` 第一段 | 确认包名与实际发布一致 |

## 2. 本地验收（3 分钟）

```sh
npm run build:client
git diff --exit-code        # bundle 必须已提交
npm test                    # 36 条，不到 1 秒
npm pack --dry-run          # 12 个文件、约 23 KiB
```

`npm pack` 里出现 `vendor/`、`research/`、`test/` 或 `*.sqlite` 就是 `files` 白名单被改坏了。

## 3. 打包验收（5 分钟，别跳过）

把 tarball 装进一个**独立 profile**，确认它真能跑——这一步能抓到 `npm test` 抓不到的
组合问题（本轮就靠它抓到了「独立端口关闭时状态端点抛异常」）。

```sh
npm pack --pack-destination /tmp/pack
dsh --profile pkgverify --from-default-profile web --dump-config > /dev/null
dsh plugin --profile pkgverify add /tmp/pack/dsh-quantum-files-0.1.0.tgz
dsh --profile pkgverify --dump-config | grep -A2 quantum-files   # 组合里有这一行才算成功
```

通过标准（四条都中）：

1. `--dump-config` 里出现 `- id: quantum-files`
2. 启动后 `~/.dsh/fbq/data/fbq.sock` 出现（说明 FBQ 被拉起）
3. `GET /-/fbq/` 带 DSH cookie 返回 200，不带 cookie 返回 401
4. `GET /-/fbq/__bridge/status` 返回 200 的 JSON

验收完删掉：`rm -rf ~/.dsh/profiles/pkgverify`。

## 4. 提交并打 tag（2 分钟）

```sh
git add -A
git commit -m "fix: 独立端口关闭时状态端点抛异常"
git tag v0.1.1        # 首个版本用 v0.1.0（git tag -f 移到当前提交）
git push origin main --tags
```

## 5. 发布 npm（5 分钟）

```sh
npm login
npm publish         # publishConfig.access 已是 public
```

用真实安装验一遍：

```sh
dsh plugin --profile web add dsh-quantum-files
~/.dsh/start-web.sh restart
```

刷新页面，确认三件事：

1. 会话标题右侧有「📁 文件」按钮，点开右栏出现 FBQ 界面
2. 右侧栏 `+` → 指南里有「文件 (FBQ)」
3. 对话区顶部有「文件」tab

三条都中就算发布成功。中不了看 `~/.dsh/logs/dsh-web.log` 里 `[dsh-quantum-files]` 开头的行。

## 6. 上社区清单（可选，10 分钟）

社区索引维护在 `awesome-dsh-plugin`（同时以 npm 包 `dsh-plugin-catalog` 分发）。收录条件
来自清单 README：

1. 能用 `dsh plugin add` 装上
2. 描述与实际行为相符（合并前有人对着源码核）
3. 分类正确
4. 还在维护

提 PR 时提交的就是一条 format 1 索引条目，字段结构从 `dsh-plugin-catalog` 的
`index.json` 实测得来：

```json
{
  "name": "dsh-quantum-files",
  "title": "lovivi/dsh-quantum-files",
  "description": {
    "en": "Embed FileBrowser Quantum into DSH: right-sidebar tab, conversation tab, a separate TLS port, and DSH-session auth.",
    "zh": "把 FileBrowser Quantum 嵌进 DSH：右侧栏 tab、对话区 tab、独立 TLS 端口，复用 DSH 会话鉴权。"
  },
  "homepage": "https://github.com/lovivi/dsh-quantum-files",
  "repository": { "url": "https://github.com/lovivi/dsh-quantum-files" },
  "metadata": {
    "category": "ui",
    "keywords": ["filebrowser", "file-manager"],
    "labels": [],
    "sortKeys": {}
  },
  "versions": [
    {
      "version": "0.1.0",
      "publishTimestamp": 1794000000,
      "source": { "type": "npm" },
      "engines": { "node": ">=20" }
    }
  ]
}
```

`category` 用清单里的 slug：本插件建议 **`ui`（UI Enhancements）**，备选 `tools`。

## 6.5 补 CI 工作流（可选，2 分钟）

首次推仓库时如果 token 没有 `workflow` scope，`.github/workflows/ci.yml` 会被 GitHub
拒绝推送（OAuth App 不允许创建/更新 workflow 文件）。补上：

```sh
gh auth refresh -h github.com -s workflow
git add -f .github/workflows/ci.yml
git commit -m "ci: 启用 GitHub Actions"
git push
```

## 7. 升级 FBQ 版本（每次约 15 分钟）

```sh
node scripts/update-binaries.js v2.1.7-beta
npm test
```

然后本机冒烟四项：健康检查、上传、下载（拖一下视频验 Range）、WebDAV。四项都过再发 patch
版本，CHANGELOG 里写清从哪个 FBQ 版本升到哪个。

## 发布文案里必须保留的四句

1. 首次使用会按内置 sha256 校验后下载 FBQ 二进制（约 29 MB）
2. FBQ 只监听 Unix socket，两个前门是唯一入口
3. `proxy` 模式下 FBQ 盲信身份头，不要把 `fbq.yaml` 改成监听 TCP
4. 插件以你的用户身份运行，不受 DSH 会话文件沙箱限制

## 两个环境坑（用户报「装不上」时先问这个）

1. **pnpm 12** 会因为旧锁文件缺 integrity 字段拒绝安装。让用户 `npm i -g pnpm@11.1.3`。
2. **registry 不通**（国内常见）。让用户加环境变量：
   `npm_config_registry=https://registry.npmjs.org/ dsh plugin --profile web add dsh-quantum-files`
