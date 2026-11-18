'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { URL, URLSearchParams } = require('url')

const m3u = require('./m3u')
const store = require('./store')

const PUBLIC_DIR = path.join(__dirname, 'public')
/* 支持多个上游，逗号分隔，失败自动切换；单个失败后熔断 60 秒 */
const LIVE_API_BASES = String(
  process.env.LIVE_API_BASES || process.env.LIVE_API_BASE || 'https://live-api.zrfme.com'
)
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)
const PASSWORD = process.env.PASSWORD || ''
const AUTH_COOKIE = 'la_auth'
const UA = m3u.DEFAULT_UA

const PLATFORMS = [
  { id: 'huya', name: '虎牙直播' },
  { id: 'douyu', name: '斗鱼直播' },
  { id: 'bilibili', name: '哔哩哔哩' },
  { id: 'douyin', name: '抖音直播' },
  { id: 'kuaishou', name: '快手直播' },
  { id: 'cc', name: '网易CC' },
  { id: 'soop', name: 'SOOP' },
  { id: 'yy', name: 'YY直播' },
]

const SITE_HEADERS = {
  huya: { referer: 'https://www.huya.com/', origin: 'https://www.huya.com' },
  douyu: { referer: 'https://www.douyu.com/', origin: 'https://www.douyu.com' },
  bilibili: { referer: 'https://live.bilibili.com/', origin: 'https://live.bilibili.com' },
  douyin: { referer: 'https://live.douyin.com/', origin: 'https://live.douyin.com' },
  kuaishou: { referer: 'https://live.kuaishou.com/', origin: 'https://live.kuaishou.com' },
  cc: { referer: 'https://cc.163.com/', origin: 'https://cc.163.com' },
  soop: { referer: 'https://www.sooplive.co.kr/', origin: 'https://www.sooplive.co.kr' },
  yy: { referer: 'https://www.yy.com/', origin: 'https://www.yy.com' },
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

/* ---------------- helpers ---------------- */

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit) {
  const max = limit || 1024 * 1024
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (d) => {
      size += d.length
      if (size > max) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseCookies(header) {
  const out = {}
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=')
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    })
  return out
}

function authToken(pw) {
  return crypto.createHmac('sha256', pw).update('libretv-live-agg').digest('hex')
}

function isAuthed(req) {
  if (!PASSWORD) return true
  const cookies = parseCookies(req.headers.cookie)
  const got = cookies[AUTH_COOKIE] || ''
  const want = authToken(PASSWORD)
  if (got.length !== want.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))
  } catch {
    return false
  }
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function checkUrl(raw) {
  const u = new URL(raw)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https')
  if (isPrivateHost(u.hostname)) throw new Error('禁止访问内网地址')
  return u
}

function serveStatic(res, relPath) {
  let p = String(relPath || '').replace(/^\/+/, '')
  if (!p) p = 'index.html'
  if (p.includes('..') || p.includes('\0')) return sendJson(res, 400, { error: '非法路径' })
  const full = path.join(PUBLIC_DIR, p)
  if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 400, { error: '非法路径' })
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' })
    const ext = path.extname(full).toLowerCase()
    const noCache = ext === '.html' || ext === '.js' || ext === '.css'
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
    })
    fs.createReadStream(full).pipe(res)
  })
}

/* ---------------- upstream live-api ---------------- */

const upstreamDownUntil = new Map()

async function forwardApi(res, apiPath, params) {
  let lastReason = '没有可用的上游地址'

  for (const base of LIVE_API_BASES) {
    if ((upstreamDownUntil.get(base) || 0) > Date.now()) {
      lastReason = '上游暂时不可用（熔断中）'
      continue
    }

    let target
    try {
      target = new URL(base + apiPath)
    } catch {
      lastReason = '上游地址配置无效'
      continue
    }
    Object.keys(params || {}).forEach((k) => {
      const v = params[k]
      if (v !== undefined && v !== null && v !== '') target.searchParams.set(k, v)
    })

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const r = await fetch(target, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': UA,
          Referer: 'https://live.zrfme.com/',
          Origin: 'https://live.zrfme.com',
          Accept: 'application/json',
        },
      })
      const text = await r.text()

      if (r.status >= 500) {
        upstreamDownUntil.set(base, Date.now() + 60000)
        lastReason = '上游返回 ' + r.status
        continue
      }

      upstreamDownUntil.delete(base)
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
      })
      res.end(text)
      return
    } catch (e) {
      upstreamDownUntil.set(base, Date.now() + 60000)
      lastReason =
        e && e.name === 'AbortError' ? '请求超时' : (e && e.cause && e.cause.code) || (e && e.message) || '网络错误'
    } finally {
      clearTimeout(timer)
    }
  }

  sendJson(res, 502, { error: '上游接口请求失败：' + lastReason })
}

