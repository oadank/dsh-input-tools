// [临时探针] 摸清会话消息 DOM 结构，供 ⚡ 上下文补全取"最近 N 条对话"。
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const URL = process.argv[2] || 'http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4'
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)

const out = await page.evaluate(() => {
  const r = { url: location.href }
  const scroll = document.querySelector('[data-conversation-scroll]')
  r.hasScroll = !!scroll
  if (!scroll) return r
  // 直接子层展开两层，打印 class + data 属性 + 文本片段
  const describe = (el, depth, maxDepth) => {
    const o = {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 70),
      data: Array.from(el.attributes).filter(a => a.name.startsWith('data-')).map(a => a.name + '=' + a.value.slice(0, 30)),
      role: el.getAttribute('role') || '',
      text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
      kids: [],
    }
    if (depth < maxDepth) {
      for (const c of Array.from(el.children).slice(0, 12)) o.kids.push(describe(c, depth + 1, maxDepth))
    } else {
      o.kidCount = el.children.length
    }
    return o
  }
  r.tree = describe(scroll, 0, 3)
  // 找可能的"消息块"：含较长文本的叶子块
  const leaves = []
  for (const el of scroll.querySelectorAll('*')) {
    if (el.children.length > 0) continue
    const t = (el.innerText || '').trim()
    if (t.length < 8) continue
    leaves.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), text: t.slice(0, 90) })
    if (leaves.length >= 14) break
  }
  r.leaves = leaves
  return r
})
console.log(JSON.stringify(out, null, 1).slice(0, 12000))
await browser.close()
