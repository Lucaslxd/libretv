'use strict'

/**
 * 直播聚合独立部署入口（不依赖 Next.js / 主站）
 *   PORT      监听端口，默认 8080
 *   HOST      监听地址，默认 0.0.0.0
 *   PASSWORD  可选，设置后访问需要密码
 *
 * 启动：node standalone.js
 */
const http = require('http')
const { handle } = require('./index.js')

const PORT = parseInt(process.env.PORT, 10) || 8080
const HOST = process.env.HOST || '0.0.0.0'

const server = http.createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0]
  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { Location: '/live-agg/' })
    return res.end()
  }
  Promise.resolve(handle(req, res)).catch((e) => {
    console.error('[live-agg] handler error:', e)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    try {
      res.end('server error')
    } catch (err) {}
  })
})

server.listen(PORT, HOST, () => {
  console.log('[live-agg] http://' + HOST + ':' + PORT + '/live-agg/')
})
