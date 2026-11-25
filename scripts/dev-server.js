'use strict'

/**
 * 旁路验证服务器：不依赖 DSH，把 host 平面的核心逻辑跑起来，用真实请求压一遍。
 * 只用于开发和 CI，不参与线上运行。
 *
 * 用法：node scripts/dev-server.js [--port 3091]
 *
 * 环境变量：
 *   FBQ_DEV_GATE=1   打开 DSH 会话门（此时因没有 DSH connection 服务会一律 503，
 *                    仅用于验证 fail-closed 行为）
 *   FBQ_DEV_CONFIG   覆盖行配置（JSON 字符串）
 */

const http = require('node:http')

const { loadConfig } = require('../src/config')
const { FbqSupervisor } = require('../src/supervisor')
const { proxyRequest, forwardableRequestHeaders } = require('../src/proxy')
const { admitDshRequest, identityHeaders } = require('../src/gate')
const { createDirectServer } = require('../src/direct')

function argPort() {
  const i = process.argv.indexOf('--port')
  if (i > 0 && process.argv[i + 1]) return Number(process.argv[i + 1])
  return Number(process.env.PORT || 3091)
}

async function main() {
  const port = argPort()
  const rowConfig = process.env.FBQ_DEV_CONFIG ? JSON.parse(process.env.FBQ_DEV_CONFIG) : {}
  const cfg = loadConfig(rowConfig)
  const logger = { log: (...a) => console.log('[dev]', ...a), warn: (...a) => console.warn('[dev]', ...a) }
  const supervisor = new FbqSupervisor(cfg, logger)
  await supervisor.start()

  const basePath = cfg.fbq.basePath
  const statusPath = `${basePath}/__bridge/status`

  async function handleProxy(req, res, principal) {
    if (!supervisor.ready) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'fbq-not-ready', status: supervisor.status() }))
      return
    }
    const headers = forwardableRequestHeaders(req, { extra: identityHeaders(cfg, principal) })
    await proxyRequest(req, res, { socketPath: cfg.paths.socketPath, path: req.url, headers })
  }

  const gateOn = process.env.FBQ_DEV_GATE === '1'

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0]
    if (urlPath === statusPath) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: supervisor.status(), direct: direct.info() }, null, 2))
      return
    }
    if (!urlPath.startsWith(basePath)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(`not found (try ${basePath}/)`)
      return
    }
    let principal = cfg.auth.defaultUser
    if (gateOn) {
      const admitted = admitDshRequest(null, req, cfg)
      if (!admitted.ok) {
        res.writeHead(admitted.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, detail: admitted.reason }))
        return
      }
      principal = admitted.principal
    }
    await handleProxy(req, res, principal)
  })

  const direct = createDirectServer(cfg, {
    onStatus: () => supervisor.status(),
    onRequest: handleProxy,
    logger,
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  logger.log(`dev server: http://127.0.0.1:${port}${basePath}/  (fbq socket ${cfg.paths.socketPath})`)
  if (direct.server) logger.log(`dev direct port enabled`)

  const shutdown = async () => {
    logger.log('shutting down…')
    server.close()
    await direct.close()
    await supervisor.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('[dev] fatal:', e)
  process.exit(1)
})
