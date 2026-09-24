// 检查页面状态与 composer 情况
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4?qn=', { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3000)
const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  body: (document.body.innerText || '').slice(0, 600),
  composer: !!document.querySelector('[data-composer-card]'),
  buttons: Array.from(document.querySelectorAll('button')).slice(0, 20).map(b => b.getAttribute('aria-label') || b.textContent).filter(Boolean),
}))
console.log(JSON.stringify(info, null, 2))
await browser.close()
