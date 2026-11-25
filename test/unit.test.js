'use strict'

/**
 * 纯函数单测：反代头处理、CSP 剥离、鉴权门、配置生成。
 * 不依赖 DSH，也不依赖 FBQ。
 *
 * 运行：node --test test/
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { forwardableRequestHeaders, forwardableResponseHeaders, sanitizeCsp } = require('../src/proxy')
const { admitDshRequest, admitDirectRequest, identityHeaders, parseBasic, timingSafeEqualStr } = require('../src/gate')
const { loadConfig, renderFbqYaml } = require('../src/config')

// 单测不读用户的真实配置文件
const load = (row) => loadConfig(row, { skipFile: true })

test('T1.2 剔除 hop-by-hop 头，保留业务头', () => {
  const headers = forwardableRequestHeaders({
    method: 'POST',
    headers: {
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      range: 'bytes=0-99',
      cookie: 'a=b',
      'content-type': 'multipart/form-data; boundary=x',
      host: 'example:3080',
    },
  })
  assert.equal(headers.connection, undefined)
  assert.equal(headers['keep-alive'], undefined)
  assert.equal(headers['transfer-encoding'], undefined)
  assert.equal(headers.range, 'bytes=0-99')
  assert.equal(headers.cookie, 'a=b')
  assert.equal(headers['content-type'], 'multipart/form-data; boundary=x')
  assert.equal(headers.host, 'dsh-quantum-files')
})

test('T2.6 客户端自带的身份头被丢弃', () => {
  const headers = forwardableRequestHeaders({
    headers: { 'x-dsh-user': 'admin', 'x-dsh-groups': 'dsh-admin', accept: '*/*' },
  })
  assert.equal(headers['x-dsh-user'], undefined)
  assert.equal(headers['x-dsh-groups'], undefined)
  assert.equal(headers.accept, '*/*')
})

test('注入的身份头覆盖并生效', () => {
  const headers = forwardableRequestHeaders(
    { headers: { 'x-dsh-user': 'attacker' } },
    { extra: { 'X-Dsh-User': 'owner' } },
  )
  assert.equal(headers['X-Dsh-User'], 'owner')
})

test('T1.3 响应头剥离帧限制，保留业务头', () => {
  const out = forwardableResponseHeaders({
    'x-frame-options': 'DENY',
    'content-type': 'text/html',
    'content-range': 'bytes 0-99/1000',
    'set-cookie': ['a=b'],
  })
  assert.equal(out['x-frame-options'], undefined)
  assert.equal(out['content-type'], 'text/html')
  assert.equal(out['content-range'], 'bytes 0-99/1000')
  assert.deepEqual(out['set-cookie'], ['a=b'])
})

test('CSP 剥离 frame-ancestors 但保留其余指令', () => {
  const csp = "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-abc'"
  const out = sanitizeCsp(csp)
  assert.ok(!/frame-ancestors/.test(out))
  assert.ok(/default-src 'self'/.test(out))
  assert.ok(/nonce-abc/.test(out))
})

test('T2.1 admit 放行时返回 principal', () => {
  const connection = { admit: () => ({ peer: { principal: 'song' } }) }
  const cfg = load({})
  const out = admitDshRequest(connection, { headers: {} }, cfg)
  assert.equal(out.ok, true)
  assert.equal(out.principal, 'song')
})

test('T2.1 admit 拒绝时映射状态码', () => {
  const connection = { admit: () => ({ rejection: 401 }) }
  const cfg = load({})
  const out = admitDshRequest(connection, { headers: {} }, cfg)
  assert.equal(out.ok, false)
  assert.equal(out.status, 401)
})

test('connection 缺失时 fail-closed', () => {
  const cfg = load({})
  const out = admitDshRequest(null, { headers: {} }, cfg)
  assert.equal(out.ok, false)
  assert.equal(out.status, 503)
})

test('admit 抛异常时 fail-closed', () => {
  const connection = {
    admit: () => {
      throw new Error('boom')
    },
  }
  const cfg = load({})
  const out = admitDshRequest(connection, { headers: {} }, cfg)
  assert.equal(out.ok, false)
  assert.equal(out.status, 401)
})

