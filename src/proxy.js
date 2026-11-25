'use strict'

/**
 * dsh-fbq-bridge — 透明反代
 *
 * 一个前端（DSH 同源路由 / 独立端口）到 FBQ 的 Unix socket 反代：
 *  - 透传 method / 原始 path / 全部业务头（含 Range、Cookie、Content-*、PROPFIND 之类）
 *  - 剔除 hop-by-hop 头，避免连接语义被穿透
 *  - 请求体与响应体都走 pipe，绝不整体缓冲（否则大文件上传/下载会吃内存）
 *  - 响应侧剥掉 X-Frame-Options（同源内嵌需要），其余原样
 *  - 客户端自带的身份头一律丢弃，由调用方注入可信身份
 */

const http = require('node:http')

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 这些头代表"我是谁"，绝不能让浏览器自己带进来。 */
const IDENTITY_HEADERS = ['x-dsh-user', 'x-dsh-groups', 'x-forwarded-user', 'x-forwarded-groups', 'remote-user']

/** 从 node 的 req 里取一份可转发头表。 */
function forwardableRequestHeaders(req, { dropIdentity = true, extra = {} } = {}) {
  const out = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    if (dropIdentity && IDENTITY_HEADERS.includes(key)) continue
    if (v === undefined) continue
    out[k] = v
  }
  // 交给上游的是本机 socket 反代，明确告知连接语义
  out.host = 'dsh-fbq-bridge'
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out
}

/** 响应头过滤：剥掉会阻止同源 iframe 的帧限制。 */
function forwardableResponseHeaders(upstreamHeaders) {
  const out = {}
  for (const [k, v] of Object.entries(upstreamHeaders)) {
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    if (key === 'x-frame-options') continue
    out[k] = v
  }
  return out
}

const CSP_FRAME_ANCESTORS = /(^|;)\s*frame-ancestors[^;]*/gi

function sanitizeCsp(value) {
  if (typeof value !== 'string') return value
  if (!CSP_FRAME_ANCESTORS.test(value)) return value
  CSP_FRAME_ANCESTORS.lastIndex = 0
  return value.replace(CSP_FRAME_ANCESTORS, '').replace(/;\s*;/g, ';').trim()
}

/**
 * 把一次请求反向代理到 upstream。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{socketPath:string, method?:string, path:string, headers?:object, body?:Buffer|string, timeoutMs?:number}} opts
 */
function proxyRequest(req, res, opts) {
  const { socketPath, path, method, headers, body, timeoutMs = 0 } = opts
  return new Promise((resolve) => {
    let settled = false
    const done = (kind) => {
      if (settled) return
      settled = true
      resolve(kind)
    }

    const upstream = http.request(
      {
        socketPath,
        path,
        method: method || req.method,
        headers: headers || forwardableRequestHeaders(req),
      },
      (up) => {
        const outHeaders = forwardableResponseHeaders(up.headers)
        if (outHeaders['content-security-policy']) {
          outHeaders['content-security-policy'] = sanitizeCsp(outHeaders['content-security-policy'])
        }
        res.writeHead(up.statusCode || 502, up.statusMessage, outHeaders)
        up.pipe(res)
        up.on('end', () => done('ok'))
        up.on('error', (err) => {
          fail(err)
        })
      },
    )

    function fail(err) {
      if (settled) return
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'fbq upstream error', detail: String((err && err.message) || err) }))
      } else {
        try {
          res.destroy()
        } catch {}
      }
      done('error')
    }

    upstream.on('error', fail)
    if (timeoutMs > 0) {
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('upstream timeout')))
    }

    // 客户端提前断开：连带关掉上游，避免句柄泄漏
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })

    if (body !== undefined) {
      upstream.end(body)
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      upstream.end()
    } else {
      req.pipe(upstream)
      req.on('error', (err) => upstream.destroy(err))
    }
  })
}

/** 一次性上游请求（健康检查、状态查询用）。 */
function requestOnce({ socketPath, path, method = 'GET', headers = {}, body, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }),
      )
      res.on('error', (err) => resolve({ status: 0, error: String(err.message || err) }))
    })
    req.on('error', (err) => resolve({ status: 0, error: String(err.message || err) }))
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

module.exports = {
  proxyRequest,
  requestOnce,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  sanitizeCsp,
  HOP_BY_HOP,
  IDENTITY_HEADERS,
}