/* ---------------- M3U ---------------- */

async function handleChannels(res, q) {
  const id = q.get('source') || ''
  const direct = q.get('url') || ''
  let src = null

  if (direct) {
    src = { id: 'direct', name: direct, url: direct, referer: q.get('ref') || '', ua: '' }
  } else if (id) {
    src = store.list().find((s) => s.id === id) || null
  }
  if (!src) return sendJson(res, 404, { error: '未找到该直播源' })

  try {
    checkUrl(src.url)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  try {
    const text = await m3u.fetchText(src.url, { referer: src.referer, ua: src.ua })
    const parsed = m3u.parseM3U(text)
    sendJson(res, 200, {
      name: parsed.name || src.name,
      count: parsed.channels.length,
      channels: parsed.channels,
      source: { id: src.id, name: src.name, url: src.url },
    })
  } catch (e) {
    sendJson(res, 502, { error: '拉取直播源失败：' + ((e && e.message) || e) })
  }
}

/* ---------------- stream proxy ---------------- */

function rewritePlaylist(text, baseUrl, q) {
  const site = q.get('site') || ''
  const ref = q.get('ref') || ''
  const origin = q.get('origin') || ''
  const ua = q.get('ua') || ''

  const wrap = (abs) => {
    const p = new URLSearchParams({ url: abs })
    if (site) p.set('site', site)
    if (ref) p.set('ref', ref)
    if (origin) p.set('origin', origin)
    if (ua) p.set('ua', ua)
    return '/live-agg/api/stream?' + p.toString()
  }

  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (whole, href) => {
          try {
            return 'URI="' + wrap(new URL(href, baseUrl).href) + '"'
          } catch {
            return whole
          }
        })
      }
      try {
        return wrap(new URL(t, baseUrl).href)
      } catch {
        return line
      }
    })
    .join('\n')
}

function proxyStream(req, res, q, depth) {
  const level = depth || 0
  if (level > 5) return sendJson(res, 502, { error: '上游重定向次数过多' })

  const raw = q.get('url')
  if (!raw) return sendJson(res, 400, { error: '缺少 url 参数' })

  let target
  try {
    target = checkUrl(raw)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const site = q.get('site') || ''
  const preset = SITE_HEADERS[site] || {}
  const headers = {
    'User-Agent': q.get('ua') || UA,
    Accept: '*/*',
  }
  const referer = q.get('ref') || preset.referer || ''
  const origin = q.get('origin') || preset.origin || ''
  if (referer) headers.Referer = referer
  if (origin) headers.Origin = origin
  if (req.headers.range) headers.Range = req.headers.range

  const mod = target.protocol === 'https:' ? https : http

  const fail = (msg) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: msg })
    } else {
      try {
        res.destroy()
      } catch (e) {}
    }
  }

  let upReq
  try {
    upReq = mod.request(
      target,
      { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, timeout: 30000 },
      (upRes) => {
        try {
          const ct = upRes.headers['content-type'] || ''
          const looksPlaylist = /mpegurl/i.test(ct) || /\.m3u8(?:$|\?)/i.test(target.pathname + target.search)

          if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
            upRes.resume()
            let next
            try {
              next = new URL(upRes.headers.location, target)
            } catch {
              return fail('上游重定向地址无效')
            }
            const nextQ = new URLSearchParams(q)
            nextQ.set('url', next.href)
            return proxyStream(req, res, nextQ, level + 1)
          }

          if (looksPlaylist && upRes.statusCode === 200) {
            const chunks = []
            let size = 0
            upRes.on('data', (d) => {
              size += d.length
              if (size > 6 * 1024 * 1024) {
                upRes.destroy()
                return
              }
              chunks.push(d)
            })
            upRes.on('end', () => {
              try {
                if (res.headersSent) return
                const text = rewritePlaylist(Buffer.concat(chunks).toString('utf8'), target, q)
                const buf = Buffer.from(text)
                res.writeHead(200, {
                  'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
                  'Content-Length': buf.length,
                  'Cache-Control': 'no-store',
                  'Access-Control-Allow-Origin': '*',
                })
                res.end(buf)
              } catch (e) {
                fail('播放列表处理失败')
              }
            })
            upRes.on('error', () => fail('读取播放列表失败'))
            return
          }

          if (res.headersSent) {
            upRes.resume()
            return
          }

          const out = {
            'Content-Type': ct || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
          }
          ;['content-length', 'content-range', 'accept-ranges'].forEach((k) => {
            if (upRes.headers[k]) out[k] = upRes.headers[k]
          })
          res.writeHead(upRes.statusCode || 200, out)
          upRes.pipe(res)
          upRes.on('error', () => {
            try {
              res.destroy()
            } catch (e) {}
          })
        } catch (e) {
          fail('流代理异常：' + ((e && e.message) || e))
        }
      }
    )
  } catch (e) {
    return fail('无法建立上游连接：' + ((e && e.message) || e))
  }

  upReq.on('timeout', () => upReq.destroy(new Error('timeout')))
  upReq.on('error', () => fail('上游流连接失败'))
  upReq.end()

  res.on('close', () => {
    try {
      upReq.destroy()
    } catch (e) {}
  })
}

