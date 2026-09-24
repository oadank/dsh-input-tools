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
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

/**
 * 该会话日志里最后一条 system/message 的 turn/step（作废事件复用同一坐标，避免造出乱序坐标）。
 * @param session - 实时 Session。
 * @returns {turn, step}。
 */
function lastSystemCoords(session) {
  let turn = 0
  let step = 0
  try {
    for (const event of session.ownEvents?.() ?? []) {
      if (event.type === 'system/message') {
        turn = Number(event.data?.turn) || turn
        step = Number(event.data?.step) || step
      }
    }
  } catch { /* 读不到就用 0/0，append 会自己校验 */ }
  return { turn, step }
}

/**
 * 扫日志找出全部作废标记（空内容 system/message 且 replace 覆盖单点）。
 * @param session - 实时 Session。
 * @returns 被作废的 seq 数组。
 */
function deletedSeqsOf(session) {
  const out = []
  try {
    for (const event of session.ownEvents?.() ?? []) {
      if (event.type !== 'system/message') continue
      const op = event.surfaceOp
      if (!op || op === 'append' || typeof op !== 'object') continue
      if (op.op !== 'replace' || op.startSeq !== op.endSeq) continue
      const content = event.data?.message?.content
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
            const seq = safeSeq(body.seq)
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
            if (seq === undefined) { send(res, 400, { ok: false, error: 'seq 非法' }); return }
            const event = session.eventAt?.(seq)
            if (event === undefined) {
              send(res, 404, { ok: false, reason: 'not-found', error: '这条消息不在这段会话里（可能翻页还没加载）。' })
              return
            }
            if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') {
              send(res, 400, { ok: false, error: '只能撤回自己发出的消息。' })
              return
            }
            const already = deletedSeqsOf(session).includes(seq)
            const nodes = session.surface?.nodes ?? []
            const inSurface = nodes.includes(seq)
            if (!already && inSurface) {
              const { turn, step } = lastSystemCoords(session)
              // 空内容 system/message 被折叠成「零条消息」：模型侧彻底消失
              session.append('system/message', {
                turn,
                step,
                message: { role: 'system', content: [] },
              }, {
                surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
                sourceEventSeqs: [seq],
              })
              const store = ctx.get?.('sessions') ?? ctx.sessions
              try { await store?.flush?.(session) } catch { /* 落盘由会话自己收尾 */ }
              send(res, 200, { ok: true, mode: 'tombstone', seq, stopped })
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
          const seq = safeSeq(url.searchParams.get('seq'))
          const messageId = safeId(url.searchParams.get('messageId'))
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
          if (seq === undefined) { send(res, 200, { ok: true, stage: 'unknown' }); return }
          const nodes = session.surface?.nodes ?? []
          if (!nodes.includes(seq)) {
            send(res, 200, { ok: true, stage: deletedSeqsOf(session).includes(seq) ? 'retracted' : 'compacted' })
            return
          }
          send(res, 200, { ok: true, stage: agent?.status === 'running' ? 'running' : 'done' })
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
          if (session === undefined) { send(res, 200, { ok: true, seqs: [], open: false }); return }
          send(res, 200, { ok: true, seqs: deletedSeqsOf(session), open: true })
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
