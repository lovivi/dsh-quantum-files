'use strict'

/**
 * dsh-quantum-files — FBQ 进程管理
 *
 * 负责：二进制定位/下载、fbq.yaml 生成、spawn、健康检查、崩溃退避重启、清理。
 * 所有失败都以 status 对象暴露给上层，绝不 throw 到 cordis 的 apply 里。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { renderFbqYaml } = require('./config')
const { requestOnce } = require('./proxy')
const { PINNED, assetFor, assetUrl, platformKey } = require('./binaries')

class FbqSupervisor {
  /**
   * @param {object} cfg loadConfig() 的结果
   * @param {{log:(...a:any[])=>void, warn:(...a:any[])=>void}} logger
   */
  constructor(cfg, logger) {
    this.cfg = cfg
    this.log = logger.log
    this.warn = logger.warn
    this.proc = null
    this.stopping = false
    this.restarts = 0
    this.restartTimer = null
    this.startedAt = null
    this.lastExit = null
    this.ready = false
    this.logBuffer = []
  }

  get logLines() {
    return this.cfg.fbq.logLines
  }

  status() {
    return {
      ready: this.ready,
      pid: this.proc ? this.proc.pid || null : null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
      socketPath: this.cfg.paths.socketPath,
      basePath: this.cfg.fbq.basePath,
      sources: this.cfg.resolvedSources.map((s) => ({ name: s.name, path: s.path })),
      authMode: this.cfg.auth.mode,
      recentLog: this.logBuffer.slice(-20),
    }
  }

  /** 定位二进制；缺失且允许下载时按固定摘要拉取。 */
  async ensureBinary() {
    const { cfg } = this
    const version = cfg.fbq.version || PINNED.version

    if (cfg.fbq.binary) {
      const p = path.isAbsolute(cfg.fbq.binary) ? cfg.fbq.binary : path.resolve(cfg.fbq.binary)
      await fsp.access(p, fs.constants.X_OK).catch(() => {
        throw new Error(`配置的 FBQ 二进制不可执行: ${p}`)
      })
      return p
    }

    const exeName = process.platform === 'win32' ? 'filebrowser.exe' : 'filebrowser'
    const cached = path.join(cfg.paths.binDir, version, exeName)
    try {
      await fsp.access(cached, fs.constants.X_OK)
      return cached
    } catch {}

    // 开发态：仓库内自带的二进制（不入 npm 包，也不入 git）
    const vendored = path.join(__dirname, '..', 'vendor', exeName)
    try {
      await fsp.access(vendored, fs.constants.X_OK)
      this.log(`使用包内自带二进制: ${vendored}`)
      return vendored
    } catch {}

    const asset = assetFor()
    if (!asset) {
      throw new Error(
        `不支持的平台 ${platformKey()}。请自行下载 FBQ 二进制并用 fbq.binary 指向它，` +
          `或在 $DSH_HOME/fbq/config.json 里设置 fbq.allowUnverifiedDownload=true 后自建清单`,
      )
    }

    if (!cfg.fbq.allowDownload) {
      throw new Error(
        `未找到 FBQ 二进制（${version}/${asset.name}）。三种办法：\n` +
          `  1) 打开 fbq.allowDownload 让插件自动下载（会按内置 sha256 校验）\n` +
          `  2) 手动下载 ${assetUrl(asset, version)} 放到 ${cached}\n` +
          `  3) 设置 fbq.binary 指向已有的可执行文件`,
      )
    }

    await fsp.mkdir(path.dirname(cached), { recursive: true })
    const url = assetUrl(asset, version)
    this.log(`下载 FBQ 二进制: ${url} (${(asset.size / 1048576).toFixed(1)} MB)`)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())

    const expected = String(cfg.fbq.sha256 || asset.sha256 || '').toLowerCase()
    const actual = crypto.createHash('sha256').update(buf).digest('hex')
    if (expected && actual !== expected) {
      throw new Error(`sha256 校验失败: 期望 ${expected} 实际 ${actual}（已丢弃下载文件）`)
    }
    if (!expected) {
      if (!cfg.fbq.allowUnverifiedDownload) {
        throw new Error(
          `该平台没有内置摘要，且 fbq.allowUnverifiedDownload=false，拒绝写入未校验的二进制`,
        )
      }
      this.warn('fbq.allowUnverifiedDownload=true：跳过完整性校验，风险自负')
    }
    if (asset.size && buf.length !== asset.size) {
      throw new Error(`大小不符: 期望 ${asset.size} 实际 ${buf.length}（已丢弃下载文件）`)
    }

    const tmp = `${cached}.download`
    await fsp.writeFile(tmp, buf)
    await fsp.chmod(tmp, 0o755)
    await fsp.rename(tmp, cached)
    this.log(`FBQ 二进制就绪: ${cached} (${buf.length} bytes, sha256 ${actual.slice(0, 12)}…)`)
    return cached
  }

  /** 生成 fbq.yaml（幂等覆盖）。 */
  async writeConfig() {
    await fsp.mkdir(this.cfg.paths.dataDir, { recursive: true })
    const yaml = renderFbqYaml(this.cfg)
    const current = await fsp.readFile(this.cfg.paths.configYaml, 'utf8').catch(() => null)
    if (current !== yaml) {
      await fsp.writeFile(this.cfg.paths.configYaml, yaml, 'utf8')
      this.log(`写入配置: ${this.cfg.paths.configYaml}`)
    }
  }

  async prepare() {
    await this.writeConfig()
    this.binary = await this.ensureBinary()
    await fsp.mkdir(path.dirname(this.cfg.paths.socketPath), { recursive: true })
    // 残留 socket 会让 bind 失败
    await fsp.rm(this.cfg.paths.socketPath, { force: true }).catch(() => {})
  }

  /** 启动并等待 socket 可用。 */
  async start() {
    if (this.proc) return
    await this.prepare()
    this.stopping = false
    this.ready = false

    const args = ['-c', this.cfg.paths.configYaml, '--no-input']
    this.log(`启动 FBQ: ${this.binary} ${args.join(' ')} (cwd=${this.cfg.paths.dataDir})`)

    const child = spawn(this.binary, args, {
      cwd: this.cfg.paths.dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this.proc = child
    this.startedAt = new Date().toISOString()

    const onLine = (line) => {
      this.logBuffer.push(line)
      if (this.logBuffer.length > this.logLines) this.logBuffer.shift()
    }
    const wire = (stream) => {
      let buffered = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        buffered += chunk
        let idx
        while ((idx = buffered.indexOf('\n')) >= 0) {
          onLine(buffered.slice(0, idx))
          buffered = buffered.slice(idx + 1)
        }
      })
      stream.on('end', () => {
        if (buffered) onLine(buffered)
      })
    }
    wire(child.stdout)
    wire(child.stderr)

    child.on('exit', (code, signal) => {
      this.proc = null
      this.ready = false
      this.lastExit = { code, signal, at: new Date().toISOString() }
      if (this.stopping) {
        this.log(`FBQ 已退出 (code=${code})`)
        return
      }
      this.warn(`FBQ 意外退出 (code=${code} signal=${signal})，准备重启`)
      this.scheduleRestart()
    })

    await this.waitReady()
  }

  async waitReady() {
    const deadline = Date.now() + this.cfg.fbq.startTimeoutMs
    const base = this.cfg.fbq.basePath
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error('FBQ 进程在就绪前退出，检查最近日志')
      const out = await requestOnce({
        socketPath: this.cfg.paths.socketPath,
        path: `${base}/api/health`,
        timeoutMs: 3000,
      })
      if (out.status > 0 && out.status < 500) {
        this.ready = true
        this.restarts = 0
        this.log(`FBQ 就绪: unix://${this.cfg.paths.socketPath}${base}/`)
        return
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`FBQ 在 ${this.cfg.fbq.startTimeoutMs}ms 内未就绪，检查最近日志`)
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return
    if (this.restarts >= this.cfg.fbq.maxRestarts) {
      this.warn(`FBQ 重启次数超过上限 ${this.cfg.fbq.maxRestarts}，停止重试`)
      return
    }
    this.restarts += 1
    const delay = this.cfg.fbq.restartDelayMs * this.restarts
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null
      try {
        await this.start()
      } catch (e) {
        this.warn(`FBQ 重启失败: ${e.message}`)
        this.scheduleRestart()
      }
    }, delay)
    if (this.restartTimer.unref) this.restartTimer.unref()
  }

  async stop() {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.proc
    if (!child) {
      await fsp.rm(this.cfg.paths.socketPath, { force: true }).catch(() => {})
      return
    }
    this.ready = false
    await new Promise((resolve) => {
      const done = () => resolve()
      child.once('exit', done)
      try {
        child.kill('SIGTERM')
      } catch {
        resolve()
      }
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve()
      }, 5000)
      if (t.unref) t.unref()
    })
    this.proc = null
    await fsp.rm(this.cfg.paths.socketPath, { force: true }).catch(() => {})
    this.log('FBQ 已停止')
  }
}

module.exports = { FbqSupervisor }
