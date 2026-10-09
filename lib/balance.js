/**
 * dsh-input-tools · 余额端点实现（GET /api/balance）
 *
 * 背景：官方 packages/host/balance 包已退役，余额在插件内实现（零改动化）。
 * 本文件是 XDN 侧的第一份真实实现，替换了 2026-10-04 的占位版。
 *
 * ── 前端契约（lib/client.js 的 BalanceMeter）────────────────────────────
 *   GET /api/balance?sessionId=<id>&provider=<前缀>
 *   -> { balance: { currency, total, granted, toppedUp } | null,
 *        gatewayHealthy: boolean | null,
 *        usage: null }
 *   provider 由前端取模型 store 的 current 前缀（如 deepseek-account / gw）。
 *   前端无 zod 校验，字段名按上面写即可；数值由前端 fmt2 格式化。
 *
 * ── provider 路由表（2026-10-08 扩展）────────────────────────────────
 *   deepseek-account  → 登录账号钱包（platform /api/v0/users/get_user_summary）
 *   deepseek / deepseek-official / llm-deepseek
 *                     → API key 直连（api.deepseek.com/user/balance）
 *   gw                → 网关余额 GET gateway.henry-gao.com/v1/balance（GATEWAY_API_KEY，
 *                       实测 balance_cny/available_balance_cny/spent_cny）+ 健康点保留；
 *                       余额接口挂了时降级为只显健康点（balance=null, gatewayHealthy 有值）
 *   litellm           → 本地 :4000 无 /v1/balance（实测 404），不适用（前端显「不适用」）
 *   workbuddy         → WorkBuddy 桌面积分：读 %LOCALAPPDATA%\CodeBuddyExtension\…\
 *                       workbuddy-desktop.info（明文 JSON auth.accessToken）→ POST
 *                       codebuddy.cn /v2/billing/meter/get-user-resource 取 credits.total。
 *                       走 usage 通道（unit=credits），与 dsh-workbuddy-connect 插件同源口径。
 *   ark / volc-ark    → 预埋：火山 Agent Plan 配额（GetUsageDetails 走控制台签名 API，
 *                       Bearer 直连实测 404，待老大开通套餐后补真实端点再启用）。
 *                       百炼 qwen-token-plan-cn 官方无额度接口 —— 不适用，勿再尝试。
 *   其它               → balance 返回 null（前端隐藏余额指示）
 *
 * ── 两条余额通道的鉴权差异（实测 2026-10-04）─────────────────────────
 *   ① API key：Authorization: Bearer <DEEPSEEK_API_KEY>
 *      返回 balance_infos[0].{currency,total_balance,granted_balance,topped_up_balance}
 *   ② 登录账号：header **x-dsh-auth-token: <token>**（不是 Bearer！用 Bearer 会被
 *      拒成 {"code":40003,"msg":"Authorization Failed (invalid token)"}）
 *      返回 data.biz_data.{normal_wallets,bonus_wallets}[].{currency,balance}
 *      实测两条通道对同一账号给出完全一致的总额，可互相兜底。
 *
 * ── 依赖纪律（血泪）──────────────────────────────────────────────────
 *   本文件只用 node: 内置模块，**禁止引入新 npm 依赖**。
 *   2026-10-04 曾因往 profile 装 @deepseek-ai/dsh-tools 造出第二个 tools 服务，
 *   把桌面客户端整机搞崩；余额是辅助指示，绝不值得冒这个风险。
 *   因此 ~/.dsh/.credentials.yaml 用下面的极简解析读取，不引 js-yaml。
 */

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DeepSeek 官方 API key 余额端点。 */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** LiteLLM 网关健康端点（返回 { ready: boolean }）。 */
const GATEWAY_HEALTH_URL = 'https://gateway.henry-gao.com/health'
/** [2026-10-08] 网关真实余额端点（GET，Bearer GATEWAY_API_KEY；实测字段 balance_cny / available_balance_cny / spent_cny）。 */
const GATEWAY_BALANCE_URL = 'https://gateway.henry-gao.com/v1/balance'
/** [2026-10-08] WorkBuddy 国内计费基址与积分端点（与 dsh-workbuddy-connect 插件同源口径）。 */
const WORKBUDDY_BILLING_BASE = 'https://www.codebuddy.cn'
const WORKBUDDY_CREDITS_PATH = '/v2/billing/meter/get-user-resource'
/** [2026-10-08] CN 刷新端点（chatBase copilot.tencent.com；X-Refresh-Token 头，实测 code=0 且旧 rt 不复用失效——幂等安全）。 */
const WORKBUDDY_REFRESH_URL = 'https://copilot.tencent.com/v2/plugin/auth/token/refresh'
/** WorkBuddy 桌面 App 登录凭据目录（当前文件 5.6 加密信封读不了；退路=同目录带时间戳的历史明文 .info）。 */
const WORKBUDDY_DESKTOP_AUTH_RELATIVE = ['CodeBuddyExtension', 'Data', 'Public', 'auth']
/** 账号平台钱包汇总端点（拼在 grant 的 issuer 后面）。 */
const ACCOUNT_SUMMARY_PATH = '/api/v0/users/get_user_summary'
/** 默认账号平台 origin（issuer 缺失时兜底）。 */
const DEFAULT_ACCOUNT_ORIGIN = 'https://platform.deepseek.com'
/** 余额缓存时长：接口很轻，仅防抖重复轮询。 */
const CACHE_MS = 5_000
/** 单次请求超时。 */
const TIMEOUT_MS = 8_000