test('T2.3 独立端口：无口令 503，错口令 401，对口令放行', () => {
  const cfg = load({ direct: { enabled: true, password: 's3cret', username: 'u' } })
  const noAuth = admitDirectRequest({ method: 'GET', headers: {} }, cfg)
  assert.equal(noAuth.status, 401)
  assert.equal(noAuth.challenge, true)

  const bad = admitDirectRequest(
    { method: 'GET', headers: { authorization: 'Basic ' + Buffer.from('u:wrong').toString('base64') } },
    cfg,
  )
  assert.equal(bad.status, 401)

  const good = admitDirectRequest(
    { method: 'GET', headers: { authorization: 'Basic ' + Buffer.from('u:s3cret').toString('base64') } },
    cfg,
  )
  assert.equal(good.ok, true)
  assert.equal(good.principal, 'u')

  const noPassword = load({ direct: { enabled: true } })
  assert.equal(admitDirectRequest({ method: 'GET', headers: {} }, noPassword).status, 503)
})

test('T2.4 只读模式拦写方法、放行 PROPFIND', () => {
  const cfg = load({ direct: { enabled: true, password: 'p', username: 'u', readOnly: true } })
  const auth = { authorization: 'Basic ' + Buffer.from('u:p').toString('base64') }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'MKCOL', 'MOVE', 'COPY']) {
    const out = admitDirectRequest({ method, headers: auth }, cfg)
    assert.equal(out.ok, false, `${method} 应被拒绝`)
    assert.equal(out.status, 403)
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PROPFIND']) {
    assert.equal(admitDirectRequest({ method, headers: auth }, cfg).ok, true, `${method} 应放行`)
  }
})

test('Basic 解析与等时比较', () => {
  assert.deepEqual(parseBasic('Basic ' + Buffer.from('a:b:c').toString('base64')), {
    username: 'a',
    password: 'b:c',
  })
  assert.equal(parseBasic('Bearer x'), null)
  assert.equal(parseBasic(undefined), null)
  assert.equal(timingSafeEqualStr('abc', 'abc'), true)
  assert.equal(timingSafeEqualStr('abc', 'abd'), false)
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false)
})

test('proxy 模式注入身份头；password 模式不注入', () => {
  const proxyCfg = load({ auth: { mode: 'proxy', proxyGroups: ['dsh-admin'] } })
  const h = identityHeaders(proxyCfg, 'song')
  assert.equal(h['X-Dsh-User'], 'song')
  assert.equal(h['X-Dsh-Groups'], 'dsh-admin')

  const pwCfg = load({ auth: { mode: 'password' } })
  assert.deepEqual(identityHeaders(pwCfg, 'song'), {})
})

test('配置生成包含 baseURL / socket / proxy 头 / 默认权限', () => {
  const cfg = loadConfig({
    fbq: { basePath: '/-/fbq', socketPath: '/tmp/x.sock', sources: [{ name: 'workspace', path: '/tmp' }] },
    auth: { mode: 'proxy' },
  })
  const yaml = renderFbqYaml(cfg)
  assert.ok(yaml.includes('baseURL: "/-/fbq"'))
  assert.ok(yaml.includes('socket: "/tmp/x.sock"'))
  assert.ok(yaml.includes('header: "X-Dsh-User"'))
  assert.ok(yaml.includes('modify: true'))
  assert.ok(yaml.includes('enabled: true'))
})

test('basePath 规范化', () => {
  assert.equal(load({ fbq: { basePath: 'fbq' } }).fbq.basePath, '/fbq')
  assert.equal(load({ fbq: { basePath: '/-/fbq/' } }).fbq.basePath, '/-/fbq')
  assert.equal(load({ fbq: { basePath: '' } }).fbq.basePath, '/-/fbq')
})

test('未配置 sources 时自动单 source 指向 workspaceRoot', () => {
  const cfg = load({ fbq: { workspaceRoot: '/tmp/ws' } })
  assert.equal(cfg.resolvedSources.length, 1)
  assert.equal(cfg.resolvedSources[0].path, '/tmp/ws')
})
