// 终验：问 AI 最后一条语音说了什么（验证 llm-pi-ai voiceBlockText 生效）
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, [role=button], li, a')).filter(e => (e.textContent || '').includes('语音识别测试音频'))
  if (els.length > 0) els[els.length - 1].click()
})
await page.waitForTimeout(4000)
// 输入文本并发送
const editor = page.locator('[data-composer-card] [contenteditable]').first()
await editor.click()
await page.keyboard.type('不要猜。引用最后一条用户语音的「识别内容」原文，逐字复述。')
await page.keyboard.press('Enter')
// 等回复
await page.waitForTimeout(35000)
const r = await page.evaluate(() => {
  const body = document.body.innerText || ''
  const ok = body.includes('你好这是一段语音识别测试音频')
  return { heardTranscript: ok, tail: body.slice(-500) }
})
console.log(JSON.stringify(r, null, 2))
await page.screenshot({ path: 'C:/D/opt/ai-hear-final.png' })
await browser.close()