/** 走登录账号钱包的 provider 前缀。 */
const ACCOUNT_PROVIDERS = new Set(['deepseek-account', 'deepseek-account-platform'])
/** 走 API key 直连余额的 provider 前缀。 */
const APIKEY_PROVIDERS = new Set(['deepseek', 'deepseek-official', 'llm-deepseek', 'deepseek-api-key'])
/** 走网关健康的 provider 前缀。 */
const GATEWAY_PROVIDERS = new Set(['gw', 'litellm'])
/** [2026-10-08] 显网关真余额的前缀（litellm 本地 :4000 无 /v1/balance，只归 gw）。 */
const GW_BALANCE_PROVIDERS = new Set(['gw'])
/** [2026-10-08] WorkBuddy 积分前缀（dsh-workbuddy-connect 注册的路由名）。 */
const WORKBUDDY_PROVIDERS = new Set(['workbuddy'])
/** [2026-10-08] 预埋：火山 Ark Agent Plan 配额前缀（待真实端点验证后启用）。 */
const ARK_PROVIDERS = new Set(['ark', 'volc-ark'])

/* ── [2026-10-09 老大定稿重做] 余额显示：自动枚举 + 能力表 ─────────────────
 * 🔴 设计变更原因（老大点名）：旧版要用户手打「provider 前缀」和「显示名」，而那个显示名
 *   在输入框余额条上**根本不出现**（label 只画 ¥金额/积分），纯属冗余输入框。
 *   新版：服务商清单从 DSH 模型配置里自动读（前端拿 /optimize-models），本页只负责
 *   「能显示的显示数值、不能显示的写明原因」，用户只做两件事：总开关 + 逐家勾选。
 *
 * 配置文件 ~/.dsh/balance-config.json：
 *   { showBalance: true,             ← 总开关（关=输入框彻底不显示余额）
 *     disabled: ["gw", ...],         ← 被取消勾选的前缀（不在名单里=显示）
 *     overrides: [{ provider, channel, url?, variant?, tokenFile?, keyRef? }]
 *                                   ← 「高级」里手动指定的映射，优先级高于能力表 }
 */
const BALANCE_CONFIG_PATH = () => join(dshHome(), 'balance-config.json')

// 自建积分网关（wb-shim）地址与 token：可用环境变量覆盖，XDN 那种没有它的机器就自然查不到、不报错。
const WB_SHIM_URL = process.env.WB_SHIM_URL || 'http://100.108.133.82:18796'
const WB_SHIM_TOKEN_FILE = process.env.WB_SHIM_TOKEN_FILE || 'C:\\D\\opt\\wb-shim\\token.txt'

/**
 * 能力表：哪家能查、走哪条通道、查不到时**人话原因**写死在这里（单一真源，进 git）。
 * 每条 unsupported 都带实测日期——上游哪天开放了接口，这行就得改，过期一眼可辨。
 * @type {Record<string, {channel?:string, url?:string, variant?:string, tokenFile?:string, keyRef?:string, unsupported?:string}>}
 */
const BALANCE_CAPABILITY = {
  'deepseek-official': { channel: 'ds-apikey' },
  'deepseek-account': { channel: 'ds-account' },
  gw: { channel: 'gw-balance' },
  workbuddy: { channel: 'wb-shim', url: WB_SHIM_URL, tokenFile: WB_SHIM_TOKEN_FILE, variant: 'workbuddy' },
  'workbuddy-ai': { channel: 'wb-shim', url: WB_SHIM_URL, tokenFile: WB_SHIM_TOKEN_FILE, variant: 'workbuddy-ai' },
  'qwen-token-plan-cn': {
    unsupported: '阿里云未开放用量查询接口（2026-10-08 实测：/compatible-mode/v1/usage 带不带模型名全回 400）',
  },
  litellm: {
    unsupported: '本机自建聚合网关，只有一把 master key，没有“余额”这个东西可查',
  },
}

/** 通道枚举（「高级」里手动指定去哪查的下拉用；标签走大白话）。 */
const BALANCE_CHANNELS = [
  { id: 'ds-apikey', label: 'DeepSeek 官方 · 查钱（按 API key）' },
  { id: 'ds-account', label: 'DeepSeek 账号 · 查钱（登录钱包）' },
  { id: 'gw-balance', label: '高网关 · 查钱（元）' },
  { id: 'workbuddy', label: 'WorkBuddy 桌面版 · 查积分' },
  { id: 'ark-plan', label: '火山方舟套餐 · 查额度' },
  { id: 'wb-shim', label: '自建网关 · 查积分（要填地址）' },
  { id: 'none', label: '不显示' },
]

/** 读整份配置文档（坏值/缺文件回落空文档，绝不拖挂快照）。 */
function readBalanceDoc() {
  try {
    const raw = JSON.parse(readFileSync(BALANCE_CONFIG_PATH(), 'utf8'))
    if (Array.isArray(raw?.entries) && !Array.isArray(raw?.disabled)) {
      // 一次性迁移：旧版是 entries[{provider,enabled}]，把取消勾选的搬进 disabled 名单，其余丢弃由能力表接管。
      return {
        showBalance: raw.showBalance !== false,
        disabled: raw.entries.filter((e) => e && e.enabled === false).map((e) => String(e.provider || '')),
        overrides: [],
      }
    }
    return {
      showBalance: raw?.showBalance !== false,
      disabled: Array.isArray(raw?.disabled) ? raw.disabled.map(String) : [],
      overrides: Array.isArray(raw?.overrides) ? raw.overrides : [],
    }
  } catch { /* 无配置/坏 JSON → 全默认（都显示） */ }
  return { showBalance: true, disabled: [], overrides: [] }
}

