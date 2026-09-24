#!/usr/bin/env node
/**
 * chat-copilot.mjs —— 聊天副驾（桌面侧：眼 + 手）。大脑在 DSH 宿主端点 /copilot-analyze。
 * 抄自 jev-chat-windows / jev-chat-jarvis 的形态，但三处按咱家情况改了：
 *   ① 不 fork win-desktop-helper 源码，直接打它 127.0.0.1:18800 的零鉴权 HTTP（侦察实测它自带 watcher 自愈，无需守护）；
 *   ② OCR 默认走**本机 Ollama qwen3-vl**，不走它配置里的远程 agnes-ai —— 聊天截图属于最不该出门的东西，
 *      远程视觉模型那一路必须 --ocr-helper 显式开启，且开启时会大声警告；
 *   ③ 🔴 永远只**填入**，绝不发送：不 press enter、不点任何"发送/发送(Send)"按钮。发不发由人。
 *
 * 用法：
 *   node chat-copilot.mjs                        # 自动找聊天窗口 → 截图 → 本机 OCR → 出 3 条候选
 *   node chat-copilot.mjs --match 微信 --pick 1  # 指定窗口并把第 1 条填入输入框（需输入框坐标，见 --click）
 *   node chat-copilot.mjs --click 900,1210       # 手动指定输入框中心点（UIA 找不到 Edit 时必给，绝不瞎点）
 *   node chat-copilot.mjs --dump                 # 只看 OCR 结果，不调大脑（排查识别质量用）
 */
const HELP = 'http://127.0.0.1:18800'          // win-desktop-helper shot-service（零鉴权，本机）
const OLLAMA = 'http://127.0.0.1:11434'        // 本机视觉模型，OCR 默认走这条，零外泄
const BRAIN = (process.argv.includes('--brain') ? process.argv[process.argv.indexOf('--brain') + 1] : 'http://127.0.0.1:3080') + '/copilot-analyze'
const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const flag = (f, d) => { const i = argv.indexOf('--' + f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }

const get = async (p) => { const r = await fetch(HELP + p, { signal: AbortSignal.timeout(30_000) }); return JSON.parse(await r.text()) }
const post = async (url, body, ms = 90_000) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) }); return r.json().catch(() => null) }

// 候选聊天窗口特征（进程名/标题任一命中）
const CHAT_HINTS = [['weixin', '微信'], ['wechat', '微信'], ['qq', 'QQ'], ['tim', 'TIM'], ['feishu', '飞书'], ['lark', '飞书'], ['dingtalk', '钉钉'], ['wxwork', '企业微信']]

/** 1) 找聊天窗口：优先前台，其次按 --match */
async function findWindow() {
  const want = flag('match', '')
  const j = await get('/win/list') // 实测形状：{ok,count,apps:[{hwnd,pid,process,title,front,rect:{x,y,w,h}}]}
  const list = Array.isArray(j?.apps) ? j.apps : Array.isArray(j?.windows) ? j.windows : []
  const hit = (w) => {
    const t = String(w.title || ''), p = String(w.process || '').toLowerCase()
    if (want) return t.includes(want) || p.includes(want.toLowerCase())
    return CHAT_HINTS.some(([pp, tt]) => p.includes(pp) || t.includes(tt))
  }
  const cands = list.filter(hit)
  if (!cands.length) { console.error('没找到聊天窗口（在跑的：' + list.slice(0, 6).map((w) => w.process + '|' + String(w.title).slice(0, 14)).join(' ／ ') + '）\n用 --match 标题关键词 指定'); process.exit(2) }
  const front = cands.find((w) => w.front) || cands[0]
  console.log(`窗口: [${front.process}] ${front.title}  rect=${front.rect ? `${front.rect.x},${front.rect.y} ${front.rect.w}x${front.rect.h}` : '?'}  front=${!!front.front}`)
  if (!front.front) console.log('  ⚠ 该窗口不在前台：它用的是 GDI 截屏（遮挡部分拍不到），建议先把它点到前台再跑，否则 OCR 只能看到露出来的边。')
  return front
}

/** 2) 截图 → 落 Pictures\Screenshots（/ocr 只吃这个目录，SafeShotPath 硬约束） */
async function grab(w) {
  const j = await get('/shot?window=' + encodeURIComponent(w.title))
  const p = j.path || j.file || j.png || ''
  if (!p) throw new Error('截图没返回路径: ' + JSON.stringify(j).slice(0, 160))
  console.log('截图: ' + p + (j.bytes ? ` (${j.bytes}B)` : ''))
  return p
}

const OCR_PROMPT = '这是电脑上一个聊天软件的窗口截图。只输出聊天记录区的消息，每行一条，格式严格为「谁: 内容」：\n' +
  '自己发出的（通常右侧或不同底色气泡）写「我:」，别人发的写「对方:」；能认出昵称就写昵称。\n' +
  '气泡外的东西（标题栏、菜单、输入框占位符、时间戳、未读角标、侧栏会话列表）一律不要输出。\n' +
  '文字看不清就跳过那条，不要编造。只输出这些行，不要前言、不要编号、不要解释。'

