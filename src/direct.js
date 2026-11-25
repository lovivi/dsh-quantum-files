'use strict'

/**
 * dsh-fbq-bridge — 独立端口前门
 *
 * 一台自己的 http(s) 监听：先过 Basic 口令门（+ 可选只读），
 * 再把请求以同样的 basePath 前缀交给反代。根路径 302 到 basePath。
 *
 * 与 DSH 同源入口共用同一个 FBQ unix socket —— 两个前门、一份数据。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { admitDirectRequest } = require('./gate')

function isLoopback(host) {
  if (!host) return false
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  })
  res.end(body)
}

function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return process.env.HOME || p
  if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2))
  return p
}

/** 解析 TLS：显式配置优先，否则复用 DSH 自身的证书。 */
function resolveTls(cfg) {
  const tls = cfg.direct.tls
  // 显式 false：不做 TLS（仅建议 loopback 调试/测试用）
  if (tls === false) return null
  if (tls && tls.cert && tls.key) {
    return {
      cert: fs.readFileSync(path.resolve(expandHome(tls.cert)), 'utf8'),
      key: fs.readFileSync(path.resolve(expandHome(tls.key)), 'utf8'),
    }
  }
  const cert = path.join(cfg.paths.home, 'tls', 'cert.pem')
  const key = path.join(cfg.paths.home, 'tls', 'key.pem')
  try {
    return { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') }
  } catch {
    return null
  }
}

/**
 * 建立独立端口监听。
 * @param {object} cfg
 * @param {{
 *   onRequest: (req, res, principal) => Promise<void>|void,
 *   onStatus: () => object,
 *   logger: {log:(...a:any[])=>void, warn:(...a:any[])=>void},
 * }} hooks
 * @returns {{server: import('node:http').Server|null, info: () => object, close: () => Promise<void>, refused: string|null}}
 */
function createDirectServer(cfg, hooks) {
  const { onRequest, onStatus, logger } = hooks
  const direct = cfg.direct
  const basePath = cfg.fbq.basePath
  const statusPath = `${basePath}/__bridge/status`

  const info = (extra) => ({
    enabled: Boolean(server && server.listening),
    host: direct.host,
    port: server && server.listening ? server.address().port : direct.port,
    readOnly: direct.readOnly,
    tls: Boolean(tls),
    username: direct.username,
    passwordConfigured: Boolean(direct.password),
    ...(extra || {}),
  })

  if (!direct.enabled) {
    return {
      server: null,
      info: () => info(),
      close: async () => {},
      refused: null,
      tls: null,
      listening: Promise.resolve(false),
    }
  }

  const tls = resolveTls(cfg)
  if (!isLoopback(direct.host) && direct.requireTlsOnLan && !tls) {
    const refused =
      `独立端口绑定到 ${direct.host} 但找不到 TLS 证书；已拒绝启动独立端口。` +
      ` 在 config.json 的 direct.tls 指定证书，或设置 direct.requireTlsOnLan=false（不建议）`
    logger.warn(refused)
    return {
      server: null,
      info: () => info({ refused }),
      close: async () => {},
      refused,
      tls: null,
      listening: Promise.resolve(false),
    }
  }

  const listener = (req, res) => {
    const admitted = admitDirectRequest(req, cfg)
    if (!admitted.ok) {
      const headers = admitted.challenge
        ? { 'www-authenticate': 'Basic realm="dsh-fbq-bridge", charset="UTF-8"' }
        : undefined
      sendJson(
        res,
        admitted.status,
        { ok: false, error: 'unauthorized', detail: admitted.reason },
        headers,
      )
      return
    }

    const urlPath = (req.url || '/').split('?')[0]
    if (urlPath === '/') {
      res.writeHead(302, { location: `${basePath}/` })
      res.end()
      return
    }
    if (urlPath === statusPath) {
      sendJson(res, 200, { ok: true, status: onStatus ? onStatus() : null, direct: info() })
      return
    }
    if (!urlPath.startsWith(basePath)) {
      sendJson(res, 404, { ok: false, error: 'not-found', detail: `只提供 ${basePath}/*` })
      return
    }
    Promise.resolve(onRequest(req, res, admitted.principal)).catch((e) => {
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: String((e && e.message) || e) })
      else {
        try {
          res.destroy()
        } catch {}
      }
    })
  }

  const server = tls ? https.createServer(tls, listener) : http.createServer(listener)
  // 绑定成功/失败都要能等到，避免调用方拿到 address() === null
  const listening = new Promise((resolve) => {
    server.once('error', (e) => {
      logger.warn(`独立端口监听失败: ${e.message}`)
      resolve(false)
    })
    server.listen(direct.port, direct.host, () => {
      const scheme = tls ? 'https' : 'http'
      logger.log(`独立端口: ${scheme}://${direct.host}:${server.address().port}/  (Basic 用户 ${direct.username})`)
      resolve(true)
    })
  })

  return {
    server,
    tls,
    refused: null,
    listening,
    info: () => info(),
    close: async () => {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
        setTimeout(resolve, 2000).unref?.()
      })
    },
  }
}

module.exports = { createDirectServer, resolveTls, isLoopback }
