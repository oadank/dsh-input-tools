// [2026-09-24] 消息撤回 + 历史对话删除（老大点名两个功能，纯插件实现，零核心 Remote 改动）
//
// 三条路由（挂在 webServer 根路径，与既有 /voice-config /optimize-prompt 同级，本机 127.0.0.1 服务）：
//   POST /retro-message-delete  {sessionId, seq, alsoStop?}  撤回自己发的一条消息
//   GET  /retro-deleted?sessionId=                            该会话已作废的 seq 列表（前端据此持久隐藏）
//   POST /retro-session-delete  {sessionId}                   整段历史移入回收站（7 天后自动清除）
//   GET  /retro-trash                                         回收站清单（恢复用）
//   POST /retro-trash-restore  {entry}                        从回收站恢复一段历史
//
// 「真删」的语义（与老大确认）：
//   1) 消息还在队列（没进日志）→ 直接从 inbox 摘掉，模型永远看不到；
//   2) 消息已进日志 → 追写作废事件（空内容 system/message + surfaceOp.replace 覆盖该 seq）。
//      官方 surface 折叠把被覆盖节点投影成 null（core/session/index.ts deriveMessages: `if (msg) push`），
//      所以下一次请求起模型彻底看不见；作废事件本身落进同一份日志，重启/换端/回放都一致——
//      不是界面上贴个 display:none。原始字节仍在压缩日志里（逻辑删除档，老大选定的第一档）。
//   3) 整段历史 → 归档摘名 + 日志目录/投影缓存物理移入 ~/.dsh/trash/sessions/，7 天后清扫。
//
// 服务获取一律用 ctx.get(name)（可选注入）：本插件 inject 列表不含 sessions/agents，
// 硬加会让整个语音插件在名字对不上时永久 PENDING。取不到就是取不到，报错给前端，不牵连其他功能。

import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'

/** 回收站保留天数（超期物理清除）。 */
const TRASH_KEEP_DAYS = 7

// [本地改造 2026-09-24 老大质疑「历史消息模型怎可能看不见」后补] 弹窗必须分清三种「不在上下文里」，
/** 服务端留痕，排查"为什么没认到这条"用。 */
function log(msg) { try { process.stdout.write('[retro] ' + msg + '\n') } catch { /* 日志不通不影响主流程 */ } }

// 不再一律说成"被折叠过"。依据：官方 core/session/src/types.ts:550 明列只有这四种事件能上表面；
// 压缩事件族是 compaction/start|summary|prune|end（known-event-types.ts:32-35）。
/** 能进模型上下文（上表面）的事件类型。 */
const SURFACE_TYPES = ['system/message', 'user/message', 'assistant/message', 'tool/result']

/**
 * 最近一次压缩事件的序号：它之前的原文都已被摘要顶掉。
 * @param session - 实时 Session。
 * @returns 序号；这段会话从没压缩过返回 -1。
 */
function compactionWatermark(session) {
  let max = -1
  try {
    for (const event of session.ownEvents?.() ?? []) {
      if (typeof event?.type !== 'string' || !event.type.startsWith('compaction/')) continue
      const n = Number(event.seq)
      if (Number.isSafeInteger(n) && n > max) max = n
    }
  } catch { return max }
  return max
}

/**
 * 「连模型回话一起删」的目标：这条之后、下一条你自己发的消息之前的全部表面节点（回话 + 工具结果）。
 * @param session - 实时 Session。
 * @param seq - 那条用户消息的序号。
 * @returns 需一并作废的序号数组（不含 seq 本身）。
 */
function replySeqsAfter(session, seq) {
  const out = []
  try {
    let boundary = Number.MAX_SAFE_INTEGER
    for (const event of session.ownEvents?.() ?? []) {
      const n = Number(event?.seq)
      if (!Number.isSafeInteger(n) || n <= seq) continue
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') { boundary = n; break }
    }
    for (const n of session.surface?.nodes ?? []) {
      const v = Number(n)
      if (Number.isSafeInteger(v) && v > seq && v < boundary) out.push(v)
    }
  } catch { return out }
  return out
}

