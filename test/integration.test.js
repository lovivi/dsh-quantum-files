'use strict'

/**
 * 集成测试：不需要真 FBQ、不需要 DSH。
 *
 * 用一个假上游（unix socket 上的 http server）模拟 FBQ，然后用插件自己的
 * proxy / gate / direct 模块搭出两个前门，逐项验证：
 *   鉴权 fail-closed、身份头注入与伪造防护、帧头剥离、Range 透传、
 *   body 透传、独立端口口令与只读、上游不可达时的 502。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { proxyRequest, forwardableRequestHeaders } = require('../src/proxy')
const { admitDshRequest, identityHeaders } = require('../src/gate')
const { createDirectServer } = require('../src/direct')
const { loadConfig } = require('../src/config')

const quiet = { log: () => {}, warn: () => {} }

/** 起一个假 FBQ：记录收到的请求，按路径给出可断言的响应。 */
async function startMockFbq(socketPath) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })

      if (req.url.startsWith('/-/fbq/api/health')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (req.url.startsWith('/-/fbq/api/echo')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            method: req.method,
            user: req.headers['x-dsh-user'] || null,
            groups: req.headers['x-dsh-groups'] || null,
            range: req.headers.range || null,
            bytes: body.length,
          }),
        )
        return
      }
      if (req.url.startsWith('/-/fbq/api/raw')) {
        const range = req.headers.range
        if (range) {
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes 0-9/100',
          })
          res.end(Buffer.from('0123456789'))
          return
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.alloc(100, 7))
        return
      }
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'content-type': 'application/xml' })
        res.end('<multistatus/>')
        return
      }
      if (req.url === '/-/fbq/' || req.url === '/-/fbq') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
        })
        res.end('<html><link href="/-/fbq/public/static/x.css"></html>')
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  return {
    server,
    seen,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

/** 起与插件同源入口等价的 http server。 */
async function startSameOrigin({ socketPath, cfg, connection }) {
  const server = http.createServer(async (req, res) => {
    const admitted = admitDshRequest(connection, req, cfg)
    if (!admitted.ok) {
      res.writeHead(admitted.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, detail: admitted.reason }))
      return
    }
    const headers = forwardableRequestHeaders(req, { extra: identityHeaders(cfg, admitted.principal) })
    await proxyRequest(req, res, { socketPath, path: req.url, headers })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    server,
    port: server.address().port,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

function request(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { connection: 'close', ...headers }, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function withHarness(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshfbq-'))
  const socketPath = path.join(dir, 'fbq.sock')
  const mock = await startMockFbq(socketPath)
  const cfg = loadConfig(
    {
      fbq: { socketPath, basePath: '/-/fbq', workspaceRoot: dir },
      auth: { mode: 'proxy' },
      direct: { enabled: false },
    },
    { skipFile: true },
  )
  try {
    await fn({ cfg, mock, socketPath, dir })
  } finally {
    await mock.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('T2.1 同源入口：connection 缺失时 fail-closed（503）', async () => {
  await withHarness(async ({ cfg, socketPath }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: null })
    try {
      const r = await request(so.port, { path: '/-/fbq/' })
      assert.equal(r.status, 503)
    } finally {
      await so.close()
    }
  })
})

test('T2.1 同源入口：admit 拒绝时透传状态码', async () => {
  await withHarness(async ({ cfg, socketPath }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: { admit: () => ({ rejection: 401 }) } })
    try {
      assert.equal((await request(so.port, { path: '/-/fbq/' })).status, 401)
    } finally {
      await so.close()
    }
  })
})

test('T2.5 同源入口：admit 放行后注入身份头，上游可见', async () => {
  await withHarness(async ({ cfg, socketPath, mock }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } })
    try {
      const r = await request(so.port, { path: '/-/fbq/api/echo' })
      assert.equal(r.status, 200)
      const echoed = JSON.parse(r.body.toString())
      assert.equal(echoed.user, os.userInfo().username, '{kind:"owner"} 应映射成系统用户名')
      assert.equal(mock.seen.at(-1).headers['x-dsh-user'], os.userInfo().username)
    } finally {
      await so.close()
    }
  })
})

