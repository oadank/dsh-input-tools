// 检查新横幅：转录文字 + 秒数 + 复制按钮
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, [role=button], li, a')).filter(e => (e.textContent || '').trim() === '语音识别测试音频生成标题')
  if (els.length > 0) els[0].click()
})
await page.waitForTimeout(4500)
const cards = await page.evaluate(() => Array.from(document.querySelectorAll('[data-voice]')).slice(-3).map(el => ({
  text: (el.textContent || '').slice(0, 70),
  copyBtn: Array.from(el.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || b.title).filter(Boolean),
})))
console.log(JSON.stringify(cards, null, 2))
await page.screenshot({ path: 'C:/D/opt/banner-check2.png' })
await browser.close()
