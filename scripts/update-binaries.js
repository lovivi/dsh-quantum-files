'use strict'

/**
 * 重新生成 src/binaries.js 里的固定版本清单。
 *
 *   node scripts/update-binaries.js [version]
 *
 * 从 GitHub Release API 读每个资产的 sha256（asset.digest）并写回清单。
 * 需要网络；只在升级 FBQ 版本时手动跑。
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO = 'gtsteffaniak/filebrowser'

/** GitHub 资产名 → 本机平台键。 */
const NAME_TO_KEY = {
  'linux-amd64-filebrowser': 'linux-x64',
  'linux-arm64-filebrowser': 'linux-arm64',
  'linux-armv6-filebrowser': 'linux-armv6',
  'linux-armv7-filebrowser': 'linux-armv7',
  'linux-riscv64-filebrowser': 'linux-riscv64',
  'darwin-amd64-filebrowser': 'darwin-x64',
  'darwin-arm64-filebrowser': 'darwin-arm64',
  'freebsd-amd64-filebrowser': 'freebsd-x64',
  'filebrowser.exe': 'win32-x64',
}

async function main() {
  const version = process.argv[2]
  if (!version) {
    console.error('用法: node scripts/update-binaries.js <version>，例如 v2.1.6-beta')
    process.exit(1)
  }

  const url = `https://api.github.com/repos/${REPO}/releases/tags/${version}`
  console.log('拉取', url)
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) {
    console.error(`HTTP ${res.status}：${await res.text()}`)
    process.exit(1)
  }
  const release = await res.json()

  const assets = {}
  for (const asset of release.assets || []) {
    const key = NAME_TO_KEY[asset.name]
    if (!key) continue
    const digest = String(asset.digest || '')
    if (!digest.startsWith('sha256:')) {
      console.error(`资产 ${asset.name} 没有 sha256 digest，跳过`)
      continue
    }
    assets[key] = { name: asset.name, size: asset.size, sha256: digest.slice('sha256:'.length) }
  }

  const order = Object.keys(NAME_TO_KEY).map((n) => NAME_TO_KEY[n]).filter((k) => assets[k])
  const lines = []
  lines.push("'use strict'")
  lines.push('')
  lines.push('/**')
  lines.push(' * dsh-quantum-files — 内置的 FBQ 发行版清单')
  lines.push(' *')
  lines.push(' * 由 scripts/update-binaries.js 生成，请勿手工编辑。')
  lines.push(` * 来源：GitHub Release API（${REPO} ${version}）。`)
  lines.push(' */')
  lines.push('')
  lines.push('const PINNED = {')
  lines.push(`  version: ${JSON.stringify(version)},`)
  lines.push(`  repo: ${JSON.stringify(REPO)},`)
  lines.push(`  downloadBaseUrl: 'https://github.com/${REPO}/releases/download',`)
  lines.push('  assets: {')
  for (const key of order) {
    const a = assets[key]
    lines.push(`    ${JSON.stringify(key)}: {`)
    lines.push(`      name: ${JSON.stringify(a.name)},`)
    lines.push(`      size: ${a.size},`)
    lines.push(`      sha256: ${JSON.stringify(a.sha256)},`)
    lines.push('    },')
  }
  lines.push('  },')
  lines.push('}')
  lines.push('')
  lines.push(`/** 本机平台键，例如 linux-x64。 */`)
  lines.push('function platformKey(platform = process.platform, arch = process.arch) {')
  lines.push('  return `${platform}-${arch}`')
  lines.push('}')
  lines.push('')
  lines.push('/** 取本机对应的资产描述；不支持时返回 null。 */')
  lines.push('function assetFor(platform = process.platform, arch = process.arch) {')
  lines.push('  return PINNED.assets[platformKey(platform, arch)] || null')
  lines.push('}')
  lines.push('')
  lines.push('/** 资产下载 URL。 */')
  lines.push('function assetUrl(asset, version = PINNED.version) {')
  lines.push('  return `${PINNED.downloadBaseUrl}/${version}/${asset.name}`')
  lines.push('}')
  lines.push('')
  lines.push('module.exports = { PINNED, platformKey, assetFor, assetUrl }')
  lines.push('')

  const out = path.join(__dirname, '..', 'src', 'binaries.js')
  fs.writeFileSync(out, lines.join('\n'), 'utf8')
  console.log(`已写入 ${out}（${order.length} 个平台）`)
  for (const key of order) console.log(`  ${key.padEnd(14)} ${assets[key].sha256.slice(0, 16)}…`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
