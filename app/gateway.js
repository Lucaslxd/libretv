'use strict'

/**
 * LibreTV 网关
 * - 监听对外端口（默认 8080）
 * - /live-agg/* 交给新板块（直播聚合）
 * - 其余请求转发给内部 Next.js standalone 服务（127.0.0.1:内部端口）
 */

const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

// 固定监听所有网卡，允许局域网访问（不走 HOSTNAME 环境变量，避免被启动脚本/父进程覆盖）
const HOST = '0.0.0.0'
const PORT = parseInt(process.env.PORT, 10) || 8080
const NEXT_HOST = '127.0.0.1'
const NEXT_PORT = parseInt(process.env.NEXT_INTERNAL_PORT, 10) || (PORT === 8080 ? 3210 : PORT + 1)

const SERVER_PATH = path.join(__dirname, 'server.js')
const LIVE_AGG_PREFIX = '/live-agg'

process.on('uncaughtException', (err) => {
  console.error('[gateway] 未捕获异常，已记录并继续运行:', err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[gateway] 未处理的 Promise 拒绝，已记录并继续运行:', reason && reason.stack ? reason.stack : reason)
})

let child = null
let server = null
let shuttingDown = false

function startNext() {
  const env = Object.assign({}, process.env, {
    PORT: String(NEXT_PORT),
    HOSTNAME: NEXT_HOST,
  })
  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: __dirname,
    env: env,
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error('[gateway] 内部 Next 服务已退出 (code=' + code + ', signal=' + signal + ')')
    process.exit(code || 1)
  })
  child.on('error', (err) => {
    console.error('[gateway] 启动内部 Next 服务失败:', err && err.message)
    process.exit(1)
  })
}

function waitForNext(timeoutMs) {
  const limit = timeoutMs || 60000
  const started = Date.now()
  return new Promise((resolve, reject) => {
    let settled = false

    function finish(err) {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    function attempt() {
      if (Date.now() - started > limit) {
        return finish(new Error('内部 Next 服务启动超时'))
      }
      const req = http.get(
        { host: NEXT_HOST, port: NEXT_PORT, path: '/api/status', timeout: 2500 },
        (res) => {
          res.resume()
          if (res.statusCode && res.statusCode < 500) return finish()
          setTimeout(attempt, 300)
        }
      )
      req.on('timeout', () => {
        req.destroy()
        setTimeout(attempt, 300)
      })
      req.on('error', () => setTimeout(attempt, 300))
    }

    attempt()
  })
}

function injectEntry(html) {
  const snippet =
    '<style>' +
    '#la-entry{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:8px;' +
    'padding:11px 16px;border-radius:999px;background:linear-gradient(135deg,#7c5cff,#22d3ee);color:#fff;' +
    'font:600 14px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;text-decoration:none;' +
    'box-shadow:0 10px 28px rgba(0,0,0,.45);transition:transform .15s,filter .15s}' +
    '#la-entry:hover{transform:translateY(-2px);filter:brightness(1.08)}' +
    '#la-entry .d{width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 8px #fff}' +
    '@media(max-width:720px){#la-entry{right:12px;bottom:12px;padding:10px 13px;font-size:13px}}' +
    '</style>' +
    '<a id="la-entry" href="/live-agg/" title="直播聚合"><span class="d"></span>直播聚合</a>'
  const idx = html.lastIndexOf('</body>')
  if (idx >= 0) return html.slice(0, idx) + snippet + html.slice(idx)
  return html + snippet
}

function proxyToNext(req, res, body) {
  const headers = Object.assign({}, req.headers)
  delete headers.connection
  delete headers.host
  delete headers['proxy-connection']

  const wantsHtml = (req.headers.accept || '').indexOf('text/html') >= 0
  if (wantsHtml) delete headers['accept-encoding']
  headers.host = NEXT_HOST + ':' + NEXT_PORT

  const proxyReq = http.request(
    { host: NEXT_HOST, port: NEXT_PORT, method: req.method, path: req.url, headers: headers },
    (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || ''
      const canInject =
        wantsHtml &&
        req.method === 'GET' &&
        proxyRes.statusCode === 200 &&
        /text\/html/i.test(ct) &&
        !proxyRes.headers['content-encoding']

      if (canInject) {
        const chunks = []
        let size = 0
        let tooBig = false
        proxyRes.on('data', (d) => {
          size += d.length
          if (size > 3 * 1024 * 1024) {
            tooBig = true
            proxyRes.destroy()
            return
          }
          chunks.push(d)
        })
        proxyRes.on('end', () => {
          if (tooBig) return
          const html = injectEntry(Buffer.concat(chunks).toString('utf8'))
          const buf = Buffer.from(html, 'utf8')
          const out = Object.assign({}, proxyRes.headers)
          delete out['content-length']
          delete out['transfer-encoding']
          out['content-length'] = buf.length
          res.writeHead(proxyRes.statusCode, out)
          res.end(buf)
        })
        proxyRes.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('网关读取上游响应失败')
          }
        })
        return
      }

      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
      proxyRes.on('error', () => {
        try {
          res.destroy()
        } catch (e) {}
      })
    }
  )

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('网关无法连接后端服务')
    }
  })

  if (body && body.length) proxyReq.write(body)
  proxyReq.end()

  res.on('close', () => {
    try {
      proxyReq.destroy()
    } catch (e) {}
  })
}

const liveAgg = require('./live-agg')

function handleRequest(req, res) {
  const url = req.url || '/'
  const pathname = url.split('?')[0]

  if (pathname === LIVE_AGG_PREFIX || pathname.indexOf(LIVE_AGG_PREFIX + '/') === 0) {
    Promise.resolve(liveAgg.handle(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: (err && err.message) || 'server error' }))
      }
    })
    return
  }

  // 原内置直播页 /live 重定向到新板块，让原有"直播"导航也能进入
  if (pathname === '/live' || pathname === '/live/') {
    res.writeHead(302, { Location: '/live-agg/' })
    res.end()
    return
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    proxyToNext(req, res, null)
    return
  }

  const chunks = []
  let size = 0
  req.on('data', (d) => {
    size += d.length
    if (size > 20 * 1024 * 1024) {
      req.destroy()
      return
    }
    chunks.push(d)
  })
  req.on('end', () => proxyToNext(req, res, Buffer.concat(chunks)))
  req.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(400)
      res.end()
    }
  })
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    if (child) child.kill()
  } catch (e) {}
  const done = () => process.exit(0)
  try {
    if (server) server.close(done)
    else done()
  } catch (e) {
    done()
  }
  setTimeout(done, 3000)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => {
  try {
    if (child) child.kill()
  } catch (e) {}
})

;(async function main() {
  console.log('[gateway] 启动内部 Next 服务，端口 ' + NEXT_PORT + ' ...')
  startNext()
  try {
    await waitForNext(90000)
  } catch (err) {
    console.error('[gateway] ' + ((err && err.message) || err))
    shutdown()
    return
  }

  server = http.createServer(handleRequest)
  server.on('clientError', (err, socket) => {
    try {
      socket.destroy()
    } catch (e) {}
  })
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[gateway] 端口 ' + PORT + ' 已被占用，请修改 PORT 后重试')
    } else {
      console.error('[gateway] HTTP 服务错误:', err && err.message)
    }
  })
  server.listen(PORT, HOST, () => {
    console.log('[LibreTV] 主站      http://' + HOST + ':' + PORT + '/')
    console.log('[LibreTV] 直播聚合  http://' + HOST + ':' + PORT + '/live-agg/')
  })
})()