/** 3) OCR：默认本机 Ollama（零外泄）；--ocr-helper 才走它配置里的远程视觉模型 */
async function readPng(path) {
  const { readFileSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const abs = path.startsWith('~') ? join(homedir(), path.slice(2)) : path
  const b64 = readFileSync(abs).toString('base64')
  if (has('ocr-helper')) {
    console.log('⚠⚠ 正在用远程第三方视觉模型 OCR —— 这张图含你的聊天内容，等于把聊天记录发给外部服务。')
    const j = await get('/ocr?path=' + encodeURIComponent(abs.split(/[\\/]/).pop()) + '&wait=120000')
    return String(j.text || j.result || JSON.stringify(j).slice(0, 400))
  }
  const j = await post(OLLAMA + '/api/chat', { model: flag('ocr-model', 'qwen3-vl:4b-instruct'), stream: false, options: { temperature: 0 }, messages: [{ role: 'user', content: OCR_PROMPT, images: [b64] }] }, 180_000)
  const t = String(j?.message?.content ?? '')
  if (!t) throw new Error('本机 OCR 无输出（ollama 在跑吗？模型名对不对？）：' + JSON.stringify(j).slice(0, 200))
  console.log(`OCR(本机 ${flag('ocr-model', 'qwen3-vl:4b-instruct')}): ${t.length} 字`)
  return t
}

/** 4) OCR 文本 → messages[] */
function toMessages(raw) {
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(.{0,14}?)\s*[:：]\s*(.+)$/.exec(line)
    if (!m) continue
    const who = m[1].trim(), text = m[2].trim()
    if (!text || text.length < 1) continue
    out.push({ side: (who === '我' || who === 'me' || who === '自己') ? 'me' : 'other', who: who === '我' ? '对方' : who, text: text.slice(0, 600) })
  }
  return out.slice(-20)
}

/** 5) 🔴 填入：写剪贴板 → 聚焦输入框（只点给定坐标或 UIA 找到的 Edit）→ Ctrl+V。**绝不回车**。 */
async function fill(w, text) {
  const s = await get('/clipboard/set?keep_cr=1&text=' + encodeURIComponent(text))
  if (!s.ok) throw new Error('写剪贴板失败: ' + JSON.stringify(s).slice(0, 120))
  const back = await get('/clipboard/get')
  if (String(back.text).trim() !== text.trim()) throw new Error('剪贴板回读不一致，放弃填入（不做半截操作）')
  let pt = flag('click', '')
  if (!pt) {
    const u = await get('/ui/find?title=' + encodeURIComponent(w.title) + '&type=Edit')
    const e = Array.isArray(u?.elements) ? u.elements[0] : null
    if (e?.rect) pt = Math.round(e.rect.x + e.rect.w / 2) + ',' + Math.round(e.rect.y + e.rect.h / 2)
    else { console.log('✗ 没定位到输入框（UIA 里没有 Edit 控件）。我不会瞎点。加 --click x,y 指定输入框中心坐标再试。'); return false }
  }
  const [x, y] = pt.split(',').map(Number)
  console.log(`  点输入框 (${x},${y}) → 粘贴（不发送）`)
  await get(`/mouse?action=click&x=${x}&y=${y}`)
  await new Promise((r) => setTimeout(r, 250))
  await get('/keyboard/press?keys=ctrl+v')
  console.log('✓ 已填入输入框。发送请你自己按回车 —— 本工具永不代发。')
  return true
}

// ── 主流程 ──
const w = await findWindow()
if (has('activate')) await get('/win/manage?hwnd=' + w.hwnd + '&verb=activate')
const png = await grab(w)
const raw = await readPng(png)
if (has('dump')) { console.log('\n─── OCR 原文 ───\n' + raw) }
const messages = toMessages(raw)
console.log(`解析出 ${messages.length} 条消息`)
if (!messages.length) { console.log('─── OCR 原文（解析不出消息，贴出来给人看）───\n' + raw.slice(0, 1200)); process.exit(3) }
for (const m of messages.slice(-6)) console.log(`  ${m.side === 'me' ? '我  ' : (m.who || '对方')}: ${m.text.slice(0, 52)}`)
if (has('dump')) process.exit(0)

console.log('\n─── 调大脑 /copilot-analyze ───')
const brain = await post(BRAIN, { messages, relationship: flag('rel', ''), style: flag('style', '') }, 120_000).catch((e) => ({ ok: false, error: String(e.message || e) }))
if (!brain?.ok) { console.error('大脑不可达/未生效：' + JSON.stringify(brain).slice(0, 220) + '\n（宿主端点要 dsh-web 重启后才生效；离线自检用 copilot_offline.mjs）'); process.exit(4) }
console.log('判断: ' + JSON.stringify(brain.judge))
console.log('小抄: ' + (brain.guidance || '(无)'))
if (brain.degraded?.judge || brain.degraded?.draft) console.log('降级: ' + JSON.stringify(brain.degraded) + (brain.draftError ? ' ' + brain.draftError.slice(0, 120) : ''))
brain.candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c.p == null ? '—' : c.p.toFixed(2)}  ${c.text}`))
const pick = flag('pick', '')
if (pick) await fill(w, brain.candidates[Number(pick) - 1]?.text || '')