/** @returns DSH 数据根目录。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** @returns 回收站根目录。 */
function trashRoot() {
  return join(dshHome(), 'trash', 'sessions')
}

/**
 * 统一 JSON 应答。
 * @param res - Node ServerResponse。
 * @param code - HTTP 状态码。
 * @param body - 应答体。
 */
function send(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * 读 JSON 请求体（拒收 multipart：官方 readJsonBody 的坑，边界串会被当正文喂给下游）。
 * @param req - Node IncomingMessage。
 * @returns 解析后的对象，空体返回 {}。
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  return JSON.parse(raw)
}

/**
 * 校验 sessionId：只接受本服务已知的形态（uuid 或 session-<uuid>），防路径穿越。
 * @param value - 请求里的 sessionId。
 * @returns 合法则原样返回，否则 undefined。
 */
function safeId(value) {
  const id = String(value ?? '')
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/.test(id) ? id : undefined
}

/**
 * 校验 seq：非负安全整数。
 * @param value - 请求里的 seq。
 * @returns 合法则返回数字，否则 undefined。
 */
function safeSeq(value) {
  const n = Number(value)
  // 序号从 1 起（日志第一条事件就是 seq 1）。0 只可能是前端读不到属性时 Number(null) 的假值，
  // 放过就会拿整段会话的第一条事件当目标开枪 —— 直接判非法。
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

/**
 * 从事件里抽出用户消息的纯文本（用来核对前端点的那一行到底是不是这条）。
 * @param event - session.eventAt(seq) 拿到的事件。
 * @returns 文本，形状不认识时返回空串。
 */
function userTextOf(event) {
  try {
    const content = event?.data?.message?.content ?? event?.data?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join(' ')
    }
  } catch { /* 形状不认识就当没文本 */ }
  return ''
}

/**
 * 前端那一行的可见文字与该序号事件的原文是否对得上。
 * 对不上说明前端认错了行：这时候宁可不删，也绝不能拿别的序号开枪。
 * @param domText - 前端传来的行内文字（含时间戳等杂质，且被截断）。
 * @param eventText - 该序号事件的真实文本。
 * @returns 一致、或有一边根本没文字（交给别的档位说话）时返回 true。
 */
function textAgrees(domText, eventText) {
  const a = String(domText ?? '').replace(/\s+/g, '')
  const b = String(eventText ?? '').replace(/\s+/g, '')
  // [本地改造 2026-09-25 老大实测「我删的那条你还看得见」] 事件本身没文字（图片/附件/工具节点）
  // 一律算"对不上"：官方把同一轮的图和文字拆成两条 user/message，行上的 node key 可能指向图那条，
  // 空串放行就会删掉图、留下他看到的文字。前端压根没给文字时才宽松放行（兼容旧缓存）。
  if (b === '') return a === ''
  if (a === '') return true
  return a.includes(b.slice(0, 40)) || b.includes(a.slice(0, 40))
}

/**
 * 校验轮号：非负安全整数（第 0 轮确实存在，所以允许 0）。
 * @param value - 请求里的 turn/occurrence。
 * @returns 合法则返回数字，否则 undefined。
 */
