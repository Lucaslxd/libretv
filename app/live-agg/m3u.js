'use strict'

const http = require('http')
const https = require('https')
const { URL } = require('url')

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const MAX_BYTES = 8 * 1024 * 1024

function fetchText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return reject(new Error('无效的地址'))
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error('仅支持 http/https'))
    }
    const mod = parsed.protocol === 'https:' ? https : http
    const headers = { 'User-Agent': opts.ua || DEFAULT_UA, Accept: '*/*' }
    if (opts.referer) headers.Referer = opts.referer
    if (opts.origin) headers.Origin = opts.origin

    const req = mod.get(parsed, { headers, timeout: opts.timeout || 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(fetchText(new URL(res.headers.location, parsed).href, opts))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const chunks = []
      let size = 0
      res.on('data', (d) => {
        size += d.length
        if (size > MAX_BYTES) {
          req.destroy(new Error('文件过大'))
          return
        }
        chunks.push(d)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

function parseAttrs(input) {
  const attrs = {}
  let m
  const quoted = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g
  while ((m = quoted.exec(input))) attrs[m[1].toLowerCase()] = m[2]
  const plain = /([A-Za-z0-9_-]+)\s*=\s*([^\s"',]+)/g
  while ((m = plain.exec(input))) {
    const k = m[1].toLowerCase()
    if (!(k in attrs)) attrs[k] = m[2]
  }
  return attrs
}

function parseM3U(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
  const channels = []
  let playlistName = ''
  let pending = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    if (line.startsWith('#EXTM3U')) continue
    if (line.startsWith('#PLAYLIST:')) {
      playlistName = line.slice(10).trim()
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      const body = line.slice(8)
      const comma = body.indexOf(',')
      const attrStr = comma >= 0 ? body.slice(0, comma) : body
      const title = comma >= 0 ? body.slice(comma + 1).trim() : ''
      const attrs = parseAttrs(attrStr)
      pending = {
        attrs,
        title,
        group: attrs['group-title'] || '',
        referer: '',
        ua: '',
      }
      continue
    }
    if (line.startsWith('#EXTGRP:')) {
      const group = line.slice(8).trim()
      if (pending && !pending.attrs['group-title']) pending.group = group
      continue
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      if (pending) {
        const opt = line.slice(11).trim()
        const eq = opt.indexOf('=')
        if (eq > 0) {
          const key = opt.slice(0, eq).toLowerCase()
          const value = opt.slice(eq + 1)
          if (key === 'http-referrer' || key === 'http-referer') pending.referer = value
          if (key === 'http-user-agent') pending.ua = value
        }
      }
      continue
    }
    if (line.startsWith('#')) continue

    const name = (pending && (pending.title || pending.attrs['tvg-name'])) || line
    const group = (pending && pending.group) || '未分组'
    channels.push({
      id: (pending && pending.attrs['tvg-id']) || 'ch-' + channels.length,
      name: String(name).trim() || line,
      url: line,
      logo: (pending && pending.attrs['tvg-logo']) || '',
      group,
      tvgId: (pending && pending.attrs['tvg-id']) || '',
      referer: (pending && pending.referer) || '',
      ua: (pending && pending.ua) || '',
    })
    pending = null
  }

  return { name: playlistName, channels }
}

module.exports = { fetchText, parseM3U, DEFAULT_UA }
