/**
 * 生成 client/bundle.js。
 *
 * DSH 的浏览器插件协议：bundle 只做一件事——调用
 *   window.__ModuleLoader__.load({ id, factory })
 * 注册一个 lazy CommonJS factory，其中 react 是 platform module。
 * 因此这里把 client/index.js 原样包进 factory，注入 require / module / exports / React，
 * 不做任何打包或依赖解析。
 *
 * 运行：npm run build:client（每次改 client/index.js 后都要跑）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sourcePath = join(root, 'client', 'index.js')
const bundlePath = join(root, 'client', 'bundle.js')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(sourcePath, 'utf8')

const banner = `/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
`

const footer = `
    return module.exports
  }
})
`

const indent = (code) =>
  code
    .split('\n')
    .map((line) => (line.length === 0 ? line : '    ' + line))
    .join('\n')

writeFileSync(bundlePath, banner + indent(source) + footer, 'utf8')
console.log(`built ${bundlePath} (${source.length} source bytes)`)
