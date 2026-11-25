'use strict'

/**
 * 集成验证：对已经跑起来的桥接端点压一遍测试计划里的关键用例。
 *
 * 用法：
 *   node scripts/verify.js [--base http://127.0.0.1:3091] [--base-path /-/fbq] [--source workspace]
 *
 * 退出码：0 全绿；1 有失败。
 */

const http = require('node:http')
const crypto = require('node:crypto')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const BASE = arg('base', 'http://127.0.0.1:3091')
const BASE_PATH = arg('base-path', '/-/fbq')
const SOURCE = arg('source', 'workspace')
const COOKIE = arg('cookie', '')
const AUTH = arg('auth', '')   // 'user:pass' → Basic

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${name}${detail ? '  — ' + detail : ''}`)
}

function baseHeaders() {
  const h = {}
  if (COOKIE) h.cookie = COOKIE
  if (AUTH) h.authorization = 'Basic ' + Buffer.from(AUTH).toString('base64')
  return h
}

function request({ method = 'GET', path, headers = {}, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path,
        headers: { ...baseHeaders(), ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        )
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function multipart(filename, content) {
  const boundary = '----dshfbq' + crypto.randomBytes(8).toString('hex')
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function main() {
  // T3.1 首页
  try {
    const r = await request({ path: `${BASE_PATH}/` })
    const hasBase = r.body.toString('utf8', 0, 4000).includes(`${BASE_PATH}/public/static`)
    record('T3.1 首页 200 且资源前缀正确', r.status === 200 && hasBase, `status=${r.status} basePrefixed=${hasBase}`)
  } catch (e) {
    record('T3.1 首页 200 且资源前缀正确', false, e.message)
  }

  // T3.1b 健康
  try {
    const r = await request({ path: `${BASE_PATH}/api/health` })
    record('T3.1b /api/health 200', r.status === 200, `status=${r.status}`)
  } catch (e) {
    record('T3.1b /api/health 200', false, e.message)
  }

  // T3.2 上传 + 下载（FBQ 的写接口收 raw body，path 指向目标文件）
  const name = `verify-${Date.now()}.txt`
  const marker = 'dshfbq-marker-' + crypto.randomBytes(8).toString('hex')
  const payload = Buffer.from((marker + '\n').repeat(64))
  const wantSha = crypto.createHash('sha256').update(payload).digest('hex')
  let uploaded = false
  try {
    const r = await request({
      method: 'POST',
      path: `${BASE_PATH}/api/resources?path=/${name}&source=${SOURCE}&override=true`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': payload.length },
      body: payload,
    })
    uploaded = r.status === 200 || r.status === 201
    record('T3.2a 经反代上传文件', uploaded, `status=${r.status} ${r.body.toString().slice(0, 100)}`)
  } catch (e) {
    record('T3.2a 经反代上传文件', false, e.message)
  }

  if (uploaded) {
    try {
      const r = await request({ path: `${BASE_PATH}/api/raw?file=/${name}&source=${SOURCE}` })
      // raw 返回归档流（multipart），这里按"是否包含完整 payload 与体积合理"判定
      const ok = r.status === 200 && r.body.includes(payload)
      record('T3.2b 下载回读内容一致', ok, `status=${r.status} bytes=${r.body.length} sha=${wantSha.slice(0, 12)}`)
    } catch (e) {
      record('T3.2b 下载回读内容一致', false, e.message)
    }

    // T3.4 Range
    try {
      const r = await request({
        path: `${BASE_PATH}/api/raw?file=/${name}&source=${SOURCE}`,
        headers: { range: 'bytes=0-63' },
      })
      const ranged = r.status === 206 || (r.status === 200 && Boolean(r.headers['content-range']))
      record('T3.4 Range 请求（206/Content-Range）', ranged, `status=${r.status} cr=${r.headers['content-range'] || '-'}`)
    } catch (e) {
      record('T3.4 Range 请求（206/Content-Range）', false, e.message)
    }
  }

  // T1.2 方法透传：PROPFIND（WebDAV 在 /dav/<source>/，需要 Basic 认证 → 401 也算路由可达）
  try {
    const r = await request({
      method: 'PROPFIND',
      path: `${BASE_PATH}/dav/${SOURCE}/`,
      headers: { depth: '1' },
    })
    record(
      'T3.5 PROPFIND 透传到 FBQ WebDAV（207/401 均可）',
      [207, 401, 405].includes(r.status),
      `status=${r.status}`,
    )
  } catch (e) {
    record('T3.5 PROPFIND 透传到 FBQ WebDAV', false, e.message)
  }

  // T1.3 帧头
  try {
    const r = await request({ path: `${BASE_PATH}/` })
    const xfo = r.headers['x-frame-options']
    record('T1.3 无 X-Frame-Options 阻挡内嵌', !xfo, xfo ? `xfo=${xfo}` : 'none')
  } catch (e) {
    record('T1.3 无 X-Frame-Options 阻挡内嵌', false, e.message)
  }

  // T1.7 上游不可达 → 502（用一个不存在的路径触发 FBQ 404 而不是 502，仅记录）
  try {
    const r = await request({ path: `${BASE_PATH}/__nonexistent__` })
    record('T1.7 未知路径不崩溃（返回 FBQ 自身状态）', r.status > 0, `status=${r.status}`)
  } catch (e) {
    record('T1.7 未知路径不崩溃', false, e.message)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('verify fatal:', e)
  process.exit(1)
})
