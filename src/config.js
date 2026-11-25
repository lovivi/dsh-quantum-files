'use strict'

/**
 * dsh-fbq-bridge — 配置解析
 *
 * 优先级：插件 row 的 config（cordis.patch.yml） > $DSH_HOME/fbq/config.json > 内置默认值。
 * 任何一项都可以只写一部分，其余落到默认值。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

function expandHome(p) {
  if (typeof p !== 'string' || p === '') return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

const DEFAULTS = {
  fbq: {
    // 二进制：null = 用内置 vendor/filebrowser，缺失时按 fbq.version 下载
    binary: null,
    version: null, // null = 用 src/binaries.js 里的 PINNED.version
    // 允许自动下载二进制（摘要已在 src/binaries.js 里固定，故默认开启）
    allowDownload: true,
    // 清单里没有的平台/摘要对不上时，是否允许无校验下载（默认拒绝）
    allowUnverifiedDownload: false,
    downloadBaseUrl: 'https://github.com/gtsteffaniak/filebrowser/releases/download',
    sha256: null, // 可选：下载后校验
    dataDir: null, // null = $DSH_HOME/fbq/data
    socketPath: null, // null = <dataDir>/fbq.sock
    basePath: '/-/fbq',
    // 暴露给 FBQ 的一个或多个 source
    sources: [], // 空 = 自动单 source 指到 workspaceRoot
    workspaceRoot: null, // null = 进程 cwd
    trustProxyHeaders: true,
    extraConfig: {}, // 原样并入 fbq.yaml（逃生口）
    startTimeoutMs: 30000,
    restartDelayMs: 3000,
    maxRestarts: 5,
    logLines: 200,
  },
  auth: {
    // 'proxy'   = DSH 身份透传（推荐，单用户 SSO）
    // 'password'= FBQ 自带账号体系（多用户）
    // 'none'    = 不做身份注入（仅调试；FBQ 侧配 noauth 时才有意义）
    mode: 'proxy',
    proxyHeader: 'X-Dsh-User',
    proxyGroupsHeader: 'X-Dsh-Groups',
    proxyGroups: [], // 为空则不注入组头
    defaultUser: 'dsh',
    // DSH 同源路由上是否强制校验 DSH 会话（admit）
    dshGate: true,
  },
  direct: {
    enabled: false,
    host: '127.0.0.1',
    port: 3090,
    readOnly: false,
    // 绑定非 loopback 时必须有口令与 TLS，否则拒绝启动独立监听
    requireTlsOnLan: true,
    username: 'dsh',
    password: null, // null = 自动生成并写回配置文件
    tls: null, // { cert, key }；null 且 requireTlsOnLan 时会尝试复用 $DSH_HOME/tls
  },
  client: {
    tabLabel: '文件',
    tabOrder: 27,
    showToolbar: true,
  },
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out
}

function readConfigFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : {}
  } catch (e) {
    if (e && e.code === 'ENOENT') return {}
    throw new Error(`dsh-fbq-bridge: 无法解析配置文件 ${file}: ${e.message}`)
  }
}

function resolvePath(p, base) {
  if (typeof p !== 'string' || p === '') return p
  const expanded = expandHome(p)
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded)
}

/**
 * @param {object} rowConfig 插件 row 的 config（可能为空）
 * @returns 规范化后的配置对象
 */
