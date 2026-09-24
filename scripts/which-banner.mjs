// 一锤定音：旧用户语音横幅的渲染来源（官方 VoiceCard vs 插件注入）
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const TOKEN = process.env.DSH_TOKEN
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=' + TOKEN, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)
const row = page.locator('text=验证工具条会话').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(4500) }
const r = await page.evaluate(() => {
  const official = Array.from(document.querySelectorAll('[data-voice]')).map(el => ({
    cls: el.className.slice(0, 60),
    text: (el.textContent || '').slice(0, 40),
    parentHint: el.closest('[data-composer-card]') ? 'composer' : (el.closest('[data-voice-reply]') ? 'voice-reply-row' : 'user-message'),
  }))
  const injected = document.querySelectorAll('audio[data-voice-bubble]').length
  const marks = (document.body.innerText.match(/【用户语音】/g) || []).length
  const json = (document.body.innerText.match(/附加内容块/g) || []).length
  return { official, injected, marks, json }
})
console.log(JSON.stringify(r, null, 2))
await page.screenshot({ path: 'C:/D/opt/banner-check.png' })
await browser.close()
