# 发布清单

面向把 `dsh-fbq-bridge` 发布到 npm / GitHub 的操作步骤。发布前逐项打勾。

## 0. 一次性替换占位

| 位置 | 需要改成 |
|---|---|
| `package.json` → 追加 `repository` / `bugs` / `homepage` | 你的 GitHub 仓库地址 |
| `LICENSE` → 版权行 | 你的名字或组织名 |
| `README.md` 顶部的安装命令 | 确认包名与你发布的一致 |

## 1. 发布前检查

```sh
npm run build:client        # 确认 client/bundle.js 是最新的
git diff --exit-code        # 构建产物必须已提交
npm test                    # 34 条测试全绿（不需要 DSH、不需要真 FBQ）
npm pack --dry-run          # 看清单：不能有 vendor/ research/ test/ *.sqlite
```

`npm pack --dry-run` 的期望内容：

```
LICENSE
README.md
client/bundle.js
cordis.patch.yml
package.json
src/*.js
```

## 2. 版本与提交

```sh
git add -A
git commit -m "feat: dsh-fbq-bridge 0.1.0"
git tag v0.1.0
git push origin main --tags
```

## 3. 发布 npm

```sh
npm login
npm publish            # publishConfig.access 已设为 public
```

发布后立刻验证一次真实安装：

```sh
dsh plugin --profile web add dsh-fbq-bridge
~/.dsh/start-web.sh restart
```

然后**刷新页面**，确认：

1. 会话标题右侧出现「📁 文件」按钮，点开右栏能看到 FBQ
2. 右侧栏 `+` → 指南里有「文件 (FBQ)」
3. 对话区顶部有「文件」tab

## 4. 安全相关的发布文案

发布说明里至少要写清楚这几点（README 已写，别删）：

- 插件会在首次使用时**按内置 sha256 校验后**下载 FBQ 二进制（约 29 MB）
- FBQ 只监听 Unix socket，两个前门是它唯一入口
- `proxy` 模式下 FBQ 盲信身份头，**不要**把 `fbq.yaml` 改成监听 TCP
- 插件以你的用户身份运行，不受 DSH 会话文件沙箱限制
- 允许用 `fbq.binary` 指向你自己构建的二进制，完全跳过下载

## 5. 升级 FBQ 版本

1. 改 `scripts/update-binaries.js` 里的版本号并运行（有网时自动拉 release API 的 digest）
2. `npm test`
3. 在真机上冒烟：健康检查、上传、下载、Range、WebDAV
4. 发 patch 版本（例如 0.1.1），CHANGELOG 里写明 FBQ 从哪个版本升到哪个版本

## 6. 已知的发布环境坑

- **pnpm 版本**：DSH profile 的锁文件由 pnpm 11 生成；pnpm 12 会因缺少 integrity 字段拒绝安装。
  这不是本插件的问题，但用户报「装不上」时先问这个。
- **registry 不通**：国内网络下 `registry.npmmirror.com` 偶尔连不上，可临时
  `npm_config_registry=https://registry.npmjs.org/ dsh plugin --profile web add dsh-fbq-bridge`。
