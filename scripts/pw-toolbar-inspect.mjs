// 工具条 DOM 实测：真实浏览器打开 dsh web，抓 composer 结构 + 验证插件代码加载
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const URL = process.argv[2] || 'http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4'
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage()
const consoleLogs = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLogs.push(`[${m.type()}] ${m.text().slice(0, 200)}`) })
page.on('pageerror', (e) => consoleLogs.push(`[pageerror] ${String(e).slice(0, 300)}`))

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3000)

const report = await page.evaluate(async () => {
  const out = { title: document.title, url: location.href }
  // 1) 插件代码加载验证：从 performance entries 找 dsh-input-tools
  const entries = performance.getEntriesByType('resource').map(r => r.name)
  out.pluginUrls = entries.filter(u => /dsh-input-tools/.test(u))
  // fetch 插件 client.js 内容验证新版
  out.pluginContentChecks = {}
  for (const u of out.pluginUrls.slice(0, 3)) {
    try {
      const text = await fetch(u).then(r => r.text())
      out.pluginContentChecks[u] = {
        len: text.length,
        pickRecorderMimeType: text.includes('pickRecorderMimeType'),
        leftBeforeModes: text.includes('left-before-modes'),
      }
    } catch (e) { out.pluginContentChecks[u] = String(e).slice(0, 100) }
  }
  // 2) composer DOM 结构
  const cards = document.querySelectorAll('[data-composer-card]')
  out.cardCount = cards.length
  out.cards = []
  for (const card of cards) {
    const info = { cardClass: card.className.slice(0, 80) }
    const img = card.querySelector('[aria-label="添加图片"]')
    if (!img) { info.noImg = true; out.cards.push(info); continue }
    const tools = img.closest('[class*="tools"]')
    info.toolsClass = tools ? tools.className : null
    if (tools) {
      info.children = Array.from(tools.children).map((c) => ({
        tag: c.tagName.toLowerCase(),
        cls: (c.className && String(c.className).slice(0, 60)) || '',
        dataSlot: c.getAttribute('data-slot'),
        hasImg: c.contains(img),
        text: (c.textContent || '').slice(0, 30),
      }))
      // modes 候选：直接子里含 aria-haspopup=menu 按钮的 div
      const modesCandidates = Array.from(tools.children).filter(c =>
        c.tagName === 'DIV' && c !== img.closest('[data-slot]') && c.querySelector('button[aria-haspopup="menu"]'))
      info.modesCandidates = modesCandidates.map(c => c.className.slice(0, 60))
      // 完全权限 trigger 类名
      const perm = tools.querySelector('button[aria-haspopup="menu"]')
      info.permTriggerClass = perm ? perm.className.slice(0, 60) : null
      info.permTriggerParentClass = perm ? perm.parentElement.className.slice(0, 60) : null
      // 类名是否含 "tools"/"modes" 字样
      info.toolsMatch = /tools/.test(tools.className)
      const modesDiv = tools.querySelector('[class*="modes"]')
      info.modesMatch = modesDiv ? modesDiv.className.slice(0, 60) : null
    }
    out.cards.push(info)
  }
  return out
})

console.log(JSON.stringify(report, null, 2))
console.log('\n--- console errors/warnings ---')
for (const l of consoleLogs.slice(0, 20)) console.log(l)

await page.screenshot({ path: 'C:/D/opt/deepseek-harness/plugins/dsh-input-tools/scripts/pw-shot.png', fullPage: false })
await browser.close()

