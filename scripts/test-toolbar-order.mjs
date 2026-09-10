// 工具条顺序算法自测：按监督员 DOM 规格构造，不依赖运行中的 dsh-web
import { createRequire } from 'module'
const require = createRequire('file:///C:/D/opt/deepseek-harness/deepseek-harness/package.json')
const { JSDOM } = require('jsdom')

const placeOne = (img) => {
  const tools = img.closest('[class*="tools"]')
  if (!tools) return false
  let slot = null
  for (const child of tools.children) {
    if (child !== img && child.contains(img)) { slot = child; break }
  }
  if (!slot) return false
  let modes = null
  for (const child of tools.children) {
    if (child.matches && child.matches('[class*="modes"]')) { modes = child; break }
  }
  if (!modes) modes = tools.querySelector('[class*="modes"]')
  if (!modes || modes.parentElement !== tools) return false
  const mi = Array.prototype.indexOf.call(tools.children, modes)
  const ni = Array.prototype.indexOf.call(tools.children, slot)
  if (mi >= 0 && ni >= 0 && ni > mi) {
    tools.insertBefore(slot, modes)
    return true
  }
  return false
}

const place = (doc) => {
  doc.querySelectorAll('[aria-label="添加图片"]').forEach(placeOne)
}

function makeComposer(doc, id) {
  const card = doc.createElement('div')
  card.className = 'IkQe8W_card'
  card.setAttribute('data-composer-card', '')
  const row = doc.createElement('div')
  row.className = 'IkQe8W_row'
  const tools = doc.createElement('div')
  tools.className = 'IkQe8W_tools'
  const plus = doc.createElement('button')
  plus.className = 'IkQe8W_add'
  const attach = doc.createElement('button')
  attach.className = 'IkQe8W_add'
  attach.setAttribute('aria-label', 'attach')
  const modes = doc.createElement('div')
  modes.className = 'IkQe8W_modes'
  const perm = doc.createElement('button')
  perm.textContent = '完全权限'
  modes.appendChild(perm)
  // slots 渲染器：display:contents 的 data-slot 包装
  const slot = doc.createElement('div')
  slot.setAttribute('data-slot', 'conversation.input.left')
  slot.style.display = 'contents'
  const left = doc.createElement('div')
  left.setAttribute('data-composer-left', '')
  left.id = id
  const img = doc.createElement('button')
  img.setAttribute('aria-label', '添加图片')
  const rec = doc.createElement('button')
  rec.setAttribute('aria-label', '录音')
  left.appendChild(img)
  left.appendChild(rec)
  slot.appendChild(left)
  // 初始顺序：modes 在前，插槽在后（官方 InputBar VDOM 序）
  tools.appendChild(plus)
  tools.appendChild(attach)
  tools.appendChild(modes)
  tools.appendChild(slot)
  row.appendChild(tools)
  card.appendChild(row)
  return { card, tools, modes, slot, img }
}

function order(tools) {
  return Array.from(tools.children).map((c) => {
    if (c.matches('[class*="modes"]')) return 'modes'
    if (c.querySelector('[aria-label="添加图片"]')) return 'slot'
    return c.tagName.toLowerCase()
  }).join('|')
}

const dom = new JSDOM(`<!doctype html><html><body></body></html>`)
const { document } = dom.window
global.document = document
global.Element = dom.window.Element
global.MutationObserver = dom.window.MutationObserver

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  PASS', msg)
  else { failed++; console.error('  FAIL', msg) }
}

// 1) 单 composer：modes 前，插槽后 → 挪到 modes 前
console.log('case1: conversation composer')
{
  const c = makeComposer(document, 'c1')
  document.body.appendChild(c.card)
  assert(order(c.tools) === 'button|button|modes|slot', `before=${order(c.tools)}`)
  place(document)
  assert(order(c.tools) === 'button|button|slot|modes', `after=${order(c.tools)}`)
  assert(c.tools.children[2] === c.slot, 'slot is direct child index 2')
  assert(c.tools.children[3] === c.modes, 'modes follows slot')
}

// 2) 已就位再 place → 不重复插入
console.log('case2: already ordered is stable')
{
  const c = makeComposer(document, 'c2')
  document.body.appendChild(c.card)
  place(document)
  const first = order(c.tools)
  place(document)
  assert(order(c.tools) === first && order(c.tools) === 'button|button|slot|modes', `stable=${order(c.tools)}`)
}

// 3) 模拟 React 重渲染把 slot 挪回 modes 后 → 再 place 恢复
console.log('case3: React re-render restores VDOM order, place re-applies')
{
  const c = makeComposer(document, 'c3')
  document.body.appendChild(c.card)
  place(document)
  // React 把 slot 挪回 modes 之后
  c.tools.appendChild(c.slot)
  assert(order(c.tools) === 'button|button|modes|slot', `react undo=${order(c.tools)}`)
  place(document)
  assert(order(c.tools) === 'button|button|slot|modes', `re-fix=${order(c.tools)}`)
}

// 4) 两种 composer 同时存在（会话内 + hero）→ 全处理
console.log('case4: two composers (conversation + hero)')
{
  document.body.innerHTML = ''
  const a = makeComposer(document, 'a')
  const b = makeComposer(document, 'b')
  document.body.appendChild(a.card)
  document.body.appendChild(b.card)
  place(document)
  assert(order(a.tools) === 'button|button|slot|modes', `a=${order(a.tools)}`)
  assert(order(b.tools) === 'button|button|slot|modes', `b=${order(b.tools)}`)
}

// 5) 无 modes 时不炸
console.log('case5: missing modes is no-op')
{
  const c = makeComposer(document, 'c5')
  c.modes.remove()
  document.body.appendChild(c.card)
  place(document)
  assert(order(c.tools) === 'button|button|slot', `no modes=${order(c.tools)}`)
}

// 6) modes 不是 tools 直接子节点 → 不 insertBefore（防 NotFoundError）
console.log('case6: nested modes is no-op')
{
  const c = makeComposer(document, 'c6')
  const wrap = document.createElement('div')
  wrap.className = 'wrap'
  c.tools.replaceChild(wrap, c.modes)
  wrap.appendChild(c.modes)
  document.body.appendChild(c.card)
  place(document)
  // slot 仍在原位（modes 的 parent 不是 tools）
  assert(c.tools.contains(c.slot) && c.slot.previousElementSibling !== c.modes, 'no throw, slot stays')
}

if (failed) {
  console.error(`\n${failed} failure(s)`)
  process.exit(1)
}
console.log('\nall toolbar-order cases passed')
