// 复现用的最小静态服务器：/mock-host.js 取本目录，其余映射到 ../ui/（构建产物）。
// 用法：npm run preview（监听 127.0.0.1:8807；模拟宿主仅在此服务器注入）
const http = require('http')
const fs = require('fs')
const path = require('path')

const UI_DIR = path.join(__dirname, '..', 'ui')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let file = url.pathname === '/mock-host.js'
      ? path.join(__dirname, 'mock-host.js')
      : path.resolve(UI_DIR, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (file !== path.join(__dirname, 'mock-host.js') && !file.startsWith(UI_DIR + path.sep)) {
      res.writeHead(403).end()
      return
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found: ' + url.pathname)
        return
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
      if (path.extname(file) === '.html') data = data.toString().replace('</head>', '<script src="/mock-host.js"></script></head>')
      res.end(data)
    })
  })
  .listen(8807, '127.0.0.1', () => console.log('repro server on http://127.0.0.1:8807'))
