// 复现用的最小静态服务器：/mock-host.js 取本目录，其余映射到 ../ui/（构建产物）。
// 用法：npm run preview（监听 127.0.0.1:8807；模拟宿主仅在此服务器注入）
const http = require('http')
const fs = require('fs')
const path = require('path')

// Optional real packaged backend. This transport is a local QA harness only.
const { spawn } = require('child_process')
const readline = require('readline')
let directoryCall = null
if (process.env.DBDOC_REPRO_BACKEND) {
  const child = spawn(process.env.DBDOC_REPRO_BACKEND, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: process.env.DBDOC_REPRO_DATA_DIR }, stdio: ['pipe', 'pipe', 'inherit'] })
  let sequence = 0
  const pending = new Map()
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const result = JSON.parse(line), request = pending.get(result.id)
    if (request) { pending.delete(result.id); clearTimeout(request.timer); request.resolve(result) }
  })
  child.on('exit', () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('snapshot backend stopped')) } pending.clear() })
  const invoke = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('snapshot backend timed out')) }, 30000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const initialized = invoke('plugin/initialize', { host: { protocolVersions: [1] } }).then((r) => { if (r.error) throw new Error(r.error.message); return r.result })
  directoryCall = async (operation, params) => { await initialized; return invoke('snapshotDirectory/' + operation, params) }
  process.on('SIGINT', () => { child.kill(); process.exit(0) })
  process.on('exit', () => child.kill())
}

const UI_DIR = path.join(__dirname, '..', 'ui')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/directory') {
      let body = ''; req.on('data', (data) => { body += data; if (body.length > 8 * 1024 * 1024) req.destroy() })
      req.on('end', async () => {
        try {
          const { operation, params } = JSON.parse(body)
          if (!directoryCall) throw new Error('directory host unavailable')
          const result = await directoryCall(operation, params)
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
        } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } })) }
      })
      return
    }
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
