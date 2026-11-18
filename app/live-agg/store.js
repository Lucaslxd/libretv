'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = path.join(__dirname, 'data')
const FILE = path.join(DATA_DIR, 'sources.json')

/* 首次启动预置的直播源：上游聚合接口不可用时，M3U 这条链路仍然能看 */
const DEFAULT_SOURCES = [
  { name: 'IPTV-org 中国', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
  {
    name: '国内 IPTV 合集',
    url: 'https://ghproxy.net/https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u',
  },
]

function read() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function write(arr) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8')
  fs.renameSync(tmp, FILE)
}

function idFor(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 10)
}

/* 只在数据文件还不存在时写入默认源；用户删空后不会再被塞回来 */
function seedIfAbsent() {
  if (process.env.LIVE_DEFAULT_SOURCES === '0') return
  if (fs.existsSync(FILE)) return
  try {
    write(
      DEFAULT_SOURCES.map((s) => ({
        id: idFor(s.url),
        name: s.name,
        url: s.url,
        referer: '',
        ua: '',
      }))
    )
  } catch (e) {
    /* 只读文件系统等情况忽略，不影响用户手动添加 */
  }
}

function list() {
  seedIfAbsent()
  return read()
}

function add(input) {
  const url = String((input && input.url) || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('地址必须以 http:// 或 https:// 开头')
  const arr = read()
  if (arr.some((s) => s.url === url)) throw new Error('该直播源已存在')
  const item = {
    id: idFor(url),
    name: String((input && input.name) || '').trim() || url,
    url,
    referer: String((input && input.referer) || '').trim(),
    ua: String((input && input.ua) || '').trim(),
  }
  arr.push(item)
  write(arr)
  return item
}

function remove(id) {
  const arr = read()
  const next = arr.filter((s) => s.id !== id)
  if (next.length === arr.length) return false
  write(next)
  return true
}

module.exports = { list, add, remove }
