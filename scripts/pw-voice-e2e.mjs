// 录音全链路 UI 实测：假麦克风 → 录音 → 停止发送 → 观察降级/发送日志
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const ctx = await browser.newContext({ permissions: ['microphone'] })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)

// 打开一个会话（composer 需要 sessionId）
const row = page.locator('text=验证工具条会话').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3500) }

const rec = page.locator('button[aria-label="录音"]').first()
if (await rec.count() === 0) { console.log('NO record button'); await browser.close(); process.exit(1) }
await rec.click()
await page.waitForTimeout(2500)
const state1 = await page.evaluate(() => document.body.innerText.match(/录音|停止并发送|取消|voiceError|[0-9]+s/g)?.slice(0, 6))
console.log('recording state:', JSON.stringify(state1))
// 再点 = 停止并发送
const stop = page.locator('button[aria-label="停止并发送"]').first()
if (await stop.count() > 0) { await stop.click() } else { await rec.click() }
await page.waitForTimeout(15000)
const after = await page.evaluate(() => ({
  err: document.body.innerText.match(/没听清|语音识别失败|语音发送失败|ASR服务未返回文本|undefined is not[^"']*/)?.[0] ?? null,
  lastUser: Array.from(document.querySelectorAll('[data-slot]')).length,
}))
console.log('after send:', JSON.stringify(after))
await page.screenshot({ path: 'C:/D/opt/deepseek-harness/plugins/dsh-input-tools/scripts/pw-voice-e2e.png' })
await browser.close()
