// 验证语音气泡注入器是否工作：发一条语音，等片刻检查页面是否有 audio[data-voice-bubble]
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=C:/Users/oadam/.dsh/asr-sample.wav'],
})
const ctx = await browser.newContext({ permissions: ['microphone'] })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)
const row = page.locator('text=语音识别测试音频').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3500) }
const rec = page.locator('button[aria-label="录音"]').first()
console.log('record:', await rec.count())
if (await rec.count() > 0) {
  await rec.click(); await page.waitForTimeout(3000)
  const stop = page.locator('button[aria-label="停止并发送"]').first()
  if (await stop.count() > 0) { await stop.click() } else { await rec.click() }
  await page.waitForTimeout(5000)
  const bubbles = await page.evaluate(() => ({
    audio: document.querySelectorAll('audio[data-voice-bubble]').length,
    marks: (document.body.innerText.match(/【用户语音】/g) || []).length,
  }))
  console.log('bubbles:', JSON.stringify(bubbles))
  await page.screenshot({ path: 'C:/D/opt/winimage-bubble.png', fullPage: true })
}
await browser.close()
