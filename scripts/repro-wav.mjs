// 完整复现：录音wav→18790识别 链路验证
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const ffmpeg = 'C:\\Users\\oadam\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'
const tmp = os.tmpdir()

// 1) 用样例转 16k 单声道 wav（模拟插件 ffmpeg 输出）
const out = path.join(tmp, 'sample16k-' + Date.now() + '.wav')
try {
  execFileSync(ffmpeg, ['-y', '-i', 'C:\\Users\\oadam\\.dsh\\asr-sample.wav', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out], { windowsHide: true, timeout: 30000 })
  console.log('ffmpeg ok, out exists=', existsSync(out), 'size=', existsSync(out) ? readFileSync(out).length : 0)
} catch (e) {
  console.log('ffmpeg FAILED:', (e.message || '').split('\n')[0])
  process.exit(1)
}

// 2) 18790 识别（用反斜杠路径，模拟插件传的）
const body = JSON.stringify({ audioPath: out })
const req = http.request({ host: '127.0.0.1', port: 18790, path: '/transcribe', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  let b = ''
  res.on('data', (c) => b += c)
  res.on('end', () => console.log('18790 result:', res.statusCode, b.slice(0, 200)))
})
req.on('error', (e) => console.log('ERR', e.message))
req.write(body)
req.end()