test('T2.6 客户端伪造身份头被丢弃，不能提权', async () => {
  await withHarness(async ({ cfg, socketPath, mock }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: { admit: () => ({ peer: { principal: 'owner-user' } }) } })
    try {
      const r = await request(so.port, {
        path: '/-/fbq/api/echo',
        headers: { 'x-dsh-user': 'admin', 'x-dsh-groups': 'dsh-admin' },
      })
      const echoed = JSON.parse(r.body.toString())
      assert.equal(echoed.user, 'owner-user', '必须用门禁注入的身份，而不是客户端自称的')
      assert.equal(mock.seen.at(-1).headers['x-dsh-user'], 'owner-user')
    } finally {
      await so.close()
    }
  })
})

test('T1.3 响应侧剥离 X-Frame-Options 与 CSP frame-ancestors', async () => {
  await withHarness(async ({ cfg, socketPath }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: { admit: () => ({ peer: { principal: 'u' } }) } })
    try {
      const r = await request(so.port, { path: '/-/fbq/' })
      assert.equal(r.status, 200)
      assert.equal(r.headers['x-frame-options'], undefined, 'X-Frame-Options 必须被剥掉')
      const csp = r.headers['content-security-policy'] || ''
      assert.ok(!/frame-ancestors/.test(csp), 'frame-ancestors 必须被剥掉')
      assert.ok(/script-src/.test(csp), '其余 CSP 指令要保留')
      assert.ok(r.body.toString().includes('/-/fbq/public/static'), 'HTML 内容不应被改写')
    } finally {
      await so.close()
    }
  })
})

test('T3.4 Range 请求透传并回传 206', async () => {
  await withHarness(async ({ cfg, socketPath }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: { admit: () => ({ peer: { principal: 'u' } }) } })
    try {
      const r = await request(so.port, { path: '/-/fbq/api/raw', headers: { range: 'bytes=0-9' } })
      assert.equal(r.status, 206)
      assert.equal(r.headers['content-range'], 'bytes 0-9/100')
      assert.equal(r.body.length, 10)
    } finally {
      await so.close()
    }
  })
})

test('T3.2 POST body 原样透传到上游', async () => {
  await withHarness(async ({ cfg, socketPath, mock }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: { admit: () => ({ peer: { principal: 'u' } }) } })
    try {
      const payload = Buffer.from('x'.repeat(1024 * 64))
      const r = await request(so.port, {
        method: 'POST',
        path: '/-/fbq/api/echo',
        headers: { 'content-type': 'application/octet-stream', 'content-length': payload.length },
        body: payload,
      })
      assert.equal(r.status, 200)
      const echoed = JSON.parse(r.body.toString())
      assert.equal(echoed.method, 'POST')
      assert.equal(echoed.bytes, payload.length, '上游收到的字节数必须与发送一致')
      assert.equal(mock.seen.at(-1).body.length, payload.length)
    } finally {
      await so.close()
    }
  })
})

test('T3.5 PROPFIND 等非标准方法透传', async () => {
  await withHarness(async ({ cfg, socketPath }) => {
    const so = await startSameOrigin({ socketPath, cfg, connection: { admit: () => ({ peer: { principal: 'u' } }) } })
    try {
      const r = await request(so.port, { method: 'PROPFIND', path: '/-/fbq/dav/workspace/', headers: { depth: '1' } })
      assert.equal(r.status, 207)
    } finally {
      await so.close()
    }
  })
})

