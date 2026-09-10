// 本机 loopback 访问：设置页模型分区状态 + composer 模型菜单
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const URL = process.argv[2] || 'http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4'
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)) })

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)

const report = await page.evaluate(() => {
  const body = document.body.innerText || ''
  return {
    hasComposerCard: !!document.querySelector('[data-composer-card]'),
    bodySnippet: body.slice(0, 500),
  }
})
console.log(JSON.stringify(report, null, 2))

// 打开设置页：找设置入口（齿轮/侧栏）
const settingsEntry = page.locator('button[aria-label*="设置"], a[aria-label*="设置"], [aria-label*="Settings"], button[aria-label*="偏好"]').first()
if (await settingsEntry.count() > 0) {
  await settingsEntry.click().catch(() => {})
  await page.waitForTimeout(2000)
}
// 若进入设置，点「模型」分区
const modelsTab = page.getByRole('button', { name: /模型|Models/ }).first()
if (await modelsTab.count() > 0) { await modelsTab.click().catch(() => {}); await page.waitForTimeout(2500) }
const settingsText = await page.evaluate(() => (document.body.innerText || '').slice(0, 900))
console.log('--- after settings nav ---')
console.log(settingsText)

// composer 模型菜单
const trigger = page.locator('[data-composer-card] button[aria-haspopup="menu"]').last()
if (await trigger.count() > 0) {
  await trigger.click().catch(() => {})
  await page.waitForTimeout(1200)
  const modelRow = page.getByRole('menuitem', { name: /模型|Model/ }).first()
  if (await modelRow.count() > 0) { await modelRow.click().catch(() => {}); await page.waitForTimeout(2000) }
  const menuText = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]')
    return menu ? (menu.innerText || '').slice(0, 600) : null
  })
  console.log('--- model menu ---')
  console.log(menuText)
}
console.log('--- console errors ---')
for (const e of errors.slice(0, 12)) console.log(e)
await page.screenshot({ path: 'C:/D/opt/deepseek-harness/plugins/dsh-input-tools/scripts/pw-loopback-shot.png' })
await browser.close()
