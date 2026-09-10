// 验证：局域网访问（非 loopback）时 设置页模型分区报错 + composer 模型菜单可用性
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const URL = process.argv[2] || 'http://192.168.1.67:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4'
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)) })

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)

const report = await page.evaluate(() => {
  const body = document.body.innerText || ''
  return {
    title: document.title,
    hasComposerCard: !!document.querySelector('[data-composer-card]'),
    bodySnippet: body.slice(0, 600),
    loadFailShown: body.includes('加载提供方目录失败'),
    settingsUnavailable: body.includes('settings are unavailable'),
  }
})
console.log(JSON.stringify(report, null, 2))

// 若已进会话，点开 composer 模型选择器看菜单是否出模型
const trigger = page.locator('button[aria-haspopup="menu"][class*="trigger"], button[aria-label*="模型"]').first()
if (await trigger.count() > 0) {
  await trigger.click().catch(() => {})
  await page.waitForTimeout(1500)
  // root pane → 点模型行进入列表
  const modelRow = page.getByRole('menuitem', { name: /模型|Model/ }).first()
  if (await modelRow.count() > 0) { await modelRow.click().catch(() => {}); await page.waitForTimeout(1500) }
  const menuText = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]')
    return menu ? (menu.innerText || '').slice(0, 500) : null
  })
  console.log('--- model menu ---')
  console.log(menuText)
} else {
  console.log('no model trigger found (可能停在首屏 hero)')
}
console.log('--- console errors ---')
for (const e of errors.slice(0, 10)) console.log(e)
await page.screenshot({ path: 'C:/D/opt/deepseek-harness/plugins/dsh-input-tools/scripts/pw-remote-shot.png' })
await browser.close()
