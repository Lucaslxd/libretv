'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = path.join(__dirname, 'data')
const FILE = path.join(DATA_DIR, 'sources.json')

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

function list() {
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