function loadConfig(rowConfig, options) {
  const opts = options || {}
  const home = dshHome()
  const homeDir = path.join(home, 'fbq')
  const file = path.join(homeDir, 'config.json')
  // skipFile: 单测用 —— 不读用户真实配置，只看默认值 + rowConfig
  const fromFile = opts.skipFile ? {} : readConfigFile(file)

  // 环境覆盖层（旁路实例/测试用）：DSH_FBQ_CONFIG='{"fbq":{"socketPath":"..."}}'
  let fromEnv = {}
  if (process.env.DSH_FBQ_CONFIG) {
    try {
      fromEnv = JSON.parse(process.env.DSH_FBQ_CONFIG)
    } catch (e) {
      throw new Error(`DSH_FBQ_CONFIG 不是合法 JSON: ${e.message}`)
    }
  }

  const cfg = deepMerge(deepMerge(deepMerge(DEFAULTS, fromFile), rowConfig || {}), fromEnv)

  cfg.paths = {
    home,
    homeDir,
    configFile: file,
    dataDir: resolvePath(cfg.fbq.dataDir || path.join(homeDir, 'data'), homeDir),
    binDir: path.join(homeDir, 'bin'),
  }
  cfg.paths.socketPath = resolvePath(
    cfg.fbq.socketPath || path.join(cfg.paths.dataDir, 'fbq.sock'),
    cfg.paths.dataDir,
  )
  cfg.paths.configYaml = path.join(cfg.paths.dataDir, 'fbq.yaml')

  const root = cfg.fbq.workspaceRoot ? resolvePath(cfg.fbq.workspaceRoot, process.cwd()) : process.cwd()
  cfg.fbq.workspaceRoot = root

  // sources 规范化：未配置则自动单 source 指到 workspaceRoot
  const sources = Array.isArray(cfg.fbq.sources) && cfg.fbq.sources.length > 0 ? cfg.fbq.sources : null
  cfg.resolvedSources = (sources || [{ name: 'workspace', path: root }]).map((s, i) => {
    const src = typeof s === 'string' ? { path: s } : { ...s }
    return {
      name: src.name || (i === 0 ? 'workspace' : `source${i}`),
      path: resolvePath(src.path || root, root),
      defaultPermissions: {
        view: true,
        download: true,
        modify: true,
        create: true,
        delete: true,
        ...(isPlainObject(src.defaultPermissions) ? src.defaultPermissions : {}),
      },
    }
  })

  cfg.fbq.basePath = normalizeBasePath(cfg.fbq.basePath)
  return cfg
}

function normalizeBasePath(p) {
  let out = typeof p === 'string' && p.trim() ? p.trim() : '/-/fbq'
  if (!out.startsWith('/')) out = '/' + out
  if (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** 生成 FBQ 的 YAML 配置（v2 schema：根键 server / http / auth）。 */
function renderFbqYaml(cfg) {
  const q = (v) => JSON.stringify(String(v))
  const lines = []
  const push = (s = '') => lines.push(s)

  push('# 由 dsh-fbq-bridge 自动生成，请勿手工编辑（改 $DSH_HOME/fbq/config.json）')
  push('server:')
  push('  sources:')
  for (const s of cfg.resolvedSources) {
    push(`    - path: ${q(s.path)}`)
    push(`      name: ${q(s.name)}`)
    push('      config:')
    push('        defaultPermissions:')
    for (const k of ['view', 'download', 'modify', 'create', 'delete']) {
      push(`          ${k}: ${s.defaultPermissions[k] ? 'true' : 'false'}`)
    }
  }
  push('http:')
  push(`  socket: ${q(cfg.paths.socketPath)}`)
  push(`  baseURL: ${q(cfg.fbq.basePath)}`)
  push(`  trustProxyHeaders: ${cfg.fbq.trustProxyHeaders ? 'true' : 'false'}`)
  push('  disableRateLimit: false')
  push('auth:')
  push('  methods:')
  if (cfg.auth.mode === 'proxy') {
    push('    proxy:')
    push('      enabled: true')
    push(`      header: ${q(cfg.auth.proxyHeader)}`)
    if (cfg.auth.proxyGroups && cfg.auth.proxyGroups.length) {
      push(`      groupsClaim: ${q(cfg.auth.proxyGroupsHeader)}`)
      push(`      adminGroup: ${q(cfg.auth.proxyGroups[0])}`)
    }
  }
  // password 始终保留一个可用管理入口（人工兜底/首启），不影响 proxy 模式
  push('    password:')
  push('      enabled: true')

  // 逃生口：原样并入（顶层键，深合并浅层覆盖）
  const extra = cfg.fbq.extraConfig
  if (isPlainObject(extra) && Object.keys(extra).length > 0) {
    push('')
    push('# extraConfig')
    push(yamlFromPlain(extra, 0))
  }
  push('')
  return lines.join('\n')
}

/** 极简 YAML 序列化，覆盖 extraConfig 常见情形（对象/数组/标量）。 */
function yamlFromPlain(value, indent) {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (isPlainObject(v) || Array.isArray(v)) {
          return `${pad}-\n${yamlFromPlain(v, indent + 1)}`
        }
        return `${pad}- ${scalar(v)}`
      })
      .join('\n')
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([k, v]) => {
        if (isPlainObject(v) || Array.isArray(v)) return `${pad}${k}:\n${yamlFromPlain(v, indent + 1)}`
        return `${pad}${k}: ${scalar(v)}`
      })
      .join('\n')
  }
  return `${pad}${scalar(value)}`
}

function scalar(v) {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return JSON.stringify(String(v))
}

module.exports = { loadConfig, renderFbqYaml, dshHome, expandHome, resolvePath, DEFAULTS, deepMerge }
