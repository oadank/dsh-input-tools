// persona textarea value + skills 列表验证
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage()
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)
const settings = page.locator('button[aria-label*="设置"], [aria-label*="设置"]').first()
if (await settings.count() > 0) { await settings.click().catch(() => {}); await page.waitForTimeout(1500) }

const nav = page.getByRole('button', { name: '全局人设', exact: true }).last()
await nav.click().catch(() => {})
await page.waitForTimeout(1800)
const persona = await page.evaluate(() => {
  const ta = document.querySelector('section textarea, [class*="settings"] textarea, textarea')
  return { textareaFound: !!ta, valueLen: ta ? (ta.value || '').length : 0, head: ta ? (ta.value || '').slice(0, 120) : null }
})
console.log('persona:', JSON.stringify(persona, null, 2))

const nav2 = page.getByRole('button', { name: 'Skill 管理', exact: true }).last()
await nav2.click().catch(() => {})
await page.waitForTimeout(1800)
const skills = await page.evaluate(() => {
  const body = document.body.innerText
  const i = body.indexOf('Skill（')
  return i >= 0 ? body.slice(i, i + 500) : body.slice(0, 300)
})
console.log('skills:', skills)
await browser.close()
