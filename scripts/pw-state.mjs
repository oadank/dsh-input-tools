// 检查页面状态后再进会话
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef847f8bf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3080/', { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3000)
const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  body: (document.body.innerText || '').slice(0, 300),
  composer: !!document.querySelector('[data-composer-card]'),
}))
console.log(JSON.stringify(info, null, 2))
await browser.close()
