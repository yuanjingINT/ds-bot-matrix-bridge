// Loads plugin/index.js the way a DSH host would, with a fake ctx, and exercises the socket.
import { apply } from '/home/yuanjing/.dsh/bot/workspace/matrix-bridge/plugin/index.js'
import { request } from 'node:http'
const sock = '/tmp/mx-bridge-test.sock'
const prompts = []
const effects = []
const ctx = {
  sessionController: { async prompt(body, signal) { prompts.push(body); return true } },
  effect(fn, label) { effects.push(label); return fn() },
  logger: (...a) => console.log('LOG', ...a),
}
apply(ctx, { socketPath: sock })
await new Promise(r => setTimeout(r, 200))
const call = (path, method='GET', body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const req = request({ socketPath: sock, path, method, headers: payload ? {'content-type':'application/json','content-length':Buffer.byteLength(payload)} : {} }, res => {
    const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode, body:Buffer.concat(chunks).toString()}))
  })
  req.on('error', reject); req.end(payload)
})
console.log('health:', await call('/health'))
console.log('prompt:', await call('/prompt','POST',{sessionId:'session-abc', text:'来自 Matrix 的测试'}))
console.log('empty:', await call('/prompt','POST',{sessionId:'session-abc', text:'   '}))
console.log('nosession:', await call('/prompt','POST',{text:'x'}))
console.log('404:', await call('/nope','GET'))
console.log('prompts recorded:', JSON.stringify(prompts))
console.log('effects:', effects.join(','))
const st = await import('node:fs').then(fs=>fs.statSync(sock))
console.log('socket mode:', (st.mode & 0o777).toString(8))
process.exit(0)
