/* LibreTV 数据桥：Web 端走本地服务；App 端直连上游 API（无需任何服务器） */
;(function () {
  'use strict'

  /* 上游可能有多个，按顺序尝试 */
  var UPSTREAMS = ['https://live-api.zrfme.com']
  var UP_REFERER = 'https://live.zrfme.com/'
  var UP_ORIGIN = 'https://live.zrfme.com'
  var SOURCES_KEY = 'ltb_m3u_sources'
  var SEED_KEY = 'ltb_m3u_seeded'
  var DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

  /* App 内置的后端逻辑：原服务端自有接口（非上游转发）在包里本地实现 */
  var PLATFORMS = [
    { id: 'huya', name: '虎牙直播' },
    { id: 'douyu', name: '斗鱼直播' },
    { id: 'bilibili', name: '哔哩哔哩' },
    { id: 'douyin', name: '抖音直播' },
    { id: 'kuaishou', name: '快手直播' },
    { id: 'cc', name: '网易CC' },
    { id: 'soop', name: 'SOOP' },
    { id: 'yy', name: 'YY直播' },
  ]

  /* 与 app/live-agg/store.js 的默认源保持一致：上游挂了也能看 */
  var DEFAULT_SOURCES = [
    { name: 'IPTV-org 中国', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
    {
      name: '国内 IPTV 合集',
      url: 'https://ghproxy.net/https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u',
    },
  ]

  /* 运行环境判断：Capacitor 由原生注入，脚本加载顺序不保证，故全部惰性获取 */
  function cap() {
    return window.Capacitor || null
  }

  function isNative() {
    try {
      var c = cap()
      var n = !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform())
      return n && !!httpPlugin()
    } catch (e) {
      return false
    }
  }

  var httpCache = null

  function httpPlugin() {
    if (httpCache) return httpCache
    var c = cap()
    if (!c) return null
    if (c.Plugins && c.Plugins.CapacitorHttp) return (httpCache = c.Plugins.CapacitorHttp)
    try {
      if (typeof c.registerPlugin === 'function') return (httpCache = c.registerPlugin('CapacitorHttp'))
    } catch (e) {}
    return null
  }

  /* ---------- 原生 HTTP ---------- */

  function rawRequest(url, method, headers, data, responseType) {
    var h = httpPlugin()
    if (!h) return Promise.reject(new Error('原生 HTTP 不可用'))
    return h.request({
      url: url,
      method: method || 'GET',
      headers: headers || {},
      data: data,
      responseType: responseType || 'text',
      connectTimeout: 20000,
      readTimeout: 60000,
    })
  }

  async function upstreamOnce(base, path, opts, headers, data) {
    var r = await rawRequest(base + path, opts.method, headers, data, 'text')
    var body = r.data
    var json = null
    try {
      json = typeof body === 'string' ? JSON.parse(body) : body
    } catch (e) {}
    if (r.status >= 400) {
      var err = new Error((json && json.error) || 'HTTP ' + r.status)
      err.status = r.status
      throw err
    }
    return json != null ? json : body
  }

  async function upstreamApi(path, opts) {
    opts = opts || {}
    var headers = { Referer: UP_REFERER, Origin: UP_ORIGIN, Accept: 'application/json' }
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (k) {
        headers[k] = opts.headers[k]
      })
    }
    var data
    if (opts.body) {
      try {
        data = JSON.parse(opts.body)
      } catch (e) {
        data = opts.body
      }
    }

    var lastErr = null
    for (var i = 0; i < UPSTREAMS.length; i++) {
      try {
        return await upstreamOnce(UPSTREAMS[i], path, opts, headers, data)
      } catch (e) {
        lastErr = e
        /* 4xx 是业务错误，换上游也没用 */
        if (e && e.status && e.status < 500) throw e
      }
    }
    throw lastErr || new Error('上游接口不可用')
  }

  async function webApi(path, opts) {
    var res = await fetch('.' + path, opts || {})
    var ct = res.headers.get('content-type') || ''
    var data = ct.indexOf('application/json') >= 0 ? await res.json() : await res.text()
    if (!res.ok) {
      var err = new Error((data && data.error) || 'HTTP ' + res.status)
      err.status = res.status
      throw err
    }
    return data
  }

  /* 服务端自有接口（不转发上游）：App 内等价实现，保证前后端一起打包后功能一致 */
  function localApi(pathname, method) {
    if (pathname === '/api/session') return { required: false, authed: true }
    if (pathname === '/api/login' && method === 'POST') return { ok: true }
    if (pathname === '/api/health') return { ok: true, mode: 'app', apiBases: UPSTREAMS.slice() }
    if (pathname === '/api/platforms') return { platforms: PLATFORMS }
    return undefined
  }

  function apiPath(path) {
    var i = String(path || '').indexOf('?')
    return i < 0 ? String(path || '') : String(path).slice(0, i)
  }

  function api(path, opts) {
    if (!isNative()) return webApi(path, opts)
    var local = localApi(apiPath(path), String((opts && opts.method) || 'GET').toUpperCase())
    if (local !== undefined) return Promise.resolve(local)
    return upstreamApi(path, opts)
  }

  /* ---------- iOS 本地代理 ----------
     iOS 上 <video> 播 HLS 由 AVFoundation 自己发请求，JS 加不了 Referer/UA，
     所以改走 App 内的 127.0.0.1 回环代理，由原生侧补请求头并改写 m3u8 分片地址。 */

  var PROXY_FALLBACK = 'http://127.0.0.1:8899'
  var proxyBase = ''
  var proxyPlugin = null

  function platform() {
    try {
      var c = cap()
      return c && typeof c.getPlatform === 'function' ? c.getPlatform() : 'web'
    } catch (e) {
      return 'web'
    }
  }

  function proxyNative() {
    if (proxyPlugin) return proxyPlugin
    var c = cap()
    if (c && typeof c.registerPlugin === 'function') {
      try {
        proxyPlugin = c.registerPlugin('LTProxy')
      } catch (e) {}
    }
    return proxyPlugin
  }

  function proxySupported() {
    return isNative() && platform() === 'ios'
  }

  function proxyOrigin() {
    return proxyBase || PROXY_FALLBACK
  }

  function base64URL(value) {
    var bytes = new TextEncoder().encode(value)
    var binary = ''
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function proxyUrl(url, ref, ua) {
    var out = proxyOrigin() + '/p?u=' + base64URL(url)
    if (ref) out += '&r=' + encodeURIComponent(ref)
    if (ua) out += '&a=' + encodeURIComponent(ua)
    return out
  }

  /* 原生优先用 8899，被占用会顺延，所以启动后校正一次 */
  function syncProxy() {
    var plugin = proxyNative()
    if (!plugin || typeof plugin.getBase !== 'function') return
    plugin
      .getBase()
      .then(function (res) {
        if (res && res.base) proxyBase = res.base
      })
      .catch(function () {})
  }

  /* ---------- 播放地址 ---------- */

  function streamUrl(item, site) {
    if (isNative()) {
      if (proxySupported() && /^https?:\/\//i.test((item && item.url) || '')) {
        return proxyUrl(item.url, item.ref, item.ua)
      }
      return item.url
    }
    var p = new URLSearchParams({ url: item.url })
    if (site) p.set('site', site)
    if (item.ref) p.set('ref', item.ref)
    if (item.ua) p.set('ua', item.ua)
    return 'api/stream?' + p.toString()
  }

  /* App 内播放器（hls.js 等）走原生 HTTP 时补上 Referer / UA */
  function applyStreamHeaders(xhr, item) {
    if (!xhr || !item || !isNative()) return
    try {
      if (item.ref) xhr.setRequestHeader('Referer', item.ref)
      if (item.ua) xhr.setRequestHeader('User-Agent', item.ua)
    } catch (e) {}
  }

  /* ---------- M3U ---------- */

  function readSources() {
    try {
      var arr = JSON.parse(localStorage.getItem(SOURCES_KEY) || '[]')
      return Array.isArray(arr) ? arr : []
    } catch (e) {
      return []
    }
  }

  function writeSources(arr) {
    try {
      localStorage.setItem(SOURCES_KEY, JSON.stringify(arr))
    } catch (e) {}
  }

  function idFor(url) {
    var h = 0
    for (var i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0
    return 's' + (h >>> 0).toString(36)
  }

  /* 首次启动写入默认源；用户删空后不再塞回来（与服务端 store.js 同语义） */
  function seedSources() {
    try {
      if (localStorage.getItem(SEED_KEY)) return
      localStorage.setItem(SEED_KEY, '1')
      if (localStorage.getItem(SOURCES_KEY) !== null) return
      writeSources(
        DEFAULT_SOURCES.map(function (s) {
          return { id: idFor(s.url), name: s.name, url: s.url, referer: '', ua: '' }
        })
      )
    } catch (e) {}
  }

  function parseAttrs(input) {
    var attrs = {}
    var m
    var quoted = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g
    while ((m = quoted.exec(input))) attrs[m[1].toLowerCase()] = m[2]
    var plain = /([A-Za-z0-9_-]+)\s*=\s*([^\s"',]+)/g
    while ((m = plain.exec(input))) {
      var k = m[1].toLowerCase()
      if (!(k in attrs)) attrs[k] = m[2]
    }
    return attrs
  }

  function parseM3U(text) {
    var lines = String(text || '')
      .replace(/\r/g, '')
      .split('\n')
    var channels = []
    var playlistName = ''
    var pending = null

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim()
      if (!line) continue
      if (line.indexOf('#EXTM3U') === 0) continue
      if (line.indexOf('#PLAYLIST:') === 0) {
        playlistName = line.slice(10).trim()
        continue
      }
      if (line.indexOf('#EXTINF:') === 0) {
        var body = line.slice(8)
        var comma = body.indexOf(',')
        var attrStr = comma >= 0 ? body.slice(0, comma) : body
        var title = comma >= 0 ? body.slice(comma + 1).trim() : ''
        var attrs = parseAttrs(attrStr)
        pending = { attrs: attrs, title: title, group: attrs['group-title'] || '', referer: '', ua: '' }
        continue
      }
      if (line.indexOf('#EXTGRP:') === 0) {
        var g = line.slice(8).trim()
        if (pending && !pending.attrs['group-title']) pending.group = g
        continue
      }
      if (line.indexOf('#EXTVLCOPT:') === 0) {
        if (pending) {
          var opt = line.slice(11).trim()
          var eq = opt.indexOf('=')
          if (eq > 0) {
            var key = opt.slice(0, eq).toLowerCase()
            var val = opt.slice(eq + 1)
            if (key === 'http-referrer' || key === 'http-referer') pending.referer = val
            if (key === 'http-user-agent') pending.ua = val
          }
        }
        continue
      }
      if (line.charAt(0) === '#') continue

      var name = (pending && (pending.title || pending.attrs['tvg-name'])) || line
      channels.push({
        id: (pending && pending.attrs['tvg-id']) || 'ch-' + channels.length,
        name: String(name).trim() || line,
        url: line,
        logo: (pending && pending.attrs['tvg-logo']) || '',
        group: (pending && pending.group) || '未分组',
        tvgId: (pending && pending.attrs['tvg-id']) || '',
        referer: (pending && pending.referer) || '',
        ua: (pending && pending.ua) || '',
      })
      pending = null
    }

    return { name: playlistName, channels: channels }
  }

  async function fetchPlaylistText(url, referer, ua) {
    if (!isNative()) throw new Error('仅 App 内支持')
    var headers = { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*' }
    if (referer) headers.Referer = referer
    var r = await rawRequest(url, 'GET', headers, undefined, 'text')
    if (r.status >= 400) throw new Error('HTTP ' + r.status)
    return typeof r.data === 'string' ? r.data : ''
  }

  var m3u = {
    async list() {
      if (!isNative()) return (await webApi('/api/m3u/sources')).sources || []
      seedSources()
      return readSources()
    },
    async add(input) {
      var url = String((input && input.url) || '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('地址必须以 http:// 或 https:// 开头')
      if (!isNative()) {
        return webApi('/api/m3u/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input || {}),
        })
      }
      var arr = readSources()
      if (arr.some(function (s) { return s.url === url })) throw new Error('该直播源已存在')
      var item = {
        id: idFor(url),
        name: String((input && input.name) || '').trim() || url,
        url: url,
        referer: String((input && input.referer) || '').trim(),
        ua: String((input && input.ua) || '').trim(),
      }
      arr.push(item)
      writeSources(arr)
      return { ok: true, source: item }
    },
    async remove(id) {
      if (!isNative()) {
        return webApi('/api/m3u/sources?id=' + encodeURIComponent(id), { method: 'DELETE' })
      }
      var arr = readSources().filter(function (s) { return s.id !== id })
      writeSources(arr)
      return { ok: true }
    },
    async channels(sourceId) {
      if (!isNative()) return (await webApi('/api/m3u/channels?source=' + encodeURIComponent(sourceId))).channels || []
      var src = readSources().filter(function (s) { return s.id === sourceId })[0]
      if (!src) throw new Error('未找到该直播源')
      var text = await fetchPlaylistText(src.url, src.referer, src.ua)
      return parseM3U(text).channels
    },
  }

  window.LTBridge = {
    api: api,
    streamUrl: streamUrl,
    applyStreamHeaders: applyStreamHeaders,
    proxyUrl: proxyUrl,
    proxySupported: proxySupported,
    parseM3U: parseM3U,
    m3u: m3u,
  }

  /* 动态判断，脚本加载时 Capacitor 可能还没注入 */
  Object.defineProperty(window.LTBridge, 'native', { get: isNative, enumerable: true })
  Object.defineProperty(window.LTBridge, 'proxyBase', { get: proxyOrigin, enumerable: true })

  /* 尽早拿到代理真实端口（原生启动时可能会顺延端口） */
  syncProxy()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncProxy)
  }
  setTimeout(syncProxy, 600)
})()
