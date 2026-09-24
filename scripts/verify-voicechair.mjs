// 验证：进入历史会话，检查用户语音消息是否渲染成 VoiceCard（[data-voice]）而非 JSON
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const TOKEN = process.env.DSH_TOKEN
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=' + TOKEN, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3000)

// 进入语音测试会话
const row = page.locator('text=语音识别测试音频').first()
if (await row.count() > 0) {
  await row.click().catch(() => {})
  await page.waitForTimeout(4000)
} else {
  console.log('no session found, clicking first session area')
}

const result = await page.evaluate(() => {
  const text = document.body.innerText || ''
  return {
    url: location.href,
    voiceCards: document.querySelectorAll('[data-voice]').length,
    audioTags: document.querySelectorAll('audio').length,
    jsonBlocks: (text.match(/附加内容块/g) || []).length,
    hasUserIdToken: text.includes('用户语音'),
    snippet: text.slice(-400),
  }
})
console.log('result:', JSON.stringify(result, null, 2))
await page.screenshot({ path: 'C:/D/opt/verify-chair.png', fullPage: false })
await browser.close()
