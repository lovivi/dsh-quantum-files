'use strict'

/**
 * dsh-quantum-files — Host 平面入口
 *
 * 把 FileBrowser Quantum 当 sidecar 跑起来，用两个前门接进 DSH：
 *   1) DSH 同源路由  <basePath>/*   → 过 DSH 会话门 → 反代到 FBQ 的 unix socket
 *   2) 独立端口       <host>:<port>  → 过 Basic 口令门 → 反代到同一个 FBQ
 *
 * FBQ 本身只监听 unix socket，两个前门是它唯一入口。
 */

const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const { loadConfig } = require('./config')
const { FbqSupervisor } = require('./supervisor')
const { proxyRequest, forwardableRequestHeaders } = require('./proxy')
const { admitDshRequest, identityHeaders } = require('./gate')
const { createDirectServer } = require('./direct')

const name = 'dsh-quantum-files'
const inject = ['webServer']

const STATUS_SUFFIX = '/__bridge/status'

function makeLogger(ctx) {
  const tag = '[dsh-quantum-files]'
  const write = (level, args) => {
    try {
      const l = ctx && ctx.logger
      if (l && typeof l[level] === 'function') l[level](tag, ...args)
      else (level === 'warn' ? console.warn : console.log)(tag, ...args)
    } catch {
      ;(level === 'warn' ? console.warn : console.log)(tag, ...args)
    }
  }
  return { log: (...a) => write('info', a), warn: (...a) => write('warn', a) }
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

function pathOnly(u) {
  const url = u || '/'
  const q = url.indexOf('?')
  return q < 0 ? url : url.slice(0, q)
}

async function persistDirectPassword(cfg, password) {
  const file = cfg.paths.configFile
  let current = {}
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    current = {}
  }
  current.direct = { ...(current.direct || {}), password }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(current, null, 2) + '\n', 'utf8')
}

function apply(ctx, rowConfig) {
  const logger = makeLogger(ctx)
  let cfg
  try {
    cfg = loadConfig(rowConfig)
  } catch (e) {
    logger.warn('配置加载失败，插件不启动:', e.message)
    return
  }

  const supervisor = new FbqSupervisor(cfg, logger)
  const basePath = cfg.fbq.basePath
  const statusPath = `${basePath}${STATUS_SUFFIX}`

  const getService = (n) => (ctx.get ? ctx.get(n) : ctx[n])

  async function handleProxy(req, res, principal) {
    if (!supervisor.ready) {
      // 自愈：就绪标记可能因为启动期的一次探测失败而卡住，但进程其实已经好了。
      // 每次请求最多多花 1.5s 做一次真实探测，成功就继续。
      const alive = await supervisor.probeOnce(1500)
      if (alive) {
        supervisor.ready = true
        logger.log('FBQ 探测成功，就绪标记已自愈')
      }
    }
    if (!supervisor.ready) {
      sendJson(res, 503, {
        ok: false,
        error: 'fbq-not-ready',
        detail: 'FileBrowser Quantum 尚未就绪（正在启动或崩溃重启中），请稍后重试',
        status: supervisor.status(),
      })
      return
    }
    const headers = forwardableRequestHeaders(req, { extra: identityHeaders(cfg, principal) })
    await proxyRequest(req, res, {
      socketPath: cfg.paths.socketPath,
      path: req.url || '/',
      headers,
    })
  }

  // ── 入口 1：DSH 同源路由 ────────────────────────────────────────────────
  const webServer = getService('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: basePath,
          handler: async (req, res) => {
            if (pathOnly(req.url) === `${basePath}/__bridge/session-cwd`) {
              // 把会话的工作目录交给客户端，用于 iframe 深链。导入会话同样适用。
              const sessions = getService('sessions')
              const q = (req.url || '').split('?')[1] || ''
              const id = new URLSearchParams(q).get('session') || ''
              let cwd = ''
              try {
                const rec = sessions && typeof sessions.get === 'function' ? sessions.get(id) : null
                cwd = (rec && ((rec.header && rec.header.cwd) || rec.cwd)) || ''
              } catch (e) {
                logger.warn('解析会话工作目录失败:', e && e.message)
              }
              const url = cwd ? `${basePath}/files${String(cwd).split('/').map(encodeURIComponent).join('/')}` : `${basePath}/files/`
              sendJson(res, 200, { session: id, cwd, url })
              return
            }
            if (pathOnly(req.url) === statusPath) {
              sendJson(res, 200, { ok: true, status: supervisor.status(), direct: direct.info() })
              return
            }
            const admitted = admitDshRequest(getService('connection'), req, cfg)
            if (!admitted.ok) {
              if (String(req.headers.accept || '').includes('text/html')) {
                res.writeHead(admitted.status, { 'content-type': 'text/html; charset=utf-8' })
                res.end(
                  `<meta charset="utf-8"><h1>${admitted.status}</h1><p>${escapeHtml(admitted.reason)}</p>` +
                    `<p>该地址需要在 DSH 页面内访问（依赖 DSH 的浏览器会话）。</p>`,
                )
                return
              }
              sendJson(res, admitted.status, { ok: false, error: 'unauthorized', detail: admitted.reason })
              return
            }
            await handleProxy(req, res, admitted.principal)
          },
        }),
      'dsh-quantum-files: same-origin route',
    )
    logger.log(`同源路由已注册: ${basePath}/*`)
  } else {
    logger.warn('webServer 不可用，DSH 同源入口未注册')
  }

  // ── 入口 2：独立端口 ────────────────────────────────────────────────────
  if (cfg.direct.enabled && !cfg.direct.password) {
    cfg.direct.password = crypto.randomBytes(12).toString('base64url')
    persistDirectPassword(cfg, cfg.direct.password)
      .then(() => logger.log(`已生成独立端口口令并写入 ${cfg.paths.configFile}`))
      .catch((e) => logger.warn('写回独立端口口令失败:', e.message))
  }

  const direct = createDirectServer(cfg, {
    onStatus: () => supervisor.status(),
    onRequest: handleProxy,
    logger,
  })

  // 兜底返回，不把返回值交给 loader 当 disposable
  let disposed = false

  // ── 生命周期 ─────────────────────────────────────────────────────────────
  ctx.effect(() => {
    let alive = true
    ;(async () => {
      try {
        await supervisor.start()
        if (!alive) await supervisor.stop()
      } catch (e) {
        logger.warn('FBQ 启动失败:', e.message)
        for (const line of supervisor.status().recentLog.slice(-10)) logger.warn('  |', line)
      }
    })()
    return () => {
      alive = false
      disposed = true
      Promise.resolve()
        .then(() => supervisor.stop())
        .catch((e) => logger.warn('停止 FBQ 失败:', e.message))
      Promise.resolve()
        .then(() => direct.close())
        .catch(() => {})
    }
  }, 'dsh-quantum-files: lifecycle')

  // 供同进程其它代码观察状态（非 cordis service，仅挂在 ctx 上）
  try {
    ctx.fbqBridge = {
      status: () => supervisor.status(),
      direct: () => direct.info(),
      basePath,
      keep() {
        return disposed
      },
    }
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

module.exports = { name, inject, apply }