async function writeBalanceDoc(doc) {
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(dshHome(), { recursive: true })
  await writeFile(BALANCE_CONFIG_PATH(), JSON.stringify({
    showBalance: doc.showBalance !== false,
    disabled: Array.isArray(doc.disabled) ? doc.disabled : [],
    overrides: Array.isArray(doc.overrides) ? doc.overrides : [],
  }, null, 2), 'utf8')
}

/**
 * provider → 该走哪条通道（ overrides 优先，其次能力表）。
 * @param {string} provider 模型 store current 原样（如 "workbuddy/hy3"）或纯前缀
 * @param {object} doc readBalanceDoc() 的结果
 * @returns {{kind:'ok'|'custom'|'unsupported'|'unknown', entry?:object, reason?:string, head:string}}
 */
function resolveBalanceEntry(provider, doc) {
  const head = String(provider || '').split('/')[0]
  if (head === '') return { kind: 'unknown', head }
  const ov = (doc.overrides || []).find((e) => e && typeof e.provider === 'string'
    && (e.provider === provider || e.provider === head))
  if (ov !== undefined) return { kind: 'custom', entry: ov, head }
  const cap = BALANCE_CAPABILITY[provider] ?? BALANCE_CAPABILITY[head]
  if (cap === undefined) {
    return { kind: 'unknown', head, reason: '没登记过这一家：展开下面「高级」手动指定去哪查' }
  }
  if (typeof cap.unsupported === 'string') return { kind: 'unsupported', head, reason: cap.unsupported }
  return { kind: 'ok', entry: { provider: head, ...cap }, head }
}

/**
 * 兜底通道推断：能力表没登记、前端又只给了 provider 时按历史集合走（保持旧行为不断档）。
 * @param {string} provider
 * @returns {string} channel 或 'none'
 */
function inferChannel(provider) {
  const head = provider.split('/')[0]
  if (ACCOUNT_PROVIDERS.has(head)) return 'ds-account'
  if (APIKEY_PROVIDERS.has(head)) return 'ds-apikey'
  if (GW_BALANCE_PROVIDERS.has(head)) return 'gw-balance'
  if (WORKBUDDY_PROVIDERS.has(head)) return 'workbuddy'
  if (ARK_PROVIDERS.has(head)) return 'ark-plan'
  return 'none'
}

/** 解析 DSH 主目录（与服务端其它插件同一套约定）。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 极简读取 ~/.dsh/.credentials.yaml，只认两种稳定结构：
 * 顶格 `refs:` 下两空格缩进的 `KEY: value`，以及 `records:` 下某个具体 grant 块。
 * 结构不符一律返回 undefined，绝不让余额把插件拖挂。
 * @param {string} text - 凭据文件全文。
 * @returns {{ apiKey?: string, accountToken?: string, accountIssuer?: string }}
 */
function pickCredentials(text) {
  const out = {}
  const ref = text.match(/^\s{2}DEEPSEEK_API_KEY:[ \t]*(\S+)[ \t]*$/m)
  if (ref !== null) out.apiKey = ref[1]

  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*deepseek-account-platform\/default:\s*$/.test(line))
  if (start >= 0) {
    const indent = lines[start].search(/\S/)
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '') continue
      const lineIndent = line.search(/\S/)
      if (lineIndent <= indent) break
      const hit = line.match(/^\s*(token|issuer):[ \t]*(\S+)[ \t]*$/)
      if (hit === null) continue
      if (hit[1] === 'token') out.accountToken = hit[2]
      else out.accountIssuer = hit[2]
    }
  }
  return out
}

