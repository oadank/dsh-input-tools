// 完整 UI 语音发送测试：假麦克风输入真实语音文件 → 录音 → 发送 → 检查结果
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'module'

const ffmpeg = 'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'
// 确认 ffmpeg 可用
try { execFileSync(ffmpeg, ['-version'], { windowsHide: true }); console.log('ffmpeg OK') } catch (e) { console.log('ffmpeg missing', e.message?.split('\n')[0]) }

const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=C:/Users/oadan/.dsh/asr-sample.wav',
  ],
})
const ctx = await browser.newContext({ permissions: ['microphone'] })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)

// 打开一个会话
const row = page.locator('text=验证').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3500) }

// 对话框是否存在
const rec = page.locator('button[aria-label="录音"]').first()
console.log('record button count:', await rec.count())
if (await rec.count() === 0) { console.log('NO record button'); await browser.close(); process.exit(1) }

// 录音 3 秒
await rec.click()
await page.waitForTimeout(3000)
console.log('recording...')
const stop = page.locator('button[aria-label="停止并发送"]').first()
if (await stop.count() > 0) { await stop.click() } else { await rec.click() }

// 等待处理 + 发送 + 回复
await page.waitForTimeout(30000)
const body = await page.evaluate(() => document.body.innerText)
console.log('=== 页面文本(搜索关键词) ===')
const keys = ['用户语音', '没听清', '识别失败', '发送失败', '收到', '你好', '这是一段']
for (const k of keys) {
  if (body.includes(k)) console.log('  含关键词:', k)
}
await page.screenshot({ path: 'C:/D/opt/winimage-ui.png' })
await browser.close()
console.log('done')
