/* 独立直播播放页：全屏 + 失败自动切换线路/清晰度/同名频道 */
;(function () {
  'use strict'

  var $ = function (s) {
    return document.querySelector(s)
  }

  var els = {
    title: $('#title'),
    quality: $('#quality'),
    line: $('#line'),
    refresh: $('#refresh'),
    fullscreen: $('#fullscreen'),
    stage: $('#stage'),
    video: $('#video'),
    overlay: $('#overlay'),
    bigplay: $('#bigplay'),
    status: $('#status'),
    hintbar: $('#hintbar'),
    login: $('#login'),
    loginForm: $('#login-form'),
    loginPassword: $('#login-password'),
    loginError: $('#login-error'),
  }

  var qs = new URLSearchParams(location.search)
  var S = {
    kind: qs.get('kind') === 'channel' ? 'channel' : 'room',
    site: qs.get('site') || '',
    roomId: qs.get('roomId') || '',
    sourceId: qs.get('source') || '',
    channelName: qs.get('name') || '',
    channelUrl: qs.get('url') || '',
    ref: qs.get('ref') || '',
    ua: qs.get('ua') || '',
    title: qs.get('title') || qs.get('name') || '直播播放',
    qualities: [],
    quality: '',
    triedQualities: {},
    candidates: [],
    candidateIdx: 0,
    playing: false,
    failing: false,
  }

  var hls = null
  var flv = null
  var watchdog = null
  var stallTimer = null
  var lastTime = -1
  var seq = 0

  /* ---------- utils ---------- */

  function enc(v) {
    return encodeURIComponent(v == null ? '' : v)
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function setStatus(msg) {
    els.status.textContent = msg || ''
    if (msg) els.status.classList.remove('hidden')
    else els.status.classList.add('hidden')
  }

  function setHint(msg) {
    els.hintbar.textContent = msg || ''
  }

  function showOverlay(show) {
    els.overlay.classList.toggle('hidden', !show)
  }

  async function api(path, opts) {
    try {
      return await window.LTBridge.api(path, opts)
    } catch (e) {
      if (e.status === 401) els.login.classList.remove('hidden')
      throw e
    }
  }

  /* ---------- auth ---------- */

  els.loginForm.addEventListener('submit', async function (ev) {
    ev.preventDefault()
    els.loginError.textContent = ''
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: els.loginPassword.value }),
      })
      els.login.classList.add('hidden')
      boot()
    } catch (e) {
      els.loginError.textContent = e.message
    }
  })

  /* ---------- 播放器 ---------- */

  function destroy() {
    clearTimeout(watchdog)
    watchdog = null
    clearInterval(stallTimer)
    stallTimer = null
    lastTime = -1
    if (hls) {
      try {
        hls.destroy()
      } catch (e) {}
      hls = null
    }
    if (flv) {
      try {
        flv.pause()
        flv.unload()
        flv.detachMediaElement()
        flv.destroy()
      } catch (e) {}
      flv = null
    }
    els.video.onplaying = null
    els.video.onloadeddata = null
    els.video.onerror = null
    try {
      els.video.pause()
      els.video.removeAttribute('src')
      els.video.load()
    } catch (e) {}
  }

  function playStream(c) {
    var mySeq = ++seq
    S.playing = false
    S.failing = false
    destroy()
    showOverlay(false)
    setStatus('连接中…')
    setHint(
      (S.kind === 'room' ? '清晰度：' + (S.quality || '默认') : '频道线路') +
        (S.candidates.length > 1 ? ' · 线路 ' + (S.candidateIdx + 1) + '/' + S.candidates.length : '')
    )

    clearTimeout(watchdog)
    watchdog = setTimeout(function () {
      if (mySeq === seq && !S.playing) handleFail('加载超时')
    }, 18000)

    var src = window.LTBridge.streamUrl({ url: c.url, ref: c.ref, ua: c.ua }, c.site)

    var f = String(c.format || '').toLowerCase()
    var isHls = f === 'm3u8' || f === 'hls' || /\.m3u8(?:$|\?)/i.test(c.url)
    var isFlv = f === 'flv' || /\.flv(?:$|\?)/i.test(c.url)

    var fail = function (reason) {
      if (mySeq !== seq) return
      if (S.failing) return
      S.failing = true
      handleFail(reason || '播放失败')
    }

    /* 卡顿检测：播放中 12 秒画面不前进视为失败 */
    lastTime = -1
    clearInterval(stallTimer)
    stallTimer = setInterval(function () {
      if (mySeq !== seq) {
        clearInterval(stallTimer)
        stallTimer = null
        return
      }
      if (!S.playing || els.video.paused) return
      var t = els.video.currentTime
      if (t === lastTime) return fail('画面卡住')
      lastTime = t
    }, 6000)

    els.video.onplaying = function () {
      if (mySeq !== seq) return
      S.playing = true
      lastTime = -1
      clearTimeout(watchdog)
      setStatus('')
      showOverlay(false)
    }
    els.video.onloadeddata = function () {
      if (mySeq !== seq) return
      clearTimeout(watchdog)
      if (S.playing) setStatus('')
    }
    els.video.onerror = function () {
      if (mySeq !== seq) return
      if (!isHls && !isFlv) fail('视频加载失败')
    }

    if (isHls) {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 30,
          xhrSetup: function (xhr) {
            window.LTBridge.applyStreamHeaders(xhr, c)
          },
        })
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          if (mySeq !== seq) return
          els.video.play().catch(function () {
            showOverlay(true)
          })
        })
        hls.on(window.Hls.Events.ERROR, function (_e, data) {
          if (mySeq !== seq) return
          if (data && data.fatal) fail('HLS 播放失败')
        })
        hls.loadSource(src)
        hls.attachMedia(els.video)
        return
      }
      if (els.video.canPlayType('application/vnd.apple.mpegurl')) {
        els.video.src = src
        els.video.play().catch(function () {
          showOverlay(true)
        })
        return
      }
      return fail('浏览器不支持 HLS')
    }

    if (isFlv) {
      if (window.mpegts && window.mpegts.isSupported()) {
        /* mpegts 的 worker 内 fetch 无法解析相对路径，必须传绝对地址 */
        /* App 内 worker 无法使用原生 HTTP（会被 CORS 拦截），关闭 worker */
        flv = window.mpegts.createPlayer(
          { type: 'flv', isLive: true, url: new URL(src, location.href).href },
          { enableWorker: !(window.LTBridge && window.LTBridge.native), lazyLoad: false }
        )
        flv.on(window.mpegts.Events.ERROR, function (_type, detail) {
          if (mySeq !== seq) return
          fail('FLV 播放失败' + (detail && detail.msg ? '：' + detail.msg : ''))
        })
        flv.attachMediaElement(els.video)
        flv.load()
        flv.play().catch(function () {
          showOverlay(true)
        })
        return
      }
      return fail('浏览器不支持 FLV')
    }

    els.video.src = src
    els.video.play().catch(function () {
      showOverlay(true)
    })
  }

  function playCandidate(i) {
    if (i >= S.candidates.length) {
      if (S.kind === 'room') return nextQuality()
      return fail('所有线路都不可用')
    }
    S.candidateIdx = i
    if (!els.line.classList.contains('hidden')) els.line.value = String(i)
    var c = S.candidates[i]
    playStream(c)
  }

  function handleFail(reason) {
    destroy()
    setStatus('当前线路不可用（' + reason + '），正在自动切换…', true)
    setHint('自动切换中…')
    var next = S.candidateIdx + 1
    setTimeout(function () {
      playCandidate(next)
    }, 700)
  }

  function fail(reason) {
    destroy()
    S.playing = false
    setStatus('播放失败：' + reason + '。可点击「刷新」重试。', true)
    setHint('')
    showOverlay(false)
  }

  function nextQuality() {
    for (var i = 0; i < S.qualities.length; i++) {
      var key = S.qualities[i].key
      if (!S.triedQualities[key || 'default']) {
        return loadQuality(key)
      }
    }
    fail('所有清晰度和线路都不可用')
  }

  /* ---------- 房间 ---------- */

  /* 起始线路：跳过本机播放器不支持的格式（iOS 无 FLV/MSE） */
  function pickStart() {
    var canFlv = !!(window.mpegts && window.mpegts.isSupported())
    var canHls = !!(window.Hls && window.Hls.isSupported()) || !!els.video.canPlayType('application/vnd.apple.mpegurl')
    for (var i = 0; i < S.candidates.length; i++) {
      var c = S.candidates[i]
      var u = String(c.url || '')
      var f = String(c.format || '').toLowerCase()
      var isFlv = f === 'flv' || /\.flv(?:$|\?)/i.test(u)
      var isHls = f === 'm3u8' || f === 'hls' || /\.m3u8(?:$|\?)/i.test(u)
      if (isFlv && !canFlv) continue
      if (isHls && !canHls) continue
      return i
    }
    return 0
  }

  function renderQualities() {
    if (S.qualities.length < 2) {
      els.quality.classList.add('hidden')
      return
    }
    els.quality.innerHTML = S.qualities
      .map(function (q) {
        return '<option value="' + esc(q.key) + '">' + esc(q.name) + '</option>'
      })
      .join('')
    els.quality.classList.remove('hidden')
    els.quality.value = S.quality || (S.qualities[0] && S.qualities[0].key) || ''
  }

  function renderLines() {
    if (!S.candidates || S.candidates.length < 2) {
      els.line.classList.add('hidden')
      return
    }
    els.line.innerHTML = S.candidates
      .map(function (c, i) {
        return '<option value="' + i + '">' + esc(c.line || '线路 ' + (i + 1)) + '</option>'
      })
      .join('')
    els.line.classList.remove('hidden')
    els.line.value = String(S.candidateIdx)
  }

  async function loadQuality(key) {
    setStatus('获取播放地址…')
    try {
      var data = await api(
        '/api/play?site=' + enc(S.site) + '&roomId=' + enc(S.roomId) + (key ? '&quality=' + enc(key) : '')
      )
      S.quality = key
      S.triedQualities[key || 'default'] = true
      if (!els.quality.classList.contains('hidden')) els.quality.value = key || els.quality.value
      var urls = data.urls || []
      if (!urls.length) return nextQuality()
      S.candidates = urls.map(function (u) {
        return { url: u.url, format: u.format, line: u.line || u.format || '', site: S.site, ref: '', ua: '' }
      })
      S.candidateIdx = pickStart()
      renderLines()
      playCandidate(S.candidateIdx)
    } catch (e) {
      fail('获取播放地址失败：' + e.message)
    }
  }

  async function setupRoom() {
    if (!S.site || !S.roomId) return fail('缺少房间参数')
    setStatus('获取房间信息…')
    try {
      var info = await api('/api/room?site=' + enc(S.site) + '&roomId=' + enc(S.roomId))
      S.roomId = info.roomId || S.roomId
      S.title = info.title || S.title
      els.title.textContent = S.title
      document.title = S.title + ' · 直播'
      S.qualities = info.qualities || []
      renderQualities()
      await loadQuality('')
    } catch (e) {
      fail('获取房间失败：' + e.message)
    }
  }

  /* ---------- M3U 频道 ---------- */

  async function setupChannel() {
    setStatus('加载频道线路…')
    var alts = []
    if (S.channelUrl) {
      alts.push({ url: S.channelUrl, format: '', line: '当前线路', site: '', ref: S.ref, ua: S.ua })
    }
    if (S.sourceId && S.channelName) {
      try {
        var list = await window.LTBridge.m3u.channels(S.sourceId)
        var want = S.channelName.trim().toLowerCase()
        list.forEach(function (c) {
          if (!c.url) return
          if (String(c.name || '').trim().toLowerCase() !== want) return
          if (alts.some(function (a) { return a.url === c.url })) return
          alts.push({ url: c.url, format: '', line: c.group || '备用线路', site: '', ref: c.referer || '', ua: c.ua || '' })
        })
      } catch (e) {}
    }
    if (!alts.length) return fail('没有可用的频道地址')
    S.candidates = alts
    S.candidateIdx = 0
    renderLines()
    playCandidate(0)
  }

  /* ---------- 全屏 ---------- */

  /* App(WebView) 不支持 Fullscreen API 时的伪全屏：把舞台铺满视口 */
  function pseudoFullscreen(on) {
    var next = typeof on === 'boolean' ? on : !els.stage.classList.contains('pseudo-full')
    els.stage.classList.toggle('pseudo-full', next)
    document.body.classList.toggle('pseudo-full', next)
    els.fullscreen.textContent = next ? '退出全屏' : '全屏'
  }

  function toggleFullscreen() {
    var el = els.stage
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(function () {})
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
      return
    }
    if (els.stage.classList.contains('pseudo-full')) {
      pseudoFullscreen(false)
      return
    }
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(function () {
        fallbackFullscreen()
      })
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen()
    } else {
      fallbackFullscreen()
    }
  }

  function fallbackFullscreen() {
    var v = els.video
    if (v.webkitEnterFullscreen) {
      v.webkitEnterFullscreen()
      return
    }
    if (v.requestFullscreen) {
      v.requestFullscreen().catch(function () {
        pseudoFullscreen(true)
      })
      return
    }
    pseudoFullscreen(true)
  }

  document.addEventListener('fullscreenchange', function () {
    els.fullscreen.textContent = document.fullscreenElement ? '退出全屏' : '全屏'
  })
  document.addEventListener('webkitfullscreenchange', function () {
    els.fullscreen.textContent = document.webkitFullscreenElement ? '退出全屏' : '全屏'
  })

  /* ---------- 交互 ---------- */

  els.bigplay.addEventListener('click', function () {
    showOverlay(false)
    els.video.play().catch(function () {})
  })

  els.quality.addEventListener('change', function () {
    loadQuality(els.quality.value)
  })

  els.line.addEventListener('change', function () {
    var i = Number(els.line.value)
    if (!isNaN(i)) playCandidate(i)
  })

  els.refresh.addEventListener('click', function () {
    if (S.kind === 'room') loadQuality(S.quality)
    else {
      S.candidateIdx = 0
      playCandidate(0)
    }
  })

  els.fullscreen.addEventListener('click', toggleFullscreen)
  els.video.addEventListener('dblclick', toggleFullscreen)

  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || ''
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault()
      toggleFullscreen()
    } else if (ev.key === ' ') {
      ev.preventDefault()
      if (els.video.paused) els.video.play().catch(function () {})
      else els.video.pause()
    }
  })

  /* ---------- boot ---------- */

  async function boot() {
    els.title.textContent = S.title
    try {
      var s = await api('/api/session')
      if (s.required && !s.authed) {
        els.login.classList.remove('hidden')
        return
      }
    } catch (e) {
      setStatus('无法连接服务：' + e.message)
      return
    }
    if (S.kind === 'channel') setupChannel()
    else setupRoom()
  }

  document.addEventListener('DOMContentLoaded', boot)
})()
