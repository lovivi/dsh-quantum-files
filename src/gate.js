'use strict'

/**
 * dsh-quantum-files — 鉴权门
 *
 * 两个前门各有一层门，都只做"放行/拒绝 + 决定注入的身份"：
 *  - DSH 同源路由：复用 DSH 的浏览器会话（ctx.connection.admit），拿到 Peer 的 principal
 *  - 独立端口：HTTP Basic 口令门 + TLS 强制 + 可选只读方法白名单
 *
 * 设计要点：FBQ 侧开 proxy auth 时**盲信**身份头，所以身份头只能由这里注入，
 * 浏览器带上来的同名头必须在 proxy 层丢弃（见 proxy.js IDENTITY_HEADERS）。
 */

const crypto = require('node:crypto')
const os = require('node:os')

/**
 * Principal 是对象（例如 { kind: 'owner' }），FBQ 的身份头需要字符串。
 * 这里给出稳定、可读的映射，避免把 "[object Object]" 写进 FBQ 用户表。
 */
function principalToString(p) {
  if (!p) return null
  if (typeof p === 'string') return p
  if (typeof p === 'object') {
    if (p.kind === 'owner') {
      try {
        return os.userInfo().username || 'owner'
      } catch {
        return 'owner'
      }
    }
    if (typeof p.name === 'string' && p.name) return p.name
    if (typeof p.id === 'string' && p.id) return p.id
    if (typeof p.kind === 'string' && p.kind) return p.kind
  }
  return String(p)
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) {
    // 仍然做一次等长比较，避免长度差成为快速判别信号
    const pad = Buffer.alloc(ba.length)
    crypto.timingSafeEqual(ba, pad)
    return false
  }
  return crypto.timingSafeEqual(ba, bb)
}

function parseBasic(headerValue) {
  if (typeof headerValue !== 'string') return null
  const m = /^Basic\s+(.+)$/i.exec(headerValue.trim())
  if (!m) return null
  let decoded
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8')
  } catch {
    return null
  }
  const idx = decoded.indexOf(':')
  if (idx < 0) return null
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) }
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND'])

/**
 * DSH 同源门：校验 DSH 浏览器会话并返回身份。
 * @returns {{ok:true, principal:string} | {ok:false, status:number, reason:string}}
 */
function admitDshRequest(connection, req, cfg) {
  if (!cfg.auth.dshGate) {
    return { ok: true, principal: cfg.auth.defaultUser }
  }
  if (!connection || typeof connection.admit !== 'function') {
    // 服务缺失时不能在"以为有门"的前提下放行：直接拒绝，避免静默裸奔
    return { ok: false, status: 503, reason: 'connection 服务不可用，无法校验 DSH 会话' }
  }
  let out
  try {
    out = connection.admit({ headers: req.headers })
  } catch (e) {
    return { ok: false, status: 401, reason: `admit 异常: ${String((e && e.message) || e)}` }
  }
  if (!out) return { ok: false, status: 401, reason: 'admit 无结果' }
  if (out.rejection) {
    const status = typeof out.rejection === 'number' ? out.rejection : 401
    return { ok: false, status, reason: `admit 拒绝 (${status})` }
  }
  const raw = out.peer && (out.peer.principal || out.peer.username || out.peer.id)
  return { ok: true, principal: principalToString(raw) || cfg.auth.defaultUser }
}

/**
 * 独立端口门：Basic 口令 + 只读限制。
 * @returns {{ok:true, principal:string} | {ok:false, status:number, reason:string, challenge?:boolean}}
 */
function admitDirectRequest(req, cfg) {
  const direct = cfg.direct

  if (direct.readOnly && !READ_ONLY_METHODS.has(String(req.method || '').toUpperCase())) {
    return { ok: false, status: 403, reason: '只读模式：该方法被拒绝' }
  }

  if (!direct.password) {
    return { ok: false, status: 503, reason: '独立端口未配置口令' }
  }

  const creds = parseBasic(req.headers.authorization)
  if (!creds) {
    return { ok: false, status: 401, reason: '需要 Basic 认证', challenge: true }
  }
  if (!timingSafeEqualStr(creds.username, direct.username) || !timingSafeEqualStr(creds.password, direct.password)) {
    return { ok: false, status: 401, reason: '用户名或口令不正确', challenge: true }
  }
  return { ok: true, principal: direct.username }
}

/**
 * 决定这次请求注入给 FBQ 的身份头。
 * proxy 模式注入；password/none 模式不注入（让 FBQ 自己认证）。
 */
function identityHeaders(cfg, principal) {
  if (cfg.auth.mode !== 'proxy') return {}
  const headers = {}
  const user = principal || cfg.auth.defaultUser
  headers[cfg.auth.proxyHeader] = user
  if (cfg.auth.proxyGroups && cfg.auth.proxyGroups.length) {
    headers[cfg.auth.proxyGroupsHeader] = cfg.auth.proxyGroups.join(',')
  }
  return headers
}

module.exports = {
  principalToString,
  admitDshRequest,
  admitDirectRequest,
  identityHeaders,
  parseBasic,
  timingSafeEqualStr,
  READ_ONLY_METHODS,
}
