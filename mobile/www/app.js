/* 直播聚合板块 - 前端逻辑 */
;(function () {
  'use strict'

  var $ = function (sel) {
    return document.querySelector(sel)
  }

  var els = {
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
    panelPlatform: $('#tab-platform'),
    panelM3u: $('#tab-m3u'),
    platforms: $('#platforms'),
    catTabs: $('#cat-tabs'),
    areaGrid: $('#area-grid'),
    searchForm: $('#search-form'),
    searchInput: $('#search-input'),
    linkForm: $('#link-form'),
    linkInput: $('#link-input'),
    searchHint: $('#search-hint'),
    roomGrid: $('#room-grid'),
    roomMore: $('#room-more'),
    m3uName: $('#m3u-name'),
    m3uUrl: $('#m3u-url'),
    m3uRef: $('#m3u-ref'),
    m3uAddBtn: $('#m3u-add-btn'),
    m3uSources: $('#m3u-sources'),
    m3uFilter: $('#m3u-filter'),
    m3uGroups: $('#m3u-groups'),
    m3uCount: $('#m3u-count'),
    channelGrid: $('#channel-grid'),
    player: $('#player'),
    playerTitle: $('#player-title'),
    playerMeta: $('#player-meta'),
    playerStatus: $('#player-status'),
    playerClose: $('#player-close'),
    playerRefresh: $('#player-refresh'),
    playerOpen: $('#player-open'),
    qualitySelect: $('#quality-select'),
    lineSelect: $('#line-select'),
    video: $('#video'),
    login: $('#login'),
    loginForm: $('#login-form'),
    loginPassword: $('#login-password'),
    loginError: $('#login-error'),
    toast: $('#toast'),
  }

  var state = {
    platform: 'huya',
    mode: 'recommend',
    page: 1,
    hasMore: false,
    rooms: [],
    categories: [],
    catId: '',
    area: null,
    areaPage: 1,
    sources: [],
    channels: [],
    activeSourceId: '',
    group: '',
    filter: '',
    currentRoom: null,
    currentUrls: [],
    lastStream: null,
    playerHref: '',
    upstreamDown: false,
  }

  var hls = null
  var flvPlayer = null
  var toastTimer = null

  /* ---------- utils ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function fmtOnline(n) {
    n = Number(n) || 0
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
    return String(n)
  }

  /* 独立播放页地址 */
  function playerUrl(params) {
    var p = new URLSearchParams()
    Object.keys(params).forEach(function (k) {
      var v = params[k]
      if (v !== undefined && v !== null && v !== '') p.set(k, v)
    })
    return 'player.html?' + p.toString()
  }

  function roomPlayerUrl(site, roomId, title) {
    return playerUrl({ kind: 'room', site: site, roomId: roomId, title: title })
  }

  function channelPlayerUrl(name, url, ref, ua) {
    return playerUrl({
      kind: 'channel',
      source: state.activeSourceId,
      name: name,
      title: name,
      url: url,
      ref: ref,
      ua: ua,
    })
  }

  /* iOS 不支持 MSE/FLV，且内嵌弹窗体验差，直接进独立播放页 */
  var IS_IOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  /* 选出当前环境能播的第一条线路（iOS 跳过 FLV） */
  function pickPlayable(urls) {
    var canFlv = !!(window.mpegts && window.mpegts.isSupported())
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i]
      var f = String(u.format || '').toLowerCase()
      var isFlv = f === 'flv' || /\.flv(?:$|\?)/i.test(u.url)
      if (isFlv && !canFlv) continue
      return u
    }
    return urls[0]
  }

  function toast(msg) {
    els.toast.textContent = msg
    els.toast.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      els.toast.classList.add('hidden')
    }, 2600)
  }

  function setStatus(msg) {
    els.playerStatus.textContent = msg || ''
    if (msg) els.playerStatus.classList.remove('hidden')
    else els.playerStatus.classList.add('hidden')
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

  async function checkAuth() {
    try {
      var s = await api('/api/session')
      if (s.required && !s.authed) {
        els.login.classList.remove('hidden')
        return false
      }
      els.login.classList.add('hidden')
      return true
    } catch (e) {
      toast('无法连接服务：' + e.message)
      return false
    }
  }

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

  /* ---------- tabs ---------- */

  function switchTab(name) {
    els.tabs.forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name)
    })
    els.panelPlatform.classList.toggle('active', name === 'platform')
    els.panelM3u.classList.toggle('active', name === 'm3u')
    if (name === 'm3u' && !state.activeSourceId && state.sources.length) {
      selectSource(state.sources[0].id)
    }
  }

  els.tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      switchTab(t.getAttribute('data-tab'))
    })
  })

  /* ---------- platforms ---------- */

  async function loadPlatforms() {
    var data = await api('/api/platforms')
    var list = data.platforms || []
    els.platforms.innerHTML = list
      .map(function (p) {
        return '<button class="chip' + (p.id === state.platform ? ' active' : '') + '" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button>'
      })
      .join('')
  }

  els.platforms.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.chip')
    if (!btn) return
    state.platform = btn.getAttribute('data-id')
    Array.prototype.forEach.call(els.platforms.children, function (c) {
      c.classList.toggle('active', c === btn)
    })
    els.searchInput.value = ''
    state.categories = []
    resetArea()
    loadCategories()
    loadRecommend(true)
  })

  /* ---------- 分区（游戏区），顺序与上游一致 ---------- */

  function currentCat() {
    for (var i = 0; i < state.categories.length; i++) {
      if (String(state.categories[i].id) === String(state.catId)) return state.categories[i]
    }
    return null
  }

  function resetArea() {
    state.catId = ''
    state.area = null
    state.areaPage = 1
    els.areaGrid.innerHTML = ''
    els.areaGrid.classList.add('hidden')
    renderCatTabs()
  }

  function renderCatTabs() {
    var list = state.categories || []
    if (!list.length) {
      els.catTabs.innerHTML = ''
      els.catTabs.classList.add('hidden')
      return
    }
    var html = ['<button class="chip' + (state.catId ? '' : ' active') + '" data-cat="">推荐</button>']
    list.forEach(function (c) {
      html.push(
        '<button class="chip' +
          (String(state.catId) === String(c.id) ? ' active' : '') +
          '" data-cat="' +
          esc(c.id) +
          '">' +
          esc(c.name) +
          '</button>'
      )
    })
    els.catTabs.innerHTML = html.join('')
    els.catTabs.classList.remove('hidden')
  }

  function renderAreas() {
    var cat = currentCat()
    var list = (cat && cat.children) || []
    if (!state.catId || !list.length) {
      els.areaGrid.innerHTML = ''
      els.areaGrid.classList.add('hidden')
      return
    }
    els.areaGrid.innerHTML = list
      .map(function (a) {
        var active = state.area && String(state.area.id) === String(a.id)
        var pic = a.pic
          ? '<img loading="lazy" src="' + esc(a.pic) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          : '<div class="area-ph">' + esc(String(a.name || '?').slice(0, 1)) + '</div>'
        return (
          '<div class="area-item' +
          (active ? ' active' : '') +
          '" data-area="' +
          esc(a.id) +
          '">' +
          pic +
          '<span>' +
          esc(a.name) +
          '</span>' +
          '</div>'
        )
      })
      .join('')
    els.areaGrid.classList.remove('hidden')
  }

  async function loadCategories() {
    els.catTabs.innerHTML = ''
    els.catTabs.classList.add('hidden')
    els.areaGrid.innerHTML = ''
    els.areaGrid.classList.add('hidden')
    state.categories = []
    try {
      var data = await api('/api/categories?site=' + encodeURIComponent(state.platform))
      state.categories = data.categories || []
    } catch (e) {
      state.categories = []
    }
    renderCatTabs()
  }

  els.catTabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-cat]')
    if (!btn) return
    var id = btn.getAttribute('data-cat')
    state.catId = id
    state.area = null
    renderCatTabs()
    renderAreas()
    if (!id) {
      loadRecommend(true)
      return
    }
    var cat = currentCat()
    if (cat) els.searchHint.textContent = cat.name + ' · 选择游戏查看分区直播'
  })

  els.areaGrid.addEventListener('click', function (ev) {
    var item = ev.target.closest('[data-area]')
    if (!item) return
    var cat = currentCat()
    var id = item.getAttribute('data-area')
    var child = null
    ;((cat && cat.children) || []).forEach(function (c) {
      if (String(c.id) === String(id)) child = c
    })
    state.area = {
      id: id,
      parentId: (child && child.parentId) || (cat && cat.id) || '',
      name: (child && child.name) || '',
      catName: (cat && cat.name) || '',
    }
    renderAreas()
    loadArea(true)
  })

  async function loadArea(reset) {
    if (!state.area) return
    state.mode = 'area'
    if (reset) {
      state.areaPage = 1
      state.rooms = []
      els.roomGrid.innerHTML = ''
    }
    els.searchHint.textContent = '加载分区…'
    els.roomMore.innerHTML = ''
    try {
      var data = await api(
        '/api/rooms?site=' +
          encodeURIComponent(state.platform) +
          '&areaId=' +
          encodeURIComponent(state.area.id) +
          '&parentAreaId=' +
          encodeURIComponent(state.area.parentId) +
          '&page=' +
          state.areaPage
      )
      var items = data.items || []
      state.rooms = reset ? items : state.rooms.concat(items)
      state.hasMore = !!data.hasMore
      renderRooms()
      var where = (state.area.catName ? state.area.catName + ' · ' : '') + state.area.name
      els.searchHint.textContent = state.rooms.length
        ? where + ' · 已加载 ' + state.rooms.length + ' 个直播间'
        : where + ' · 这个分区暂时没有直播'
      renderMore()
    } catch (e) {
      els.searchHint.textContent = '加载分区失败：' + e.message
    }
  }

  /* ---------- recommend / search ---------- */

  function renderMore() {
    if (!state.hasMore) {
      els.roomMore.innerHTML = ''
      return
    }
    els.roomMore.innerHTML = '<button type="button" id="more-btn">加载更多</button>'
    $('#more-btn').addEventListener('click', function () {
      if (state.mode === 'area') {
        state.areaPage += 1
        loadArea(false)
        return
      }
      state.page += 1
      if (state.mode === 'recommend') loadRecommend(false)
      else doSearch(false)
    })
  }

  async function loadRecommend(reset) {
    state.mode = 'recommend'
    if (reset) {
      state.page = 1
      state.rooms = []
      els.roomGrid.innerHTML = ''
    }
    els.searchHint.textContent = '加载热门直播…'
    els.roomMore.innerHTML = ''
    try {
      var data = await api('/api/recommend?site=' + encodeURIComponent(state.platform) + '&page=' + state.page)
      var items = data.items || []
      state.rooms = reset ? items : state.rooms.concat(items)
      state.hasMore = !!data.hasMore
      renderRooms()
      els.searchHint.textContent = state.rooms.length
        ? '热门直播 · 已加载 ' + state.rooms.length + ' 个直播间'
        : '当前平台暂无推荐直播间'
      renderMore()
    } catch (e) {
      state.upstreamDown = true
      els.searchHint.textContent = '平台接口不可用：' + e.message
      maybeSwitchToM3U()
    }
  }

  async function doSearch(reset) {
    var kw = els.searchInput.value.trim()
    resetArea()
    if (!kw) {
      loadRecommend(true)
      return
    }
    state.mode = 'search'
    if (reset) {
      state.page = 1
      state.rooms = []
      els.roomGrid.innerHTML = ''
    }
    els.searchHint.textContent = '搜索中…'
    els.roomMore.innerHTML = ''
    try {
      var data = await api(
        '/api/search?site=' + encodeURIComponent(state.platform) + '&kw=' + encodeURIComponent(kw) + '&page=' + state.page
      )
      var items = data.items || []
      state.rooms = reset ? items : state.rooms.concat(items)
      state.hasMore = !!data.hasMore
      renderRooms()
      els.searchHint.textContent = state.rooms.length
        ? '搜索结果 · 已加载 ' + state.rooms.length + ' 个直播间'
        : '没有找到相关直播间'
      renderMore()
    } catch (e) {
      els.searchHint.textContent = '搜索失败：' + e.message
    }
  }

  els.searchForm.addEventListener('submit', function (ev) {
    ev.preventDefault()
    doSearch(true)
  })

  function renderRooms() {
    els.roomGrid.innerHTML = state.rooms.map(roomCardHtml).join('')
  }

  function roomCardHtml(r) {
    var site = r.siteId || state.platform
    var cover = r.cover
      ? '<img loading="lazy" src="' + esc(r.cover) + '" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
      : ''
    return (
      '<div class="card" data-site="' +
      esc(site) +
      '" data-room="' +
      esc(r.roomId) +
      '">' +
      '<div class="cover">' +
      cover +
      '<div class="placeholder" style="display:' +
      (r.cover ? 'none' : 'flex') +
      '">▶</div>' +
      '<span class="live-flag">LIVE</span>' +
      '<a class="blank" href="' +
      roomPlayerUrl(site, r.roomId, r.title) +
      '" target="_blank" rel="noopener" title="在新页面播放">⤢</a>' +
      (r.online ? '<span class="online">' + fmtOnline(r.online) + ' 人在看</span>' : '') +
      '</div>' +
      '<div class="body">' +
      '<div class="title">' +
      esc(r.title || '未命名直播间') +
      '</div>' +
      '<div class="sub">' +
      (r.userAvatar ? '<img class="avatar" src="' + esc(r.userAvatar) + '" alt="">' : '') +
      '<span>' +
      esc(r.userName || r.roomId) +
      '</span>' +
      '</div>' +
      '</div>' +
      '</div>'
    )
  }

  els.roomGrid.addEventListener('click', function (ev) {
    if (ev.target.closest('.blank')) return
    var card = ev.target.closest('.card')
    if (!card) return
    var site = card.getAttribute('data-site')
    var roomId = card.getAttribute('data-room')
    if (IS_IOS) {
      var t = card.querySelector('.title')
      location.href = roomPlayerUrl(site, roomId, t ? t.textContent : '')
      return
    }
    openRoom(site, roomId)
  })

  /* ---------- link ---------- */

  els.linkForm.addEventListener('submit', async function (ev) {
    ev.preventDefault()
    var raw = els.linkInput.value.trim()
    if (!raw) return
    var parsed = parseRoomInput(raw)
    if (parsed) {
      openRoom(parsed.site, parsed.roomId)
      return
    }
    toast('正在解析链接…')
    try {
      var data = await api('/api/resolve?url=' + encodeURIComponent(raw))
      var site = data.siteId || data.site
      var room = data.roomId
      if (site && room) openRoom(site, room)
      else toast('无法识别该链接')
    } catch (e) {
      toast('解析失败：' + e.message)
    }
  })

  function parseRoomInput(raw) {
    var s = String(raw || '').trim()
    if (/^\d+$/.test(s)) return { site: state.platform, roomId: s }
    var u
    try {
      u = new URL(s)
    } catch (e) {
      return null
    }
    var host = u.hostname
    var parts = u.pathname.split('/').filter(Boolean)
    var map = [
      ['bilibili.com', 'bilibili'],
      ['huya.com', 'huya'],
      ['douyu.com', 'douyu'],
      ['douyin.com', 'douyin'],
      ['kuaishou.com', 'kuaishou'],
      ['cc.163.com', 'cc'],
      ['sooplive', 'soop'],
      ['yy.com', 'yy'],
    ]
    for (var i = 0; i < map.length; i++) {
      if (host.indexOf(map[i][0]) >= 0) {
        var room = parts[0] || ''
        if (!room || !/^[A-Za-z0-9_-]+$/.test(room)) return null
        return { site: map[i][1], roomId: room }
      }
    }
    return null
  }

  /* ---------- player ---------- */

  function openPlayer(title) {
    els.player.classList.remove('hidden')
    els.playerTitle.textContent = title || '播放中'
    els.playerMeta.textContent = ''
    setStatus('')
  }

  function closePlayer() {
    destroyPlayer()
    els.player.classList.add('hidden')
    state.currentRoom = null
    els.qualitySelect.classList.add('hidden')
    els.lineSelect.classList.add('hidden')
  }

  els.playerClose.addEventListener('click', closePlayer)
  els.playerOpen.addEventListener('click', function () {
    if (!state.playerHref) {
      toast('请先打开一个直播间或频道')
      return
    }
    window.open(state.playerHref, '_blank', 'noopener')
  })
  els.player.addEventListener('click', function (ev) {
    if (ev.target === els.player) closePlayer()
  })

  els.playerRefresh.addEventListener('click', function () {
    if (state.currentRoom) playRoom(state.currentRoom.roomId, els.qualitySelect.value)
    else if (state.lastStream) playStream(state.lastStream.url, state.lastStream.format, state.lastStream.opts)
  })

  els.qualitySelect.addEventListener('change', function () {
    if (state.currentRoom) playRoom(state.currentRoom.roomId, els.qualitySelect.value)
  })

  els.lineSelect.addEventListener('change', function () {
    var idx = Number(els.lineSelect.value) || 0
    var item = state.currentUrls[idx]
    if (item) playStream(item.url, item.format, { site: state.currentRoom ? state.currentRoom.site : '' })
  })

  async function openRoom(site, roomId) {
    openPlayer('直播间')
    setStatus('获取房间信息…')
    try {
      var info = await api('/api/room?site=' + encodeURIComponent(site) + '&roomId=' + encodeURIComponent(roomId))
      var canonical = info.roomId || roomId
      state.currentRoom = { site: site, roomId: canonical, info: info }
      state.playerHref = roomPlayerUrl(site, canonical, info.title)
      els.playerTitle.textContent = info.title || '直播间'
      els.playerMeta.textContent =
        (info.userName || '') +
        (info.online ? ' · ' + fmtOnline(info.online) + ' 人在看' : '') +
        (info.url ? ' · ' + info.url : '')
      renderQualities(info.qualities || [])
      await playRoom(canonical, '')
    } catch (e) {
      setStatus('获取房间失败：' + e.message)
    }
  }

  function renderQualities(list) {
    if (!list || list.length < 2) {
      els.qualitySelect.classList.add('hidden')
      return
    }
    els.qualitySelect.innerHTML = list
      .map(function (q) {
        return '<option value="' + esc(q.key) + '">' + esc(q.name) + '</option>'
      })
      .join('')
    els.qualitySelect.classList.remove('hidden')
  }

  async function playRoom(roomId, quality) {
    if (!state.currentRoom) return
    var site = state.currentRoom.site
    setStatus('获取播放地址…')
    try {
      var data = await api(
        '/api/play?site=' +
          encodeURIComponent(site) +
          '&roomId=' +
          encodeURIComponent(roomId) +
          (quality ? '&quality=' + encodeURIComponent(quality) : '')
      )
      var urls = data.urls || []
      if (!urls.length) {
        setStatus('暂无可用播放地址（可能未开播或平台限制）')
        return
      }
      state.currentUrls = urls
      renderLines(urls)
      var first = pickPlayable(urls)
      if (!els.lineSelect.classList.contains('hidden')) {
        els.lineSelect.value = String(urls.indexOf(first))
      }
      playStream(first.url, first.format, { site: site })
      setStatus('')
    } catch (e) {
      setStatus('获取播放地址失败：' + e.message)
    }
  }

  function renderLines(urls) {
    if (!urls || urls.length < 2) {
      els.lineSelect.classList.add('hidden')
      return
    }
    els.lineSelect.innerHTML = urls
      .map(function (u, i) {
        return '<option value="' + i + '">' + esc(u.line || u.format || '线路 ' + (i + 1)) + '</option>'
      })
      .join('')
    els.lineSelect.classList.remove('hidden')
  }

  function destroyPlayer() {
    if (hls) {
      try {
        hls.destroy()
      } catch (e) {}
      hls = null
    }
    if (flvPlayer) {
      try {
        flvPlayer.pause()
        flvPlayer.unload()
        flvPlayer.detachMediaElement()
        flvPlayer.destroy()
      } catch (e) {}
      flvPlayer = null
    }
    try {
      els.video.pause()
      els.video.removeAttribute('src')
      els.video.load()
    } catch (e) {}
  }

  function playStream(url, format, opts) {
    opts = opts || {}
    state.lastStream = { url: url, format: format, opts: opts }
    destroyPlayer()
    setStatus('正在加载…')

    var src = window.LTBridge.streamUrl({ url: url, ref: opts.ref, ua: opts.ua }, opts.site)

    var f = String(format || '').toLowerCase()
    var isHls = f === 'm3u8' || f === 'hls' || /\.m3u8(?:$|\?)/i.test(url)
    var isFlv = f === 'flv' || /\.flv(?:$|\?)/i.test(url)

    if (isHls) {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 30,
          xhrSetup: function (xhr) {
            window.LTBridge.applyStreamHeaders(xhr, { ref: opts.ref, ua: opts.ua })
          },
        })
        hls.loadSource(src)
        hls.attachMedia(els.video)
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          els.video.play().catch(function () {})
          setStatus('')
        })
        hls.on(window.Hls.Events.ERROR, function (_evt, data) {
          if (data && data.fatal) {
            setStatus('HLS 播放失败（' + (data.type || 'error') + '），请尝试刷新或换源')
          }
        })
      } else if (els.video.canPlayType('application/vnd.apple.mpegurl')) {
        els.video.src = src
        els.video.play().catch(function () {})
        setStatus('')
      } else {
        setStatus('当前浏览器不支持 HLS 播放')
      }
      return
    }

    if (isFlv) {
      if (window.mpegts && window.mpegts.isSupported()) {
        /* mpegts 的 worker 内 fetch 无法解析相对路径，必须传绝对地址 */
        var flvSrc = new URL(src, location.href).href
        flvPlayer = window.mpegts.createPlayer(
          { type: 'flv', isLive: true, url: flvSrc },
          {
            /* App 内 worker 用不了原生 HTTP（会被 CORS 拦截），关闭 worker */
            enableWorker: !(window.LTBridge && window.LTBridge.native),
            lazyLoad: false,
            stashInitialSize: 128,
          }
        )
        flvPlayer.attachMediaElement(els.video)
        flvPlayer.load()
        flvPlayer.play().catch(function () {})
        flvPlayer.on(window.mpegts.Events.ERROR, function (_type, detail) {
          setStatus('FLV 播放失败（' + ((detail && detail.msg) || '未知错误') + '），请刷新或切换线路')
        })
        setTimeout(function () {
          setStatus('')
        }, 1500)
      } else {
        setStatus('当前浏览器不支持 FLV 播放')
      }
      return
    }

    els.video.src = src
    els.video.play().catch(function () {})
    setStatus('')
  }

  els.video.addEventListener('playing', function () {
    setStatus('')
  })
  els.video.addEventListener('error', function () {
    if (!hls && !flvPlayer) setStatus('播放失败，请刷新重试')
  })

  /* ---------- M3U ---------- */

  /* 平台聚合接口不可用时，自动落到本地可解析的 M3U 源 */
  function maybeSwitchToM3U() {
    if (!state.upstreamDown || state.activeSourceId) return
    if (!state.sources.length) return
    switchTab('m3u')
    toast('平台接口不可用，已切换到 M3U 直播源')
  }

  async function loadSources() {
    try {
      state.sources = await window.LTBridge.m3u.list()
      renderSources()
      maybeSwitchToM3U()
    } catch (e) {
      if (e.status !== 401) toast('加载直播源失败：' + e.message)
    }
  }

  function renderSources() {
    if (!state.sources.length) {
      els.m3uSources.innerHTML = '<div class="hint" style="margin:0;color:var(--muted);font-size:13px">还没有 M3U 直播源，先在上方添加一个（例如 IPTV-org 的中国频道列表）。</div>'
      return
    }
    els.m3uSources.innerHTML = state.sources
      .map(function (s) {
        return (
          '<div class="source-item">' +
          '<span class="name" data-id="' +
          esc(s.id) +
          '">' +
          esc(s.name) +
          '</span>' +
          '<button class="del" data-del="' +
          esc(s.id) +
          '" title="删除">✕</button>' +
          '</div>'
        )
      })
      .join('')
  }

  els.m3uSources.addEventListener('click', function (ev) {
    var del = ev.target.closest('[data-del]')
    if (del) {
      removeSource(del.getAttribute('data-del'))
      return
    }
    var name = ev.target.closest('.name')
    if (name) selectSource(name.getAttribute('data-id'))
  })

  els.m3uAddBtn.addEventListener('click', async function () {
    var url = els.m3uUrl.value.trim()
    if (!url) {
      toast('请填写 M3U 地址')
      return
    }
    try {
      await window.LTBridge.m3u.add({
        name: els.m3uName.value.trim(),
        url: url,
        referer: els.m3uRef.value.trim(),
      })
      els.m3uName.value = ''
      els.m3uUrl.value = ''
      els.m3uRef.value = ''
      toast('已添加')
      await loadSources()
    } catch (e) {
      toast(e.message)
    }
  })

  async function removeSource(id) {
    try {
      await window.LTBridge.m3u.remove(id)
      if (state.activeSourceId === id) {
        state.activeSourceId = ''
        state.channels = []
        els.channelGrid.innerHTML = ''
        els.m3uGroups.innerHTML = ''
        els.m3uCount.textContent = ''
      }
      await loadSources()
    } catch (e) {
      toast(e.message)
    }
  }

  async function selectSource(id) {
    state.activeSourceId = id
    state.group = ''
    state.filter = ''
    els.m3uFilter.value = ''
    els.m3uGroups.innerHTML = ''
    els.channelGrid.innerHTML = ''
    els.m3uCount.textContent = '加载中…'
    try {
      state.channels = await window.LTBridge.m3u.channels(id)
      renderGroups()
      renderChannels()
    } catch (e) {
      els.m3uCount.textContent = '加载失败：' + e.message
    }
  }

  function renderGroups() {
    var groups = {}
    state.channels.forEach(function (c) {
      groups[c.group || '未分组'] = (groups[c.group || '未分组'] || 0) + 1
    })
    var names = Object.keys(groups).sort(function (a, b) {
      return groups[b] - groups[a]
    })
    var html = ['<span class="group' + (state.group ? '' : ' active') + '" data-group="">全部</span>']
    names.slice(0, 40).forEach(function (g) {
      html.push(
        '<span class="group' + (state.group === g ? ' active' : '') + '" data-group="' + esc(g) + '">' + esc(g) + ' (' + groups[g] + ')</span>'
      )
    })
    els.m3uGroups.innerHTML = html.join('')
  }

  els.m3uGroups.addEventListener('click', function (ev) {
    var g = ev.target.closest('.group')
    if (!g) return
    state.group = g.getAttribute('data-group') || ''
    renderGroups()
    renderChannels()
  })

  els.m3uFilter.addEventListener('input', function () {
    state.filter = els.m3uFilter.value.trim().toLowerCase()
    renderChannels()
  })

  function renderChannels() {
    var list = state.channels.filter(function (c) {
      if (state.group && (c.group || '未分组') !== state.group) return false
      if (!state.filter) return true
      return (
        (c.name || '').toLowerCase().indexOf(state.filter) >= 0 ||
        (c.group || '').toLowerCase().indexOf(state.filter) >= 0 ||
        (c.tvgId || '').toLowerCase().indexOf(state.filter) >= 0
      )
    })
    els.m3uCount.textContent = list.length + ' 个频道'
    var shown = list.slice(0, 400)
    els.channelGrid.innerHTML = shown
      .map(function (c) {
        return (
          '<div class="card" data-url="' +
          esc(c.url) +
          '" data-ref="' +
          esc(c.referer || '') +
          '" data-ua="' +
          esc(c.ua || '') +
          '">' +
          (c.logo
            ? '<img class="logo" loading="lazy" src="' + esc(c.logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
            : '<div class="logo"></div>') +
          '<div class="body">' +
          '<div class="title">' +
          esc(c.name) +
          '</div>' +
          '<div class="sub">' +
          esc(c.group || '未分组') +
          '</div>' +
          '</div>' +
          '<a class="blank" href="' +
          channelPlayerUrl(c.name, c.url, c.referer || '', c.ua || '') +
          '" target="_blank" rel="noopener" title="在新页面播放">⤢</a>' +
          '</div>'
        )
      })
      .join('')
    if (list.length > shown.length) {
      els.m3uCount.textContent += '（仅显示前 ' + shown.length + ' 个，请用搜索筛选）'
    }
  }

  els.channelGrid.addEventListener('click', function (ev) {
    if (ev.target.closest('.blank')) return
    var card = ev.target.closest('.card')
    if (!card) return
    var name = card.querySelector('.title').textContent
    var ref = card.getAttribute('data-ref') || ''
    var ua = card.getAttribute('data-ua') || ''
    state.playerHref = channelPlayerUrl(name, card.getAttribute('data-url'), ref, ua)
    if (IS_IOS) {
      location.href = state.playerHref
      return
    }
    openPlayer('频道播放')
    els.playerTitle.textContent = name
    playStream(card.getAttribute('data-url'), 'auto', { ref: ref, ua: ua })
  })

  /* ---------- boot ---------- */

  async function boot() {
    try {
      await loadPlatforms()
    } catch (e) {
      toast('加载平台失败：' + e.message)
    }
    /* 分区数据较慢，不能阻塞列表首屏 */
    loadCategories()
    loadSources()
    loadRecommend(true)
  }

  document.addEventListener('DOMContentLoaded', async function () {
    var ok = await checkAuth()
    if (ok) boot()
  })
})()