/** 读凭据文件；任何异常都降级为空对象。 */
async function readCredentials() {
  try {
    return pickCredentials(await readFile(join(dshHome(), '.credentials.yaml'), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 从 .credentials.yaml 顶格 refs: 段取任意 KEY（与 pickCredentials 同款极简解析）。
 * @param {string[]} names - 候选键名，按序取第一个有值的。
 * @returns {Promise<string|undefined>}
 */
async function pickRefKeys(names) {
  try {
    const text = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8')
    for (const name of names) {
      const hit = new RegExp(`^\\s{2}${name}:[ \\t]*(\\S+)[ \\t]*$`, 'm').exec(text)
      if (hit !== null) return hit[1]
    }
  } catch { /* 降级 */ }
  return undefined
}

/**
 * GET 一个 JSON 端点，失败一律返回 undefined（余额是辅助指示，绝不抛给 UI）。
 * @param {string} url - 完整 URL。
 * @param {Record<string,string>} headers - 请求头。
 * @returns {Promise<any>} 解析后的 JSON，或 undefined。
 */
async function fetchJson(url, headers) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/** 金额字符串归一成两位小数；非法值给 '0.00'。 */
function money(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : '0.00'
}

/**
 * 通道①：API key 直连余额。
 * @param {string} apiKey - DEEPSEEK_API_KEY。
 * @returns {Promise<{currency:string,total:string,granted:string,toppedUp:string}|null>}
 */
async function readApiKeyBalance(apiKey) {
  const data = await fetchJson(DEEPSEEK_BALANCE_URL, { authorization: `Bearer ${apiKey}`, accept: 'application/json' })
  const info = data?.balance_infos?.[0]
  if (info === undefined || info === null) return null
  return {
    currency: info.currency,
    total: info.total_balance,
    granted: info.granted_balance,
    toppedUp: info.topped_up_balance,
  }
}

/**
 * 通道②：登录账号钱包汇总。鉴权头是 x-dsh-auth-token（Bearer 会被拒）。
 * 充值钱包(normal) + 赠送钱包(bonus) 合成前端要的 total/granted/toppedUp。
 * @param {string} token - grant 里的账号 token。
 * @param {string|undefined} issuer - grant 里的 origin。
 * @returns {Promise<{currency:string,total:string,granted:string,toppedUp:string}|null>}
 */
async function readAccountBalance(token, issuer) {
  const origin = typeof issuer === 'string' && /^https?:\/\//.test(issuer)
    ? issuer.replace(/\/+$/, '')
    : DEFAULT_ACCOUNT_ORIGIN
  const data = await fetchJson(origin + ACCOUNT_SUMMARY_PATH, {
    'x-dsh-auth-token': token,
    'x-client-bundle-id': '',
    'x-client-platform': 'desktop-win',
    'x-client-version': '0.2.0',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    accept: 'application/json',
  })
  const biz = data?.data?.biz_data
  const normal = biz?.normal_wallets?.[0]
  const bonus = biz?.bonus_wallets?.[0]
  if (normal === undefined && bonus === undefined) return null
  const toppedUp = Number(normal?.balance ?? 0)
  const granted = Number(bonus?.balance ?? 0)
  return {
    currency: normal?.currency ?? bonus?.currency ?? 'CNY',
    total: money(toppedUp + granted),
    granted: money(granted),
    toppedUp: money(toppedUp),
  }
}

/**
 * 通道③：网关健康。
 * @returns {Promise<boolean|null>}
 */
async function readGatewayHealth() {
  const data = await fetchJson(GATEWAY_HEALTH_URL, { accept: 'application/json' })
  return typeof data?.ready === 'boolean' ? data.ready : null
}

/**
 * 通道④ [2026-10-08]：网关真实余额（gw provider）。
 * GET gateway.henry-gao.com/v1/balance，Bearer GATEWAY_API_KEY。
 * 实测返回 balance_cny / available_balance_cny / spent_cny（字符串小数）。
 * @param {string|undefined} key - GATEWAY_API_KEY。
 * @returns {Promise<{currency:string,total:string,granted:string,toppedUp:string}|null>}
 */
async function readGwBalance(key) {
  if (key === undefined || key === '') return null
  const data = await fetchJson(GATEWAY_BALANCE_URL, { authorization: `Bearer ${key}`, accept: 'application/json' })
  const avail = Number(data?.available_balance_cny ?? data?.balance_cny)
  if (!Number.isFinite(avail)) return null
  const spent = Number(data?.spent_cny)
  // [2026-10-08] 顺带透出 token 计量字段（实测 used_tokens 有值，quota 为 null=不限量套餐）
  const usedTokens = Number(data?.used_tokens)
  return {
    currency: 'CNY',
    total: money(avail),
    granted: '0.00',
    toppedUp: Number.isFinite(spent) ? money(avail + spent) : money(avail),
    ...(Number.isFinite(usedTokens) ? { usedTokens } : {}),
    ...(Number.isFinite(Number(data?.quota_tokens)) && Number(data?.quota_tokens) > 0 ? { quotaTokens: Number(data.quota_tokens) } : {}),
  }
}

/**
 * 通道⑤ [2026-10-08]：WorkBuddy 桌面积分余量。
 *
 * 🔴 凭据来源实测结论（别改回去）：当前 workbuddy-desktop.info 的 accessToken/refreshToken
 * 是 5.6 **加密信封**（$wbEncrypted，解密要起 WorkBuddy Electron 取 at-rest key，宿主里做不了）。
 * 可行姿势 = 同目录带时间戳的历史明文 .info 文件里最新的 refreshToken → POST token/refresh
 * 换新 accessToken（实测 code=0；旧 refreshToken 可重复使用，刷新幂等安全）→ POST 计费端点。
 * refreshToken 本身约 90 天有效；失效时本函数返回 null，前端隐藏指示，绝不出错数。
 * 口径对齐 dsh-workbuddy-connect 插件 fetchCredits（CycleCapacityRemain 优先）。
 * @returns {Promise<{unit:string,total:number,detail:Array}|null>}
 */
async function readWorkbuddyCredits() {
  try {
    const home = process.env.USERPROFILE ?? homedir()
    const dirs = [
      join(home, 'AppData', 'Local', ...WORKBUDDY_DESKTOP_AUTH_RELATIVE),
      join(home, 'AppData', 'Roaming', ...WORKBUDDY_DESKTOP_AUTH_RELATIVE),
    ]
    // ① 收集候选 refreshToken：历史明文 .info（按 mtime 新→旧）+ 插件自有明文副本
    const candidates = []
    for (const dir of dirs) {
      let entries = []
      try { entries = await readdir(dir) } catch { continue }
      const dated = entries
        .filter((n) => n.startsWith('workbuddy-desktop.') && n.endsWith('.info'))
        .sort()
        .reverse()
      for (const name of dated) {
        try {
          const doc = JSON.parse(await readFile(join(dir, name), 'utf8'))
          const rt = doc?.auth?.refreshToken
          if (typeof rt === 'string' && rt !== '') { candidates.push({ refreshToken: rt, uid: String(doc?.account?.uid ?? ''), domain: String(doc?.auth?.domain ?? '') }); break }
        } catch { /* 下一个 */ }
      }
    }
    try {
      const own = JSON.parse(await readFile(join(dshHome(), '.workbuddy-auth.json'), 'utf8'))
      const c = own?.credential
      if (typeof c?.refreshToken === 'string' && c.refreshToken !== '') candidates.unshift({ refreshToken: c.refreshToken, uid: String(c.uid ?? ''), domain: String(c.domain ?? '') })
    } catch { /* 无自有副本 */ }
    if (candidates.length === 0) return null
    // ② refreshToken → 新 accessToken（任一候选成功即止）
    let accessToken
    let uid = ''
    let domain = ''
    for (const cand of candidates) {
      try {
        const response = await fetch(WORKBUDDY_REFRESH_URL, {
          method: 'POST',
          headers: {
            'x-refresh-token': cand.refreshToken,
            'x-auth-refresh-source': 'workbuddy',
            'x-requested-with': 'XMLHttpRequest',
            origin: 'https://copilot.tencent.com',
            referer: 'https://copilot.tencent.com/',
            'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!response.ok) continue
        const env = await response.json()
        if (env?.code !== 0 || typeof env?.data?.accessToken !== 'string') continue
        accessToken = env.data.accessToken
        uid = cand.uid
        domain = typeof env.data.domain === 'string' && env.data.domain !== '' ? env.data.domain : cand.domain
        break
      } catch { /* 下一个候选 */ }
    }
    if (accessToken === undefined) return null
    // ③ POST 计费端点聚合各资源包剩余（与插件 fetchCredits 同款字段口径）
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const response = await fetch(`${WORKBUDDY_BILLING_BASE}${WORKBUDDY_CREDITS_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
        ...(uid !== '' ? { 'x-user-id': uid } : {}),
        ...(domain !== '' ? { 'x-domain': domain } : {}),
      },
      body: JSON.stringify({
        PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6)),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const envelope = await response.json()
    if (envelope?.code !== 0) return null
    const inner = envelope?.data?.Response?.Data
    const accounts = Array.isArray(inner?.Accounts) ? inner.Accounts : []
    let total = 0
    const detail = []
    for (const a of accounts) {
      const num = (k) => (typeof a[k] === 'number' ? a[k] : 0)
      const size = num('CycleCapacitySize')
      let remain
      if (size > 0 || num('CycleCapacityRemain') > 0 || num('CycleCapacityUsed') > 0) remain = num('CycleCapacityRemain')
      else remain = num('CapacityRemain')
      if (remain < 0) remain = 0
      total += remain
      if (remain > 0) detail.push({ name: typeof a.PackageName === 'string' ? a.PackageName : '(unnamed)', remain, size: size > 0 ? size : num('CapacitySize') })
    }
    if (accounts.length === 0) return null
    return { unit: 'credits', total, detail }
  } catch {
    return null
  }
}

/**
 * 通道⑥ [2026-10-08]：火山 Ark Agent Plan 套餐配额（实测 HTTP 200 通）。
 * 姿势抄官方 packages/host/balance/lib/index.js readArkUsage()：控制台签名 API
 * HMAC-SHA256，POST ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01，
 * AK/SK 用 credentials.yaml refs 的 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY。
 * ⚠️ Bearer ARK_API_KEY 直连 ark.cn-beijing.volces.com/api/v3/usage* 实测全 404，别走那条。
 * Quota 全 0 = 该账号没买套餐 → 返回 null（前端「不适用」），不画假 0%。
 * @param {string|undefined} accessKeyId - VOLC_ACCESS_KEY_ID。
 * @param {string|undefined} secretAccessKey - VOLC_SECRET_ACCESS_KEY。
 * @returns {Promise<{planType:string,periods:Array}|null>}
 */
async function readArkUsage(accessKeyId, secretAccessKey) {
  if (accessKeyId === undefined || secretAccessKey === undefined) return null
  try {
    const HOST = 'ark.cn-beijing.volcengineapi.com'
    const REGION = 'cn-beijing'
    const SERVICE = 'ark'
    const xdate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/, '$1$2$3T$4$5$6Z')
    const query = 'Action=GetAFPUsage&Version=2024-01-01'
    const body = '{}'
    const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex')
    const signedHeaders = ['host', 'x-content-sha256', 'x-date']
    const canonicalRequest = ['POST', '/', query, [`host:${HOST}\n`, `x-content-sha256:${payloadHash}\n`, `x-date:${xdate}\n`].sort().join(''), signedHeaders.join(';'), payloadHash].join('\n')
    const scope = `${xdate.slice(0, 8)}/${REGION}/${SERVICE}/request`
    const stringToSign = ['HMAC-SHA256', xdate, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n')
    const signature = createHmac('sha256', createHmac('sha256', createHmac('sha256', createHmac('sha256', createHmac('sha256', secretAccessKey).update(xdate.slice(0, 8), 'utf8').digest()).update(REGION, 'utf8').digest()).update(SERVICE, 'utf8').digest()).update('request', 'utf8').digest()).update(stringToSign, 'utf8').digest('hex')
    const response = await fetch(`https://${HOST}/?${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-date': xdate,
        'x-content-sha256': payloadHash,
        authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const result = (await response.json())?.Result
    if (result === undefined || result === null) return null
    const periodView = (label, p) => (p === undefined || !(Number(p.Quota) > 0) ? null : { label, quota: Number(p.Quota), used: Number(p.Used ?? 0), resetAt: Number(p.ResetTime) ?? 0 })
    const periods = [periodView('5h', result.AFPFiveHour), periodView('weekly', result.AFPWeekly), periodView('monthly', result.AFPMonthly)].filter((p) => p !== null)
    if (periods.length === 0) return null
    return { planType: result.PlanType ?? '', periods }
  } catch {
    return null
  }
}

/**
 * 通道⑦ [2026-10-08]：wb-shim WorkBuddy 模型网关积分。
 * GET <url>/v1/credits，Bearer key。key 来源优先级：entry.keyRef(credentials.yaml refs)
 *   > entry.tokenFile（如 C:\D\opt\wb-shim\token.txt）> url 同目录 token.txt。
 * 实测返回 { workbuddy:{total,unlimited,accounts:[{packageName,remain,size}]}, ... }
 * （国内版；国际版键名以实际为准，全部数值键聚合成 detail）。
 * @param {object} entry - 配置条目 {url, keyRef?, tokenFile?}。
 * @returns {Promise<{unit:string,total:number,detail:Array}|null>}
 */
async function readWbShimCredits(entry) {
  try {
    const base = typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : ''
    if (base === '' || !/^https?:\/\//.test(base)) return null
    let key
    if (typeof entry.keyRef === 'string' && entry.keyRef !== '') {
      key = await pickRefKeys([entry.keyRef])
    }
    if (key === undefined || key === '') {
      const candidates = []
      if (typeof entry.tokenFile === 'string' && entry.tokenFile !== '') candidates.push(entry.tokenFile)
      try { candidates.push(new URL('/token.txt', base + '/').pathname) } catch { /* 非法 url 忽略 */ }
      for (const p of candidates) {
        try {
          const t = (await readFile(p, 'utf8')).trim()
          if (t !== '') { key = t; break }
        } catch { /* 下一个 */ }
      }
    }
    if (key === undefined || key === '') return null
    const data = await fetchJson(`${base}/v1/credits`, { authorization: `Bearer ${key}`, accept: 'application/json' })
    if (data === undefined || data === null) return null
    // 聚合：顶层每个变体键（workbuddy / workbuddy-ai / …）取 total；
    // accounts 明细按套餐名聚合（51 个包同名合并，防 title 爆炸——同 wb-shim 看板口径）。
    // [2026-10-08 老大点名"国内版国际版显示同一个数"] 原来这里不分变体全加在一起 ⇒ 两条配置读到同一总数。
    // 现在按 entry.variant 只取那一家；没填 variant 才退回"全部相加"的老行为。
    const want = typeof entry.variant === 'string' ? entry.variant.trim() : ''
    let total = 0
    const detail = []
    for (const [variant, v] of Object.entries(data)) {
      if (v === null || typeof v !== 'object') continue
      if (want !== '' && variant !== want) continue
      const t = Number(v.total)
      if (Number.isFinite(t) && t > 0) {
        total += t
        const agg = new Map()
        for (const a of Array.isArray(v.accounts) ? v.accounts : []) {
          const remain = Number(a?.remain)
          const size = Number(a?.size)
          if (!Number.isFinite(remain) || remain <= 0) continue
          const name = typeof a?.packageName === 'string' && a.packageName !== '' ? a.packageName : '(包)'
          const cur = agg.get(name) ?? { remain: 0, size: 0 }
          cur.remain += remain
          cur.size += Number.isFinite(size) && size > 0 ? size : 0
          agg.set(name, cur)
        }
        if (agg.size === 0) detail.push({ name: variant, remain: t, size: 0 })
        else for (const [name, cur] of agg) detail.push({ name: `${variant}·${name}`, remain: cur.remain, size: cur.size })
      }
    }
    if (total <= 0 && detail.length === 0) return null
    return { unit: 'credits', total, detail }
  } catch {
    return null
  }
}

/**
 * 注册 GET /api/balance。
 *
 * 路由用 kind:'exact' —— webserver 先查 exact 表再查 prefix 表，而 /api 是核心 RPC
 * 桥的 prefix 地盘；用 exact 才能保证 /api/balance 不被它抢走。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host 上下文（inject 已含 webServer）。
 */
export function applyBalance(ctx) {
  /** 最近一次结果，按 provider 分键缓存。 */
  const cache = new Map()

  /**
   * 按通道取一份余额快照（channel 由设置页配置决定，见 matchBalanceEntry）。
   * @param {string} channel - ds-apikey|ds-account|gw-balance|workbuddy|ark-plan|wb-shim|none
   * @param {object|string} entryOrProvider - 配置条目；旧调用兼容传 provider 字符串。
   * @param {object} creds - 预读的凭据包。
   * @returns {Promise<{ balance: object|null, usage: object|null }>}
   */
  async function snapshotChannel(channel, entryOrProvider, creds) {
    const entry = typeof entryOrProvider === 'object' && entryOrProvider !== null ? entryOrProvider : {}
    let balance = null
    let usage = null
    let reason = ''
    if (channel === 'ds-account') {
      // [2026-10-08 老大点名"报错不解释"] 失败必须说人话：这台机器压根没登录过 DeepSeek 账号，
      // 不是网络问题，是这条配置对你无用 —— 直接建议删掉，别让人对着一个干巴巴的失败猜。
      if (creds.accountToken === undefined) {
        reason = '这台机器没登录过 DeepSeek 账号（凭据里没有那条授权记录），这条用不上，删掉即可'
      } else {
        balance = await readAccountBalance(creds.accountToken, creds.accountIssuer)
        if (balance === null) reason = '已登录，但 DeepSeek 账号钱包没返回数据（登录态可能过期，去官网重新登录一次）'
      }
    } else if (channel === 'ds-apikey') {
      const key = creds.apiKey ?? process.env.DEEPSEEK_API_KEY
      if (key === undefined || key === '') reason = '没找到 DeepSeek 的 API key（凭据文件 DEEPSEEK_API_KEY 与环境变量都没有）'
      else {
        balance = await readApiKeyBalance(key)
        if (balance === null) reason = '有 key，但 DeepSeek 官方没返回余额（key 失效或网络不通）'
      }
    } else if (channel === 'gw-balance') {
      // [2026-10-08] gw：显网关真余额（¥），健康点照旧；余额挂了降级只显点。
      const key = creds.gatewayKey ?? process.env.GATEWAY_API_KEY
      if (key === undefined || key === '') reason = '没找到高网关的 key（凭据 GATEWAY_API_KEY 缺失）'
      else {
        balance = await readGwBalance(key)
        if (balance === null) reason = '高网关没返回余额（网关没响应，或它自己的上游断了）'
      }
    } else if (channel === 'workbuddy') {
      // [2026-10-08] workbuddy：积分余量走 usage 通道（unit=credits，非 ¥ 余额）。
      usage = await readWorkbuddyCredits()
      if (usage === null) reason = '本机 WorkBuddy 桌面版没读到积分（它没在跑，或积分文件不可读）'
    } else if (channel === 'ark-plan') {
      usage = await readArkUsage(creds.volcAk, creds.volcSk)
      if (usage === null) reason = '方舟套餐额度查不到：没买到 Token Plan 套餐，或火山 AK/SK 缺失'
    } else if (channel === 'wb-shim') {
      // [2026-10-08] wb-shim：查自家模型网关的 WorkBuddy 积分（GET <url>/v1/credits）。
      if (typeof entry.url !== 'string' || entry.url.trim() === '') reason = '没填网关地址（这条要填 http://ip:port）'
      else {
        usage = await readWbShimCredits(entry)
        if (usage === null) reason = entry.variant ? `网关没返回「${entry.variant}」这一家的积分（地址不通、token 不对，或这个变体不存在）` : '自建网关没返回积分（地址不通或 token 不对）'
      }
    } else {
      reason = '这条没选查询方式'
    }
    return { balance, usage, reason }
  }

  /**
   * 按 provider 取一份余额快照。
   * @param {string} provider - 前端传来的 provider 前缀。
   * @returns {Promise<{ balance: object|null, gatewayHealthy: boolean|null, usage: object|null }>}
   */
  async function snapshot(provider) {
    const now = Date.now()
    const hit = cache.get(provider)
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.value

    // [2026-10-09 重做] 通道来自能力表/高级覆盖（resolveBalanceEntry），每次重读文件 ⇒ 保存即生效。
    const doc = readBalanceDoc()
    const resolved = resolveBalanceEntry(provider, doc)
    // 三级隐身：总开关关掉 / 这家被取消勾选 / 压根不支持或没登记 ⇒ 输入框连占位都不画。
    if (!doc.showBalance || doc.disabled.includes(resolved.head)
      || resolved.kind === 'unsupported' || resolved.kind === 'unknown') {
      const value = { balance: null, gatewayHealthy: null, usage: null, hidden: true }
      cache.set(provider, { at: now, value })
      return value
    }
    const entry = resolved.entry
    const channel = typeof entry.channel === 'string' && entry.channel !== '' ? entry.channel : inferChannel(provider)
    if (channel === 'none') return { balance: null, gatewayHealthy: null, usage: null, hidden: true }

    const creds = await readCredentials()
    // [2026-10-08] gw/ark 分支需要 refs 里的额外密钥（GATEWAY_API_KEY / VOLC AK·SK）。
    if (channel === 'gw-balance') {
      creds.gatewayKey = await pickRefKeys(['GATEWAY_API_KEY'])
    } else if (channel === 'ark-plan') {
      ;[creds.volcAk, creds.volcSk] = await Promise.all([pickRefKeys(['VOLC_ACCESS_KEY_ID']), pickRefKeys(['VOLC_SECRET_ACCESS_KEY'])])
    }
    let balance = null
    let usage = null
    if (provider === '') {
      // 前端没给出 provider：API key 优先，其次登录账号，两条通道对同一账号结果一致。
      const key = creds.apiKey ?? process.env.DEEPSEEK_API_KEY
      if (key !== undefined && key !== '') balance = await readApiKeyBalance(key)
      if (balance === null && creds.accountToken !== undefined) {
        balance = await readAccountBalance(creds.accountToken, creds.accountIssuer)
      }
    } else {
      ;({ balance, usage } = await snapshotChannel(channel, entry, creds))
    }

    const gatewayHealthy = GATEWAY_PROVIDERS.has(provider) || channel === 'gw-balance' ? await readGatewayHealth() : null
    const value = { balance, gatewayHealthy, usage }
    cache.set(provider, { at: now, value })
    return value
  }

  /* ── [2026-10-08] GET/POST /balance-config：设置页「余额显示」读写口 ──────────
   * GET  -> { ok, entries, channels }（tokenFile/keyRef 只回路径与键名，永不回 key 值）
   * POST -> body { entries }；保存即生效（snapshot 每次重读文件）。
   * POST /balance-config/test { entry } -> 按该条配置现场取一次数（不落盘），供「测试」按钮。 */

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  async function readBody(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
  }

  ctx.effect(() => {
    if (typeof ctx.webServer?.register !== 'function') return undefined
    const disposers = []
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/balance-config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const doc = readBalanceDoc()
            return sendJson(res, 200, {
              ok: true, showBalance: doc.showBalance, disabled: doc.disabled, overrides: doc.overrides,
              channels: BALANCE_CHANNELS, capability: BALANCE_CAPABILITY,
            })
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            // 白名单落盘：只留认识的字段，防前端把 key 值之类的脏东西写进配置。
            const cleanOverrides = (Array.isArray(body?.overrides) ? body.overrides : [])
              .filter((e) => e && typeof e.provider === 'string' && e.provider.trim() !== '')
              .map((e) => {
                const out = {
                  provider: String(e.provider).trim().slice(0, 80),
                  channel: BALANCE_CHANNELS.some((c) => c.id === e.channel) ? e.channel : 'none',
                }
                if (typeof e.url === 'string' && e.url.trim() !== '') out.url = e.url.trim().slice(0, 200)
                if (typeof e.keyRef === 'string' && e.keyRef.trim() !== '') out.keyRef = e.keyRef.trim().slice(0, 60)
                if (typeof e.tokenFile === 'string' && e.tokenFile.trim() !== '') out.tokenFile = e.tokenFile.trim().slice(0, 260)
                if (typeof e.variant === 'string' && e.variant.trim() !== '') out.variant = e.variant.trim().slice(0, 40)
                return out
              })
            const doc = {
              showBalance: body?.showBalance !== false,
              disabled: (Array.isArray(body?.disabled) ? body.disabled : []).map((x) => String(x).slice(0, 80)),
              overrides: cleanOverrides,
            }
            await writeBalanceDoc(doc)
            cache.clear()
            return sendJson(res, 200, { ok: true, ...readBalanceDoc() })
          }
          return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/balance-config/test',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          const body = await readBody(req)
          // [2026-10-09 重做] 前端只报 provider，通道由 host 侧能力表/高级覆盖决定 —— 页面不再传黑话。
          // draft：「高级」编辑器里还没保存的临时映射，允许就地试查。
          const doc = readBalanceDoc()
          let entry = null
          if (body?.draft && typeof body.draft === 'object') entry = { ...body.draft }
          else {
            const resolved = resolveBalanceEntry(String(body?.provider ?? ''), doc)
            if (resolved.kind === 'unsupported' || resolved.kind === 'unknown') {
              return sendJson(res, 200, { ok: false, balance: null, usage: null, error: resolved.reason || '这家不支持查余额' })
            }
            entry = resolved.entry
          }
          if (!entry || typeof entry.channel !== 'string') return sendJson(res, 200, { ok: false, error: '没定出查询方式' })
          const creds = await readCredentials()
          if (entry.channel === 'gw-balance') {
            creds.gatewayKey = await pickRefKeys(['GATEWAY_API_KEY'])
          } else if (entry.channel === 'ark-plan') {
            ;[creds.volcAk, creds.volcSk] = await Promise.all([pickRefKeys(['VOLC_ACCESS_KEY_ID']), pickRefKeys(['VOLC_SECRET_ACCESS_KEY'])])
          }
          const { balance, usage, reason } = await snapshotChannel(entry.channel, entry, creds)
          const ok = balance !== null || usage !== null
          // [2026-10-08 老大点名"报错不解释"] 失败一定带人话原因；成功也回一份当前值供页面直接显示。
          return sendJson(res, 200, { ok, balance, usage, error: ok ? '' : (reason || '没查到数据') })
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      },
    }))
    return () => { for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } } }
  }, 'dsh-balance-config')

  ctx.effect(() => {
    if (typeof ctx.webServer?.register !== 'function') return undefined
    return ctx.webServer.register({
      kind: 'exact',
      path: '/api/balance',
      handler: async (req, res) => {
        const write = (status, payload) => {
          const body = JSON.stringify(payload)
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          res.end(body)
        }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const provider = (url.searchParams.get('provider') ?? '').trim()
          const { balance, gatewayHealthy, usage, hidden } = await snapshot(provider)
          write(200, { ok: true, balance, gatewayHealthy, usage: usage ?? null, hidden: hidden === true })
        } catch (error) {
          write(200, { ok: false, balance: null, gatewayHealthy: null, usage: null,
            error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }, 'dsh-balance')
}
