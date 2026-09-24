// 回归：发语音 → 进设置页 → 断言无注入横幅
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=C:/Users/oadan/.dsh/asr-sample.wav'],
})
const ctx = await browser.newContext({ permissions: ['microphone'] })
const page = await ctx.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)
const row = page.locator('text=语音识别测试音频生成标题').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3000) }
const rec = page.locator('button[aria-label="录音"]').first()
await rec.click()
await page.waitForTimeout(3000)
const stop = page.locator('button[aria-label="停止并发送"]').first()
if (await stop.count() > 0) { await stop.click() } else { await rec.click() }
await page.waitForTimeout(6000)
const afterSend = await page.evaluate(() => ({
  bubbles: document.querySelectorAll('audio[data-voice-bubble]').length,
  cards: document.querySelectorAll('[data-voice]').length,
}))
console.log('afterSend:', JSON.stringify(afterSend))
const settings = page.locator('[aria-label*="设置"]').first()
if (await settings.count() > 0) { await settings.click().catch(() => {}); await page.waitForTimeout(1500) }
const voiceTab = page.getByText('语音服务', { exact: true }).last()
if (await voiceTab.count() > 0) { await voiceTab.click().catch(() => {}); await page.waitForTimeout(1800) }
const inSettings = await page.evaluate(() => ({
  dialogOpen: !!document.querySelector('[role="dialog"]'),
  injectedInSettings: document.querySelectorAll('[role="dialog"] audio[data-voice-bubble]').length,
  anyInjected: document.querySelectorAll('audio[data-voice-bubble]').length,
}))
console.log('inSettings:', JSON.stringify(inSettings))
await page.screenshot({ path: 'C:/D/opt/settings-no-banner.png' })
await browser.close()