function safeTurn(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

/**
 * 会话里「你自己发的」用户消息清单，按日志顺序，带 seq / 轮号 / 消息 id / 文本。
 * 轮号不在 user/message 的载荷里（MessageBase 只有 id/content/source，轮号挂在 turn/start 上，
 * 见 core/session/src/types.ts:288），所以跟着 turn/start 走一遍累积出来。
 * @param session - 实时 Session。
 * @returns 条目数组；读不动返回已收集的部分。
 */
function userMessagesOf(session) {
  const out = []
  let turn = 0
  try {
    for (const event of session.ownEvents?.() ?? []) {
      if (event.type === 'turn/start') {
        const t = Number(event.data?.turn)
        if (Number.isSafeInteger(t)) turn = t
        continue
      }
      if (event.type !== 'user/message') continue
      if (event.data?.source?.kind !== 'user') continue
      out.push({ seq: Number(event.seq), turn, id: String(event.data?.id ?? ''), text: userTextOf(event) })
    }
  } catch { return out }
  return out
}

/**
 * 三种寻址全支持，取到一个算一个：① seq 直给；② 日志里的 MessageId（官方 data-chat-node-key
 * 末尾很可能是它而不是序号）；③ 轮号 + 这行文字（DOM 只给得出 data-chat-turn 时），
 * 同轮同文字的多行用 occurrence 选第几个。全落空返回 undefined，上层据此拒删，绝不瞎猜。
 * @param session - 实时 Session。
 * @param addr - 前端给的寻址信息。
 * @returns 命中该用户消息的 seq，认不出返回 undefined。
 */
function resolveTargetSeq(session, addr) {
  const list = userMessagesOf(session)
  if (list.length === 0) return undefined
  const domText = String(addr.text ?? '')
  const hitMid = addr.mid !== undefined && addr.mid !== '' ? list.find((m) => m.id === addr.mid) : undefined
  const hitSeq = addr.seq !== undefined ? list.find((m) => m.seq === addr.seq) : undefined
  // ① id / 序号硬命中，但正文必须对得上 —— 同一轮的「图片消息」和「文字消息」是两条事件，
  //    行上挂的 node key 可能指向图片那条，只认 id 就会删错（老大实测：删了图，字还在）。
  for (const cand of [hitMid, hitSeq]) {
    if (cand !== undefined && textAgrees(domText, cand.text)) return cand.seq
  }
  // ② 轮号 + 正文（同轮同文的重复行按 DOM 顺序取第 occurrence 个）
  if (addr.turn !== undefined) {
    const cands = list.filter((m) => m.turn === addr.turn && textAgrees(domText, m.text))
    const k = Number.isSafeInteger(addr.occurrence) && addr.occurrence >= 0 ? addr.occurrence : 0
    if (cands.length > k) return cands[k].seq
  }
  // ③ 整段会话里正文唯一命中
  const byText = list.filter((m) => textAgrees(domText, m.text))
  if (byText.length === 1) return byText[0].seq
  // ④ 前端没给正文（旧缓存）时才允许退回纯 id / 纯序号，免得功能直接瘫
  if (domText.trim() === '') {
    if (hitMid !== undefined) return hitMid.seq
    if (hitSeq !== undefined) return hitSeq.seq
  }
  // ⑤ 这行本身没有正文（纯截图/纯附件消息，DOM 里只剩"图片加载中…"这类占位词）：上面按文字的
  //    路子必然全落空，此时才允许退回纯 id / 纯序号 —— 否则这类消息就永远删不掉了。
  //    有真文字的行绝不走这步，正是这次删错行的那条路。
  const prose = domText.replace(/图片加载中|加载中|图片|附件|粘贴|\d{1,2}:\d{2}|\d{4}-\d{1,2}-\d{1,2}|[\s.…。、，！？；：~·-]/g, "")
  if (prose.length < 8) {
    if (hitMid !== undefined) return hitMid.seq
    if (hitSeq !== undefined) return hitSeq.seq
  }
  log('未认到 by=' + (addr.seq !== undefined ? 'seq' : addr.mid !== undefined ? 'mid' : 'turn')
    + ' 候选=' + list.filter((m) => textAgrees(domText, m.text)).length + ' 正文=' + JSON.stringify(domText.slice(0, 24)))
  return undefined
}

/**
 * 该会话日志里最后一条 system/message 的 turn/step（作废事件复用同一坐标，避免造出乱序坐标）。
 * v4 要求 turn/step 为正整数；读不到就退回 1/1，绝不写 0。
 * @param session - 实时 Session。
 * @returns {turn, step}。
 */
function lastSystemCoords(session) {
  let turn = 1
  let step = 1
  try {
    for (const event of session.ownEvents?.() ?? []) {
      if (event.type === 'system/message') {
        turn = Number(event.data?.turn) || turn
        step = Number(event.data?.step) || step
      }
    }
  } catch { /* 读不到就用 1/1 */ }
  return { turn: turn > 0 ? turn : 1, step: step > 0 ? step : 1 }
}

/**
 * 构造合法的作废标记 user/message（覆盖目标 seq 的 surface replacement）。
 * [2026-09-25 修] 不能用 system/message——v4 要求 system/message 落在打开的 step 里，
 * 撤回时多半在 step 外，会报 "system/message does not match an open step"。
 * user/message 的 surface replace 不要求 step，且空 content 同样让模型看不见。
 * @param target - 被覆盖的消息 seq。
 * @returns 可直接 session.append 的 data。
 */
function tombstoneUserData(target) {
  return {
    id: `retro-void-${target}-${Date.now().toString(36)}`,
    role: 'user',
    source: { kind: 'plugin:dsh-input-tools', form: 'notice', summary: `void seq ${target}` },
    content: [],
  }
}

/**
 * 扫日志找出全部作废标记（空内容 user/message 且 replace 覆盖单点；兼容旧 system/message 标记）。
 * @param session - 实时 Session。
 * @returns 被作废的 seq 数组。
 */
function deletedSeqsOf(session) {
  const out = []
  try {
    for (const event of session.ownEvents?.() ?? []) {
      if (event.type !== 'system/message' && event.type !== 'user/message') continue
      const op = event.surfaceOp
      if (!op || op === 'append' || typeof op !== 'object') continue
      if (op.op !== 'replace' || op.startSeq !== op.endSeq) continue
      const msg = event.type === 'system/message' ? event.data?.message : event.data
      const content = msg?.content
      if (Array.isArray(content) && content.length === 0) out.push(op.startSeq)
    }
  } catch { return out }
  return out
}

/**
 * 在某工作区目录下找会话日志目录。
 * @param sessionId - 会话 id。
 * @returns 目录绝对路径数组（同名多处分居不同工作区时全部返回）。
 */
async function findSessionDirs(sessionId) {
  const root = join(dshHome(), 'sessions')
  const hits = []
  if (!existsSync(root)) return hits
  let workspaces = []
  try { workspaces = await readdir(root, { withFileTypes: true }) } catch { return hits }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const candidate = join(root, ws.name, sessionId)
    if (existsSync(candidate)) hits.push(candidate)
  }
  return hits
}

