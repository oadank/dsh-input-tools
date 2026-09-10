// UI 二轮验证：滑块开关 / MCP 双行完整命令 / 编辑按钮 / Skill 编辑器
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)
const settings = page.locator('button[aria-label*="设置"], [aria-label*="设置"]').first()
if (await settings.count() > 0) { await settings.click().catch(() => {}); await page.waitForTimeout(1500) }

const nav = page.getByRole('button', { name: 'MCP 服务器', exact: true }).last()
await nav.click().catch(() => {})
await page.waitForTimeout(1800)
const mcp = await page.evaluate(() => {
  const switches = document.querySelectorAll('[role="switch"]')
  const rows = document.body.innerText
  const hasCmd = rows.includes('C:\\D\\opt\\win-desktop-helper\\mcp-bridge.js') || rows.includes('mcp-bridge')
  const editBtns = (rows.match(/编辑/g) || []).length
  return { switchCount: switches.length, sampleCmd: hasCmd, editBtns }
})
console.log('MCP:', JSON.stringify(mcp))

const nav2 = page.getByRole('button', { name: 'Skill 管理', exact: true }).last()
await nav2.click().catch(() => {})
await page.waitForTimeout(1500)
const skillEdit = page.getByRole('button', { name: '编辑', exact: true }).first()
if (await skillEdit.count() > 0) { await skillEdit.click().catch(() => {}); await page.waitForTimeout(2000) }
const skill = await page.evaluate(() => {
  const ta = document.querySelector('textarea')
  const body = document.body.innerText
  return {
    editorOpen: !!ta,
    contentLen: ta ? (ta.value || '').length : 0,
    head: ta ? (ta.value || '').slice(0, 80) : null,
    hasClose: body.includes('关闭'),
  }
})
console.log('Skill editor:', JSON.stringify(skill, null, 2))
console.log('pageerrors:', errors.slice(0, 5))
await page.screenshot({ path: 'C:/D/opt/deepseek-harness/plugins/dsh-input-tools/scripts/pw-ui2-shot.png' })
await browser.close()