test('T1.7 上游不可达时返回 502 且不崩溃', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshfbq-'))
  const cfg = loadConfig(
    { fbq: { socketPath: path.join(dir, 'missing.sock'), basePath: '/-/fbq' }, auth: { mode: 'proxy' } },
    { skipFile: true },
  )
  const so = await startSameOrigin({ socketPath: cfg.paths.socketPath, cfg, connection: { admit: () => ({ peer: { principal: 'u' } }) } })
  try {
    const r = await request(so.port, { path: '/-/fbq/' })
    assert.equal(r.status, 502)
    // 再打一次，证明进程还活着
    assert.equal((await request(so.port, { path: '/-/fbq/' })).status, 502)
  } finally {
    await so.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('T2.3 独立端口：无口令 401 → 错口令 401 → 对口令 200', async () => {
  await withHarness(async ({ cfg, socketPath }) => {
    const directCfg = loadConfig(
      {
        fbq: { socketPath, basePath: '/-/fbq' },
        auth: { mode: 'proxy' },
        direct: { enabled: true, host: '127.0.0.1', port: 0, requireTlsOnLan: false, tls: false, username: 'dsh', password: 'pw-123' },
      },
      { skipFile: true },
    )
    const direct = createDirectServer(directCfg, {
      onStatus: () => ({}),
      onRequest: (req, res, principal) =>
        proxyRequest(req, res, {
          socketPath,
          path: req.url,
          headers: forwardableRequestHeaders(req, { extra: identityHeaders(directCfg, principal) }),
        }),
      logger: quiet,
    })
    await direct.listening
    const port = direct.server.address().port
    try {
      assert.equal((await request(port, { path: '/-/fbq/api/health' })).status, 401)
      assert.equal(
        (
          await request(port, {
            path: '/-/fbq/api/health',
            headers: { authorization: 'Basic ' + Buffer.from('dsh:wrong').toString('base64') },
          })
        ).status,
        401,
      )
      const ok = await request(port, {
        path: '/-/fbq/api/health',
        headers: { authorization: 'Basic ' + Buffer.from('dsh:pw-123').toString('base64') },
      })
      assert.equal(ok.status, 200)
    } finally {
      await direct.close()
    }
  })
})

test('T2.4 独立端口只读模式：写方法 403，GET/PROPFIND 放行', async () => {
  await withHarness(async ({ cfg, socketPath }) => {
    const directCfg = loadConfig(
      {
        fbq: { socketPath, basePath: '/-/fbq' },
        auth: { mode: 'proxy' },
        direct: { enabled: true, host: '127.0.0.1', port: 0, readOnly: true, requireTlsOnLan: false, tls: false, username: 'u', password: 'p' },
      },
      { skipFile: true },
    )
    const direct = createDirectServer(directCfg, {
      onStatus: () => ({}),
      onRequest: (req, res, principal) =>
        proxyRequest(req, res, {
          socketPath,
          path: req.url,
          headers: forwardableRequestHeaders(req, { extra: identityHeaders(directCfg, principal) }),
        }),
      logger: quiet,
    })
    await direct.listening
    const port = direct.server.address().port
    const auth = { authorization: 'Basic ' + Buffer.from('u:p').toString('base64') }
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const r = await request(port, { method, path: '/-/fbq/api/echo', headers: auth })
        assert.equal(r.status, 403, `${method} 应被只读模式拒绝`)
      }
      assert.equal((await request(port, { path: '/-/fbq/api/health', headers: auth })).status, 200)
      assert.equal((await request(port, { method: 'PROPFIND', path: '/-/fbq/dav/x/', headers: auth })).status, 207)
    } finally {
      await direct.close()
    }
  })
})

test('supervisor.probeOnce 能识别 socket 是否就绪（自愈依据）', async () => {
  const { FbqSupervisor } = require('../src/supervisor')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshfbq-'))
  const socketPath = path.join(dir, 'probe.sock')
  const mock = await startMockFbq(socketPath)
  const cfg = loadConfig({ fbq: { socketPath, basePath: '/-/fbq' } }, { skipFile: true })
  const sup = new FbqSupervisor(cfg, quiet)
  try {
    assert.equal(await sup.probeOnce(1000), true, '假上游在时探测应为真')
  } finally {
    await mock.close()
  }
  assert.equal(await sup.probeOnce(500), false, '上游关掉后探测应为假')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('独立端口未启用时 info() 不能抛异常（TDZ 回归）', async () => {
  const cfg = loadConfig(
    { fbq: { socketPath: '/tmp/never.sock', basePath: '/-/fbq' }, direct: { enabled: false } },
    { skipFile: true },
  )
  const direct = createDirectServer(cfg, { onStatus: () => ({}), onRequest: () => {}, logger: quiet })
  assert.equal(direct.server, null)
  const info = direct.info() // 以前这里会抛 ReferenceError: Cannot access 'tls' before initialization
  assert.equal(info.enabled, false)
  assert.equal(info.tls, false)
})

test('独立端口：根路径 302 到 basePath', async () => {
  await withHarness(async ({ socketPath }) => {
    const directCfg = loadConfig(
      {
        fbq: { socketPath, basePath: '/-/fbq' },
        auth: { mode: 'proxy' },
        direct: { enabled: true, host: '127.0.0.1', port: 0, requireTlsOnLan: false, tls: false, username: 'u', password: 'p' },
      },
      { skipFile: true },
    )
    const direct = createDirectServer(directCfg, {
      onStatus: () => ({}),
      onRequest: () => {},
      logger: quiet,
    })
    await direct.listening
    const port = direct.server.address().port
    const auth = { authorization: 'Basic ' + Buffer.from('u:p').toString('base64') }
    try {
      const r = await request(port, { path: '/', headers: auth })
      assert.equal(r.status, 302)
      assert.equal(r.headers.location, '/-/fbq/')
    } finally {
      await direct.close()
    }
  })
})