/**
 * 回收站过期清扫（启动后跑一次，失败静默——清不掉不该影响聊天）。
 */
async function sweepTrash() {
  try {
    const root = trashRoot()
    if (!existsSync(root)) return
    const entries = await readdir(root)
    const cutoff = Date.now() - TRASH_KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of entries) {
      const full = join(root, name)
      try {
        const st = await stat(full)
        if (st.mtimeMs < cutoff) await rm(full, { recursive: true, force: true })
      } catch { /* 单个条目清不掉就跳过 */ }
    }
  } catch { /* 回收站不存在 */ }
}

/**
 * 挂上撤回/删除相关路由与一次性清扫。
 * @param ctx - Cordis 插件上下文。
 */
export function applyRetroDelete(ctx) {
  ctx.effect(() => {
    const disposers = []
    void sweepTrash()

    /** 取实时 Session（会话没在服务端打开时返回 undefined）。 */
    const liveSession = (sessionId) => {
      const store = ctx.get?.('sessions') ?? ctx.sessions
      if (store?.get === undefined) return undefined
      try { return store.get(sessionId) } catch { return undefined }
    }
    /** 取实时 Agent（可能没有）。 */
    const liveAgent = (sessionId) => {
      const store = ctx.get?.('agents') ?? ctx.agents
      if (store?.get === undefined) return undefined
      try { return store.get(sessionId) } catch { return undefined }
    }

    // ── 撤回一条自己发的消息 ────────────────────────────────────────────
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/retro-message-delete',
        handler: async (req, res) => {
          if (req.method !== 'POST') { send(res, 405, { ok: false, error: '只接受 POST' }); return }
          try {
            const body = await readBody(req)
            const sessionId = safeId(body.sessionId)
            const seqArg = safeSeq(body.seq)
            const midArg = typeof body.mid === 'string' && body.mid !== '' ? body.mid.slice(0, 120) : undefined
            const turnArg = safeTurn(body.turn)
            const occArg = safeTurn(body.occurrence)
            const messageId = typeof body.messageId === 'string' ? body.messageId : undefined
            if (sessionId === undefined) { send(res, 400, { ok: false, error: 'sessionId 非法' }); return }
            const session = liveSession(sessionId)
            if (session === undefined) {
              send(res, 409, {
                ok: false,
                reason: 'closed',
                error: '这段会话现在没在服务端打开：先在网页里点开它再撤回。',
              })
              return
            }
            // 顺带叫停当前回合（老大选「弹窗问一次」，勾了才停）
            let stopped = false
            if (body.alsoStop === true) {
              const agent = liveAgent(sessionId)
              if (agent?.status === 'running' && typeof agent.cancel === 'function') {
                try { agent.cancel(); stopped = true } catch { /* 停不掉就算了 */ }
              }
            }
            // 第一优先：还排在队列里（没进日志）→ 真删
            const agent = liveAgent(sessionId)
            const inbox = agent?.inbox
            if (messageId !== undefined && inbox !== undefined) {
              let pending = false
              try { pending = inbox.remove(messageId) === true } catch { pending = false }
              if (pending) { send(res, 200, { ok: true, mode: 'queue', stopped }); return }
            }
            // 前端可能给的是 seq / 消息 id / 轮号+文字，任一种认到就算认到；一种都认不到就拒删。
            const seq = resolveTargetSeq(session, {
              seq: seqArg,
              mid: midArg,
              turn: turnArg,
              text: typeof body.text === 'string' ? body.text : undefined,
              occurrence: occArg,
            })
            if (seq === undefined) {
              send(res, 409, {
                ok: false,
                reason: 'mismatch',
                error: '认不出这是会话里的哪一条，没敢删（宁可不删，不删错行）。刷新页面再点一次。',
              })
              return
            }
            const event = session.eventAt?.(seq)
            if (event === undefined) {
              send(res, 404, { ok: false, reason: 'not-found', error: '这条消息不在这段会话里（可能翻页还没加载）。' })
              return
            }
            if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') {
              send(res, 400, { ok: false, error: '只能删除你自己发的消息。' })
              return
            }
            // 内容核对：这行的文字必须与该序号的原文对得上，对不上就拒删（宁可不删，不删错行）。
            if (typeof body.text === 'string' && body.text !== '' && !textAgrees(body.text, userTextOf(event))) {
              send(res, 409, {
                ok: false,
                reason: 'mismatch',
                error: '这一行和会话里的记录对不上，没敢删（怕删错别条）。刷新页面再点一次。',
              })
              return
            }
            const already = deletedSeqsOf(session).includes(seq)
            const nodes = session.surface?.nodes ?? []
            const inSurface = nodes.includes(seq)
            // [本地改造 2026-09-24 老大点名] 勾了「连模型对这条的回话一起删」→ 把这条之后、下一条你
            // 自己发的消息之前的表面节点（模型回话 + 中途工具结果）一并追写作废事件。
            const targets = inSurface && !already ? [seq] : []
            // [本地改造 2026-09-25 老大] 目标这条自己没作废成（不在表面/已作废），就绝不许连带删它的回复：
            // 上次就是这样把你那条文字留下了、却把 AI 的回话整串清掉。
            if (body.alsoReply === true && targets.length > 0) {
              const dead = deletedSeqsOf(session)
              for (const r of replySeqsAfter(session, seq)) { if (!dead.includes(r) && !targets.includes(r)) targets.push(r) }
            }
            if (targets.length > 0) {
              const voided = []
              for (const target of targets) {
                // [2026-09-25 修] 作废标记改用 user/message（system/message 必须落在打开的
                // step 里，撤回时写不进去）；空 content + surfaceOp.replace 让模型侧彻底消失。
                try {
                  session.append('user/message', tombstoneUserData(target), {
                    surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
                    sourceEventSeqs: [target],
                  })
                  voided.push(target)
                } catch (err) {
                  if (voided.length === 0) {
                    send(res, 500, {
                      ok: false,
                      error: '作废事件写入失败：' + (err instanceof Error ? err.message : String(err)),
                    })
                    return
                  }
                  break
                }
              }
              const store = ctx.get?.('sessions') ?? ctx.sessions
              try { await store?.flush?.(session) } catch { /* 落盘由会话自己收尾 */ }
              send(res, 200, { ok: true, mode: 'tombstone', seq, voided, stopped })
              return
            }
            // 已被压缩/已被作废：逻辑上模型早就看不见了，只回状态给前端隐藏
            send(res, 200, {
              ok: true,
              mode: inSurface ? 'tombstone-failed' : 'already-gone',
              seq,
              stopped,
            })
          } catch (error) {
            send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
    }

    // ── 这条消息现在处于哪一档（弹窗按档说话，别拿"抹掉记忆"吓唬还没被看到的） ──
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/retro-stage',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', `http://${hostname()}`)
          if (url.pathname !== '/retro-stage') { send(res, 404, { ok: false, error: 'not found' }); return }
          const sessionId = safeId(url.searchParams.get('sessionId'))
          const seqArg = safeSeq(url.searchParams.get('seq'))
          const messageId = safeId(url.searchParams.get('messageId'))
          const midRaw = url.searchParams.get('mid')
          const turnArg = safeTurn(url.searchParams.get('turn'))
          const occArg = safeTurn(url.searchParams.get('occurrence'))
          const domText = url.searchParams.get('text') ?? ''
          if (sessionId === undefined) { send(res, 400, { ok: false, error: 'sessionId 非法' }); return }
          const session = liveSession(sessionId)
          if (session === undefined) { send(res, 200, { ok: true, stage: 'unknown', open: false }); return }
          const agent = liveAgent(sessionId)
          // 还排在队列里：模型一个字都没看到
          if (messageId !== undefined && agent?.inbox !== undefined) {
            let pending = false
            try {
              pending = (agent.inbox.nextTurn ?? []).some((m) => m.id === messageId)
                || (agent.inbox.nextStep ?? []).some((m) => m.id === messageId)
            } catch { pending = false }
            if (pending) { send(res, 200, { ok: true, stage: 'queue' }); return }
          }
          // [本地改造 2026-09-25 老大实测「删除按钮直接没了」] 前端未必拿得出 seq：官方
          // data-chat-node-key 末尾很可能是日志里的 MessageId。三种寻址都试，全落空就报 mismatch。
          const seq = resolveTargetSeq(session, {
            seq: seqArg,
            mid: midRaw !== null && midRaw !== '' ? midRaw.slice(0, 120) : undefined,
            turn: turnArg,
            text: domText,
            occurrence: occArg,
          })
          if (seq === undefined) {
            const addressed = seqArg !== undefined || midRaw !== null || turnArg !== undefined
            // 一行日志，下次排查不用靠猜：记下前端到底给了什么、为什么没认到。
            try {
              process.stdout.write('[retro] stage 未认到 by=' + (addressed ? 'seq/mid/turn 都没命中' : '前端没给寻址信息')
                + ' seqArg=' + String(seqArg) + ' mid=' + String(midRaw) + ' turn=' + String(turnArg)
                + ' occ=' + String(occArg) + ' text=' + JSON.stringify(domText.slice(0, 30)) + '\n')
            } catch { /* 日志写不进不影响应答 */ }
            send(res, 200, { ok: true, stage: addressed ? 'mismatch' : 'unknown' })
            return
          }
          try {
            process.stdout.write('[retro] stage seq=' + seq + ' by=' + (seqArg !== undefined ? 'seq' : midRaw !== null && midRaw !== '' ? 'mid' : turnArg !== undefined ? 'turn' : 'text')
              + ' turn=' + String(turnArg) + ' text=' + JSON.stringify(domText.slice(0, 24)) + '\n')
          } catch { /* 同上 */ }
          // 先核内容再报档位：认到的这条与前端那行文字对不上，就是认错了行。
          const probe = session.eventAt?.(seq)
          if (domText !== '' && probe?.type === 'user/message' && !textAgrees(domText, userTextOf(probe))) {
            send(res, 200, { ok: true, stage: 'mismatch', seq })
            return
          }
          const nodes = session.surface?.nodes ?? []
          if (!nodes.includes(seq)) {
            if (deletedSeqsOf(session).includes(seq)) { send(res, 200, { ok: true, stage: 'retracted', seq }); return }
            // 不在上下文里的三种情况分开报（老大实测质疑后的更正，别再拿"折叠"糊弄）：
            // 1) 这个序号根本不是能进上下文的消息 → not-message
            const event = session.eventAt?.(seq)
            if (event === undefined || !SURFACE_TYPES.includes(event.type)) {
              send(res, 200, { ok: true, stage: 'not-message', seq })
              return
            }
            // 2) 真被摘要顶掉 → compacted；3) 只是超出这次携带的范围 → windowed
            const watermark = compactionWatermark(session)
            send(res, 200, { ok: true, stage: watermark >= 0 && seq < watermark ? 'compacted' : 'windowed', seq })
            return
          }
          send(res, 200, { ok: true, stage: agent?.status === 'running' ? 'running' : 'done', seq })
        },
      }))
    }

    // ── 已作废清单（前端据此持久隐藏，刷新/换端一致） ───────────────────
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/retro-deleted',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', `http://${hostname()}`)
          if (url.pathname !== '/retro-deleted') { send(res, 404, { ok: false, error: 'not found' }); return }
          const sessionId = safeId(url.searchParams.get('sessionId'))
          if (sessionId === undefined) { send(res, 400, { ok: false, error: 'sessionId 非法' }); return }
          const session = liveSession(sessionId)
          if (session === undefined) { send(res, 200, { ok: true, seqs: [], ids: [], open: false }); return }
          const seqs = deletedSeqsOf(session)
          // 前端拿消息 id 寻址的行，只有靠 id 才知道该收哪一行（seq 未必对得上）。
          const ids = []
          for (const s of seqs) {
            const ev = session.eventAt?.(s)
            if (ev?.type !== 'user/message') continue
            const id = String(ev.data?.id ?? '')
            if (id !== '') ids.push(id)
          }
          send(res, 200, { ok: true, seqs, ids, open: true })
        },
      }))
    }

    // ── 整段历史删除：归档摘名 + 日志与投影缓存移入回收站 ───────────────
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/retro-session-delete',
        handler: async (req, res) => {
          if (req.method !== 'POST') { send(res, 405, { ok: false, error: '只接受 POST' }); return }
          try {
            const body = await readBody(req)
            const sessionId = safeId(body.sessionId)
            if (sessionId === undefined) { send(res, 400, { ok: false, error: 'sessionId 非法' }); return }
            const agent = liveAgent(sessionId)
            if (agent?.status === 'running') {
              send(res, 409, { ok: false, reason: 'running', error: '这段还在跑，先点停止再删（免得日志写一半）。' })
              return
            }
            const moved = []
            const entryName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${sessionId}`
            const dest = join(trashRoot(), entryName)
            // 1) 先从工作区登记表摘掉：走官方 archive（内存与盘一致，不手改文件）
            const registry = ctx.get?.('workspaceRegistry')
            try { await registry?.archiveSession?.(sessionId) } catch { /* 没有登记表能力就只删文件 */ }
            // 2) 关掉实时会话（释放写锁），再挪文件
            const session = liveSession(sessionId)
            try {
              const carrier = session?.carrier ?? session
              if (typeof carrier?.detach === 'function') carrier.detach()
            } catch { /* 关不掉也别把请求打死 */ }
            const store = ctx.get?.('sessions')
            try { await store?.flush?.(session) } catch { /* 已无改动可写 */ }
            for (const dir of await findSessionDirs(sessionId)) {
              await mkdir(dest, { recursive: true })
              const target = join(dest, dir.split(/[\\/]/).slice(-2).join('__'))
              await rename(dir, target)
              moved.push(target)
            }
            const cache = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
            if (existsSync(cache)) {
              await mkdir(dest, { recursive: true })
              await rename(cache, join(dest, `${sessionId}.projcache.json`))
            }
            if (moved.length === 0 && !existsSync(join(dest))) {
              send(res, 404, { ok: false, error: '没找到这段历史的日志文件（列表里的行会随刷新消失）。' })
              return
            }
            send(res, 200, { ok: true, entry: entryName, moved: moved.length, keepDays: TRASH_KEEP_DAYS })
          } catch (error) {
            send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
    }

    // ── 回收站清单 / 恢复 ───────────────────────────────────────────────
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/retro-trash',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', `http://${hostname()}`)
          if (url.pathname !== '/retro-trash') { send(res, 404, { ok: false, error: 'not found' }); return }
          try {
            const root = trashRoot()
            const entries = existsSync(root) ? await readdir(root) : []
            const rows = []
            for (const name of entries) {
              try {
                const st = await stat(join(root, name))
                rows.push({ name, mtime: st.mtimeMs, daysLeft: Math.max(0, TRASH_KEEP_DAYS - Math.floor((Date.now() - st.mtimeMs) / 86400000)) })
              } catch { /* 刚被清掉 */ }
            }
            rows.sort((a, b) => b.mtime - a.mtime)
            send(res, 200, { ok: true, keepDays: TRASH_KEEP_DAYS, entries: rows })
          } catch (error) {
            send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
    }

    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/retro-trash-restore',
        handler: async (req, res) => {
          if (req.method !== 'POST') { send(res, 405, { ok: false, error: '只接受 POST' }); return }
          try {
            const body = await readBody(req)
            const entry = String(body.entry ?? '')
            if (entry === '' || entry.includes('..') || /[\\/]/.test(entry)) {
              send(res, 400, { ok: false, error: 'entry 非法' })
              return
            }
            const from = join(trashRoot(), entry)
            if (!existsSync(from)) { send(res, 404, { ok: false, error: '回收站里没有这一条' }); return }
            const sessionId = safeId(entry.split('_').slice(1).join('_'))
            if (sessionId === undefined) { send(res, 400, { ok: false, error: '条目名里取不出会话 id' }); return }
            let restored = 0
            for (const name of await readdir(from)) {
              if (!name.includes('__')) continue
              const [wsSlug, dirName] = [name.slice(0, name.lastIndexOf('__')), name.slice(name.lastIndexOf('__') + 2)]
              if (dirName !== sessionId) continue
              const target = join(dshHome(), 'sessions', wsSlug, sessionId)
              if (existsSync(target)) continue
              await mkdir(join(dshHome(), 'sessions', wsSlug), { recursive: true })
              await rename(join(from, name), target)
              restored += 1
            }
            const cache = join(from, `${sessionId}.projcache.json`)
            if (existsSync(cache)) {
              const cacheDir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
              await mkdir(cacheDir, { recursive: true })
              await rename(cache, join(cacheDir, `${sessionId}.json`))
            }
            const registry = ctx.get?.('workspaceRegistry')
            try { await registry?.unarchiveSession?.(sessionId) } catch { /* 没归档过就无需恢复 */ }
            send(res, 200, { ok: true, restored })
          } catch (error) {
            send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
    }

    // 回收站目录落地（给排查用；建不出来不影响任何功能）。effect 回调是同步的，这里只用同步 fs。
    try {
      if (!existsSync(trashRoot())) mkdirSync(trashRoot(), { recursive: true })
      appendFileSync(join(trashRoot(), 'README.txt'), `整段历史删除后进这里，保留 ${TRASH_KEEP_DAYS} 天自动清除。\n`)
    } catch { /* 建目录失败就失败 */ }

    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* teardown 尽力而为 */ }
      }
    }
  }, 'dsh-input-tools: 消息撤回 + 历史删除（回收站）')
}
