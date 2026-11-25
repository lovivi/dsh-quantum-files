# 发布清单

总耗时约 20 分钟（不含 npm 排队）。按顺序做，每步都能独立验证。

## 1. 替换占位（5 分钟）

| 位置 | 改成 |
|---|---|
| `package.json` | 加 `repository` / `bugs` / `homepage` 三个字段，填你的仓库地址 |
| `LICENSE` 第 3 行 | 你的名字或组织名 |
| `README.md` 第一段 | 确认包名与你实际发布的一致 |

改完 `git diff` 看一眼，别把 token 或私有路径带进去。

## 2. 本地验收（3 分钟）

```sh
npm run build:client
git diff --exit-code        # bundle 必须已提交，否则公开发布会缺文件
npm test                    # 34 条，不到 1 秒
npm pack --dry-run          # 看清单
```

`npm pack` 期望 12 个文件、约 23 KiB：

```
LICENSE  README.md  package.json
client/bundle.js  cordis.patch.yml
src/{index,config,binaries,supervisor,proxy,gate,direct}.js
```

出现 `vendor/`、`research/`、`test/` 或 `*.sqlite` 就是 `files` 白名单被改坏了。

## 3. 提交并打 tag（2 分钟）

```sh
git add -A
git commit -m "docs: 面向发布重写说明"
git tag v0.1.0
git push origin main --tags
```

## 4. 发布 npm（5 分钟）

```sh
npm login
npm publish         # publishConfig.access 已是 public
```

## 5. 用真实安装验一遍（5 分钟）

```sh
dsh plugin --profile web add dsh-fbq-bridge
~/.dsh/start-web.sh restart
```

刷新页面，确认三件事：

1. 会话标题右侧有「📁 文件」按钮，点开右栏出现 FBQ 界面
2. 右侧栏 `+` → 指南里有「文件 (FBQ)」
3. 对话区顶部有「文件」tab

三条都中就算发布成功。中不了先看 `~/.dsh/logs/dsh-web.log` 里 `[dsh-fbq-bridge]` 开头的行。

## 发布文案里必须保留的四句

1. 首次使用会按内置 sha256 校验后下载 FBQ 二进制（约 29 MB）
2. FBQ 只监听 Unix socket，两个前门是唯一入口
3. `proxy` 模式下 FBQ 盲信身份头，不要把 `fbq.yaml` 改成监听 TCP
4. 插件以你的用户身份运行，不受 DSH 会话文件沙箱限制

## 升级 FBQ 版本（每次约 15 分钟）

```sh
node scripts/update-binaries.js v2.1.7-beta
npm test
```

然后在本机冒烟四项：健康检查、上传、下载（Range 拖一下视频）、WebDAV。四项都过再发 patch 版本，CHANGELOG 里写清从哪个 FBQ 版本升到哪个。

## 两个环境坑（用户报「装不上」时先问这个）

1. **pnpm 12** 会因为旧锁文件缺 integrity 字段拒绝安装。让用户 `npm i -g pnpm@11.1.3`。
2. **registry 不通**（国内常见）。让用户加环境变量：
   `npm_config_registry=https://registry.npmjs.org/ dsh plugin --profile web add dsh-fbq-bridge`
