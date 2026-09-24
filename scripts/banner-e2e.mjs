// 一体闭环验证：真实语音输入 → 录音发送 → 查用户语音横幅 [data-voice]
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
// 打开一个已有会话（语音识别测试音频）或新建
const row = page.locator('text=语音识别测试音频').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3500) }
const before = await page.evaluate(() => document.querySelectorAll('[data-voice]').length)
const rec = page.locator('button[aria-label="录音"]').first()
console.log('record:', await rec.count(), 'beforeVoiceCards:', before)
if (await rec.count() > 0) {
  await rec.click()
  await page.waitForTimeout(4000)
  const stop = page.locator('button[aria-label="停止并发送"]').first()
  if (await stop.count() > 0) { await stop.click() } else { await rec.click() }
  // 等发送+渲染（直发应秒级；AI 回复另算）
  await page.waitForTimeout(8000)
  const after = await page.evaluate(() => ({
    voiceCards: document.querySelectorAll('[data-voice]').length,
    cls: Array.from(document.querySelectorAll('[data-voice]')).map(e => e.className.slice(0, 36)),
    marks: (document.body.innerText.match(/【用户语音】/g) || []).length,
    audioCount: document.querySelectorAll('audio').length,
  }))
  console.log('after:', JSON.stringify(after, null, 2))
  // 等 AI 回复完，读回复是否引用了语音内容（asr-sample.wav 的固定文本）
  await page.waitForTimeout(25000)
  const reply = await page.evaluate(() => {
    const body = document.body.innerText || ''
    return {
      heard: body.includes('你好') || body.includes('语音识别测试'),
      tail: body.slice(-450),
    }
  })
  console.log('reply:', JSON.stringify(reply, null, 2))
  await page.screenshot({ path: 'C:/D/opt/banner-final.png' })
}
await browser.close()
