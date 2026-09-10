// 按钮几何验证：28px 圆形 + 官方对比 + 截图
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)
const geo = await page.evaluate(() => {
  const card = document.querySelector('[data-composer-card]')
  if (!card) return null
  const btns = Array.from(card.querySelectorAll('button')).filter((b) => /添加图片|录音/.test(b.getAttribute('aria-label') || ''))
  const official = card.querySelector('button[class*="add"]')
  const measure = (b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(b).borderRadius, bg: getComputedStyle(b).backgroundColor } }
  return { mine: btns.map(measure), official: official ? measure(official) : null }
})
console.log(JSON.stringify(geo, null, 2))
const card = page.locator('[data-composer-card]').first()
await card.screenshot({ path: 'C:/D/opt/deepseek-harness/plugins/dsh-input-tools/scripts/pw-toolbar-round.png' })
await browser.close()
