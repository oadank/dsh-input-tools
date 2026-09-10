// 会话内 composer 顺序 + 重渲染稳定性验证
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const URL = 'http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4'
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)

// 打开最近一个会话（点侧栏第二个会话行）
const sessionRow = page.locator('text=验证工具条会话').first()
if (await sessionRow.count() > 0) { await sessionRow.click().catch(() => {}); await page.waitForTimeout(3500) }

const snap = () => page.evaluate(() => {
  const out = []
  for (const card of document.querySelectorAll('[data-composer-card]')) {
    const img = card.querySelector('[aria-label="添加图片"]')
    if (!img) { out.push({ card: card.className.slice(0, 30), noImg: true }); continue }
    const tools = img.closest('[class*="tools"]')
    const seq = Array.from(tools.children).map((c) => {
      if (c.getAttribute('data-slot') === 'conversation.input.left') return 'SLOT(图片/录音)'
      if (String(c.className).includes('modes')) return 'MODES(权限)'
      if (c.tagName === 'INPUT') return 'input'
      return 'btn'
    })
    out.push({ card: card.className.slice(0, 30), seq: seq.join(' | ') })
  }
  return out
})

console.log('--- 打开会话后 ---')
console.log(JSON.stringify(await snap(), null, 2))

// 触发重渲染：在输入框打字 + 切权限菜单开关
const editor = page.locator('[data-composer-card] [contenteditable]').first()
if (await editor.count() > 0) {
  await editor.click().catch(() => {})
  await page.keyboard.type('重渲染测试', { delay: 30 })
  await page.waitForTimeout(1500)
  console.log('--- 打字后 ---')
  console.log(JSON.stringify(await snap(), null, 2))
  // 清空
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(800)
}
// 等待 5 秒观察 MutationObserver 是否持续维持顺序
await page.waitForTimeout(5000)
console.log('--- 静置5s后 ---')
console.log(JSON.stringify(await snap(), null, 2))

await browser.close()
