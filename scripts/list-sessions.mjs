// 列出当前可点击的会话/页面内容，确认能进会话
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3000)
const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  body: (document.body.innerText || '').slice(0, 400),
  sessionEls: document.querySelectorAll('[class*="session"],[class*="chat"],[class*="conversation"]').length,
}))
console.log(JSON.stringify(info, null, 2))
await browser.close()
