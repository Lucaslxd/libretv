/* 把直播板块的静态资源复制进 App 的 www 目录（App 内置界面，不依赖服务器） */
const fs = require('fs')
const path = require('path')

const src = path.join(__dirname, '..', 'app', 'live-agg', 'public')
const dest = path.join(__dirname, 'www')

if (!fs.existsSync(src)) {
  console.error('找不到静态资源目录：' + src)
  process.exit(1)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.cpSync(src, dest, { recursive: true })

const count = fs.readdirSync(dest).length
console.log('copied ' + count + ' entries -> ' + dest)
