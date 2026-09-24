// 终验（单会话闭环）：语音 → 发送 → 同会话打字问 AI 复述 → 读回复
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
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
const page = await ctx.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)
// 进「语音识别测试音频生成标题」会话（有历史语音）
const row = page.locator('text=语音识别测试音频生成标题').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3500) }

// 1) 发一条语音
const rec = page.locator('button[aria-label="录音"]').first()
console.log('record:', await rec.count())
await rec.click()
await page.waitForTimeout(4500)
const stop = page.locator('button[aria-label="停止并发送"]').first()
if (await stop.count() > 0) { await stop.click() } else { await rec.click() }
await page.waitForTimeout(9000)
const mid = await page.evaluate(() => ({
  voiceCards: document.querySelectorAll('[data-voice]').length,
  lastCard: (Array.from(document.querySelectorAll('[data-voice]')).pop()?.textContent || '').slice(0, 60),
}))
console.log('after voice:', JSON.stringify(mid))

// 2) 同会话打字问 AI
const editor = page.locator('[data-composer-card] [contenteditable]').first()
await editor.click()
await page.keyboard.type('刚才那条语音的识别内容是什么？原样引用它的「识别内容」，不要找日志不要猜。')
await page.keyboard.press('Enter')
await page.waitForTimeout(40000)
const r = await page.evaluate(() => {
  const body = document.body.innerText || ''
  return {
    aiQuotes: body.includes('你好这是一段语音识别测试音频') || body.includes('点击播放试听'),
    tail: body.slice(-500),
  }
})
console.log('final:', JSON.stringify(r, null, 2))
await page.screenshot({ path: 'C:/D/opt/final-verify.png' })
await browser.close()
