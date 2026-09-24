// 验证 circleBtn 纯圆修复（borderRadius 999px + aspectRatio + boxSizing + 坐标矩形≈方形）
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

// 新 context（无缓存）+ 强制忽略缓存
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await ctx.newPage()
// 引导到 dsh 首页，等登录触发（用 token 直接进会话）
await page.goto('http://127.0.0.1:3080/?token=' + 'jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WKt0iudIh', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)

// 进入一个最近会话（让 composer 出现）
const row = page.locator('text=验证').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3500) }

const geo = await page.evaluate(() => {
  const card = document.querySelector('[data-composer-card]')
  if (!card) return null
  const btns = Array.from(card.querySelectorAll('button[aria-label="添加图片"], button[aria-label="录音"], button[aria-label="取消录音"]'))
  const official = card.querySelector('button[class*="add"]')
  const m = (b) => {
    if (!b) return null
    const r = b.getBoundingClientRect()
    const cs = getComputedStyle(b)
    return { w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderRadius, box: cs.boxSizing, aspect: cs.aspectRatio, bg: cs.backgroundColor }
  }
  return { mine: btns.map(m), official: m(official) }
})
console.log(JSON.stringify(geo, null, 2))
await page.screenshot({ path: 'C:/D/opt/winimage.png' })
await browser.close()