/* ---------------- router ---------------- */

async function handle(req, res) {
  let urlObj
  try {
    urlObj = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'))
  } catch {
    return sendJson(res, 400, { error: 'bad url' })
  }

  const pathname = urlObj.pathname
  if (pathname === '/live-agg') {
    res.writeHead(302, { Location: '/live-agg/' })
    return res.end()
  }
  if (!pathname.startsWith('/live-agg/')) {
    res.writeHead(404)
    return res.end('Not Found')
  }

  const rest = pathname.slice('/live-agg'.length)
  const q = urlObj.searchParams

  if (rest === '/api/session') {
    return sendJson(res, 200, { required: !!PASSWORD, authed: isAuthed(req) })
  }

  if (rest === '/api/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      if (PASSWORD && String(body.password || '') === PASSWORD) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${AUTH_COOKIE}=${authToken(PASSWORD)}; Path=/live-agg; HttpOnly; SameSite=Lax; Max-Age=604800`,
        })
        return res.end(JSON.stringify({ ok: true }))
      }
      return sendJson(res, 401, { error: '密码错误' })
    } catch {
      return sendJson(res, 400, { error: '请求格式错误' })
    }
  }

  if (!rest.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
    return serveStatic(res, rest)
  }

  if (!isAuthed(req)) return sendJson(res, 401, { error: '未登录' })

  try {
    if (rest === '/api/platforms') return sendJson(res, 200, { platforms: PLATFORMS })
    if (rest === '/api/health')
      return sendJson(res, 200, { ok: true, apiBase: LIVE_API_BASES[0] || '', apiBases: LIVE_API_BASES })
    if (rest === '/api/search') {
      return forwardApi(res, '/api/search', { site: q.get('site'), kw: q.get('kw'), page: q.get('page') || '1' })
    }
    if (rest === '/api/recommend') {
      return forwardApi(res, '/api/recommend', { site: q.get('site'), page: q.get('page') || '1' })
    }
    if (rest === '/api/categories') {
      return forwardApi(res, '/api/categories', { site: q.get('site') })
    }
    if (rest === '/api/rooms') {
      return forwardApi(res, '/api/rooms', {
        site: q.get('site'),
        areaId: q.get('areaId'),
        parentAreaId: q.get('parentAreaId'),
        page: q.get('page') || '1',
      })
    }
    if (rest === '/api/status') {
      return forwardApi(res, '/api/status', { site: q.get('site'), roomIds: q.get('roomIds') })
    }
    if (rest === '/api/room') {
      return forwardApi(res, '/api/room', { site: q.get('site'), roomId: q.get('roomId') })
    }
    if (rest === '/api/play') {
      return forwardApi(res, '/api/play', {
        site: q.get('site'),
        roomId: q.get('roomId'),
        quality: q.get('quality'),
      })
    }
    if (rest === '/api/resolve') {
      return forwardApi(res, '/api/resolve', { url: q.get('url') })
    }

    if (rest === '/api/m3u/sources') {
      if (req.method === 'GET') return sendJson(res, 200, { sources: store.list() })
      if (req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req))
          const item = store.add(body)
          return sendJson(res, 200, { ok: true, source: item })
        } catch (e) {
          return sendJson(res, 400, { error: (e && e.message) || '添加失败' })
        }
      }
    }
    if (rest === '/api/m3u/sources' && req.method === 'DELETE') {
      const ok = store.remove(q.get('id') || '')
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '不存在' })
    }
    if (rest === '/api/m3u/sources/delete' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        const ok = store.remove(String(body.id || ''))
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '不存在' })
      } catch {
        return sendJson(res, 400, { error: '请求格式错误' })
      }
    }
    if (rest === '/api/m3u/channels') return handleChannels(res, q)

    if (rest === '/api/stream' || rest === '/api/proxy') return proxyStream(req, res, q)

    return sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: (e && e.message) || 'server error' })
  }
}

module.exports = { handle, PLATFORMS }
