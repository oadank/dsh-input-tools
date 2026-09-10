// 设置页三个新分区内容验证
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)
const settings = page.locator('button[aria-label*="设置"], [aria-label*="设置"]').first()
if (await settings.count() > 0) { await settings.click().catch(() => {}); await page.waitForTimeout(1500) }

for (const label of ['全局人设', 'MCP 服务器', 'Skill 管理']) {
  const nav = page.getByRole('button', { name: label, exact: true }).last()
  if (await nav.count() > 0) { await nav.click().catch(() => {}); await page.waitForTimeout(1800) }
  const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 1400))
  console.log(`===== ${label} =====`)
  console.log(text)
}
await browser.close()
