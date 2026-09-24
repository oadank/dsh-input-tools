// 录一段 fake 麦克风音频并存盘（复现 ffmpeg 失败）
import { createRequire } from 'module'
import { writeFileSync } from 'node:fs'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const ctx = await browser.newContext({ permissions: ['microphone'] })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(1500)
const b64 = await page.evaluate(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const rec = new MediaRecorder(stream)
  const chunks = []
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
  const done = new Promise((r) => { rec.onstop = r })
  rec.start()
  await new Promise((r) => setTimeout(r, 3000))
  rec.stop()
  await done
  stream.getTracks().forEach((t) => t.stop())
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
  const buf = await blob.arrayBuffer()
  let s = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return { b64: btoa(s), type: rec.mimeType }
})
writeFileSync(process.env.TEMP + '/dsh-real-rec.webm', Buffer.from(b64.b64, 'base64'))
console.log('saved', b64.type, b64.b64.length)
await browser.close()
