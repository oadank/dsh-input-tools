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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
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
// [2026-10-23] https 改造后 100.108.133.82:18796 只接受 TLS（tailscale serve 抢占监听），
// 明文 http 全 400。默认改 ts.net 域名（公信证书，本机/XDN 通用，无需配 CA）；
// 本机想走回环快路可设环境变量 WB_SHIM_URL=http://127.0.0.1:18796
const WB_SHIM_URL = process.env.WB_SHIM_URL || 'https://lecoo.tailb5f10f.ts.net:18796'
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
  // [2026-10-19 老大点名] 老大在「设置→模型配置」里起的三个自建服务商，地址全指向同一个 wb-shim，
  // 只是背后的 WorkBuddy 账号不同 ⇒ 只填地址+服务商，账号由当前模型名自动判（见 resolveWbVariant）。
  // ⚠️ 不要在这里写死 variant：写死会让 lecoo 下所有模型都读同一本账。
  lecoo: { channel: 'wb-shim', url: WB_SHIM_URL, tokenFile: WB_SHIM_TOKEN_FILE },
  'lecoo-intl': { channel: 'wb-shim', url: WB_SHIM_URL, tokenFile: WB_SHIM_TOKEN_FILE },
  n5105: { channel: 'wb-shim', url: WB_SHIM_URL, tokenFile: WB_SHIM_TOKEN_FILE },
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

/* ── [2026-10-19 老大点名] 同一个自建网关挂多个账号（LeCoo 国内 / LeCoo 国际 / N5105）──
 * 背景：老大在「设置→模型配置」里加了 lecoo、lecoo-intl、n5105 三个服务商，
 * 它们的地址全是同一个 wb-shim，只是模型不同 ⇒ 余额必须按**模型**分账，不能按服务商。
 * 账本（真源=wb-shim，`rtLabel` 决定 /v1/credits 的键）：
 *   LeCoo 国内 → workbuddy      LeCoo 国际 → workbuddy-ai      N5105 小主机 → workbuddy-deb
 * 判定顺序：① 模型名后缀（-deb / -intl，最稳，读配置即得）
 *           ② MARKER_FAMILIES：该账号独有、不带后缀的模型（实例：n5105 的 hy4-preview 在国内版目录里没有）
 *           ③ 动态反查：问网关 `/v1/models` 的 owned_by（`workbuddy/<账号>`），插件不写死清单
 *           ④ 全落空 → 取该网关默认账号（不带专用 token 时 = workbuddy 国内版） */
const WB_DEBIAN_VARIANT = 'workbuddy-deb'
/** 账号独有模型指纹：键=账号，值=只在该账号目录里存在的模型 id（不含后缀）。 */
const WB_MARKER_FAMILIES = {
  [WB_DEBIAN_VARIANT]: ['hy4-preview'],
}
/** provider → 账号覆盖（能力表/高级配置没写 variant 时兜底；老大点名的三个服务商）。 */
const WB_PROVIDER_VARIANT = {
  lecoo: 'workbuddy',
  'lecoo-intl': 'workbuddy-ai',
  n5105: WB_DEBIAN_VARIANT,
}

/** 该网关认得的账号名（/v1/credits 的顶层键）；失败回落已知三个。 */
async function wbShimVariants(base, key) {
  const known = ['workbuddy', 'workbuddy-ai', WB_DEBIAN_VARIANT]
  try {
    const d = await fetchJson(`${base}/v1/credits`, { authorization: `Bearer ${key}`, accept: 'application/json' })
    const keys = d && typeof d === 'object' ? Object.keys(d).filter((k) => k !== '' && !k.startsWith('_')) : []
    return keys.length > 0 ? keys : known
  } catch { return known }
}

/** 摘掉账号后缀，得到上游真模型名（`hy3-intl` → `hy3`，`hy4-preview` → `hy4-preview`）。 */
function stripVariantSuffix(modelId, variants) {
  const id = String(modelId ?? '').trim()
  if (id === '') return id
  let best = ''
  for (const v of variants) {
    const suffix = v === 'workbuddy' ? '-intl' : `-${v.replace(/^workbuddy-?/, '')}`
    if (suffix !== '-' && id.endsWith(suffix) && suffix.length > best.length) best = suffix
  }
  return best === '' ? id : id.slice(0, -best.length)
}

/** 模型名里的账号后缀（`-intl` / `-deb`）→ 账号键。注意：wb-shim 给国际版模型加的是
 * `-intl` 后缀，而国际版账号键叫 `workbuddy-ai`，两者不一样，这里显式对表，不猜。 */
function variantFromModelSuffix(modelId, variants) {
  const id = String(modelId ?? '').trim()
  const m = /-(intl|deb)$/.exec(id)
  if (m) return ({ intl: 'workbuddy-ai', deb: WB_DEBIAN_VARIANT })[m[1]]
  return ''
}

/** ③ 动态反查：网关自报某模型归哪个账号（owned_by=workbuddy/<账本>）。 */
async function variantFromGatewayCatalog(base, key, modelId) {
  try {
    const d = await fetchJson(`${base}/v1/models`, { authorization: `Bearer ${key}`, accept: 'application/json' })
    const row = Array.isArray(d?.data) ? d.data.find((m) => String(m?.id ?? '') === String(modelId)) : undefined
    const owner = typeof row?.owned_by === 'string' ? row.owned_by.split('/').pop() ?? '' : ''
    return /^workbuddy/.test(owner) ? owner : ''
  } catch { return '' }
}

/**
 * 决定一个（服务商, 模型）该查哪个账号的积分。
 * @param {object} entry - wb-shim 配置条目（可能带 variant）。
 * @param {string} provider - 服务商前缀，如 lecoo-intl。
 * @param {string} model - 当前模型 id，如 hy3-intl、hy4-preview。
 * @param {{base:string,key:string}} cred - 已解析的网关地址与 token。
 */
async function resolveWbVariant(entry, provider, model, cred) {
  const manual = typeof entry.variant === 'string' && entry.variant.trim() !== '' ? entry.variant.trim() : ''
  if (manual !== '') return { variant: manual, how: '手动指定' }
  // [2026-10-19 修序] 老大建三个服务商就是为了选账号 ⇒ 服务商名单优先（lecoo/lecoo-intl/n5105
  // 各对应一本账）；模型名后缀只在这张表没覆盖时兜底。之前模型后缀优先，hy3-intl 被判成国内账。
  const byProvider = WB_PROVIDER_VARIANT[String(provider ?? '').split('/')[0]]
  if (byProvider !== undefined) return { variant: byProvider, how: '服务商名单' }
  const variants = await wbShimVariants(cred.base, cred.key)
  const id = String(model ?? '').trim()
  if (id !== '') {
    const bySuffix = variantFromModelSuffix(id, variants)
    if (bySuffix !== '') return { variant: bySuffix, how: '模型名后缀' }
    const bare = stripVariantSuffix(id, variants)
    for (const [v, ids] of Object.entries(WB_MARKER_FAMILIES)) {
      if (ids.includes(bare)) return { variant: v, how: `独有模型 ${bare}` }
    }
    const byCatalog = await variantFromGatewayCatalog(cred.base, cred.key, id)
    if (byCatalog !== '') return { variant: byCatalog, how: '网关模型目录' }
  }
  return { variant: 'workbuddy', how: '网关默认账号' }
}

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

/** 金额字符串归一成两位小数；非法值给 '0.00'。
 *  🔴 [2026-10-23 老大实锤] 余额**不能四舍五入**：官方原始值 88.29816262，
 *  用 toFixed(2) 得 88.30，比真实多 0.01（老大早就发现，今晚实锤）。
 *  余额一律向下截断到分——宁可少报一分，不能多报一分。 */
function money(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0.00'
  const truncated = n >= 0 ? Math.floor(n * 100) / 100 : Math.ceil(n * 100) / 100
  return truncated.toFixed(2)
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
/**
 * [2026-10-15 workbuddy] wb-shim 通道的 key 解析（从 readWbShimCredits 抽出共用）。
 * key 来源优先级：entry.keyRef(credentials.yaml refs) > entry.tokenFile > url 同目录 token.txt。
 * @param {object} entry - 配置条目 {keyRef?, tokenFile?}。
 * @param {string} base - 归一后的网关地址。
 * @returns {Promise<string|undefined>}
 */
async function resolveWbShimKey(entry, base) {
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
        // [2026-10-20] token.txt 支持「名字|token」多行格式（wb-shim 三钥匙分账号）。
        // 取第一行的 token 部分；没有 | 就整行当 token（老格式兼容）。
        const first = (await readFile(p, 'utf8')).split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '')
        if (first === undefined) continue
        const bar = first.indexOf('|')
        const t = bar > 0 ? first.slice(bar + 1).trim() : first
        if (t !== '') { key = t; break }
      } catch { /* 下一个 */ }
    }
  }
  return key
}

async function readWbShimCredits(entry, model = '') {
  try {
    const base = typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : ''
    if (base === '' || !/^https?:\/\//.test(base)) return null
    const key = await resolveWbShimKey(entry, base)
    if (key === undefined || key === '') return null
    // [2026-10-19] 账号不再只看配置：同一网关多账号（国内/国际/N5105）按当前模型分账。
    const picked = await resolveWbVariant(entry, entry.provider ?? '', model, { base, key })
    const want = picked.variant
    // [2026-10-15 workbuddy] 优先走 summary 端点（官方 get-user-resource-summary 的代理，
    // CycleRemainCapacity 带小数——桌面端"套餐与积分"页 6738.68 同源口径）。
    // 老 wb-shim 没这端点（404/结构不对）则回落下方 /v1/credits 整数口径，两机兼容。
    try {
      const s = await fetchJson(`${base}/v1/credits-summary`, { authorization: `Bearer ${key}`, accept: 'application/json' })
      // [2026-10-15 workbuddy 诊断] NO-RESPONSE=请求失败/超时/非2xx；keys=返回了但看结构
      // [2026-10-23 收口] 原来是无条件 console.error ⇒ 每次查余额都往 err.log 刷两条，
      //   wb-shim 停用后更是刷满 NO-RESPONSE。改为仅在 WB_SHIM_DIAG=1 时输出。
      if (process.env.WB_SHIM_DIAG === '1') {
        console.error('[wb-summary-diag]', base, s === undefined ? 'NO-RESPONSE' : 'keys=' + Object.keys(s).join('|'))
      }
      const variants = s && typeof s === 'object' ? Object.entries(s) : []
      let stotal = 0
      const sagg = new Map()
      let hit = false
      for (const [variant, sv] of variants) {
        if (sv === null || typeof sv !== 'object') continue
        if (want !== '' && variant !== want) continue
        const pkgs = sv.code === 0 && sv.data && Array.isArray(sv.data.Packages) ? sv.data.Packages : null
        // [2026-10-15 workbuddy 诊断] sv 层：code/Packages 为什么没过
        // [2026-10-23 收口] 同上，仅 WB_SHIM_DIAG=1 时输出，避免刷日志。
        if (process.env.WB_SHIM_DIAG === '1') {
          console.error('[wb-summary-diag]', variant, 'code=' + String(sv?.code), 'pkgs=' + (Array.isArray(sv?.data?.Packages) ? sv.data.Packages.length : 'NO'), 'dataType=' + typeof sv?.data)
        }
        if (!pkgs) continue
        hit = true
        for (const p of pkgs) {
          const remain = Number(p?.CycleRemainCapacity)
          const size = Number(p?.CycleTotalCapacity)
          if (!Number.isFinite(remain) || remain <= 0) continue
          stotal += remain
          const name = typeof p?.PackageCode === 'string' && p.PackageCode !== '' ? p.PackageCode : '(包)'
          const cur = sagg.get(name) ?? { remain: 0, size: 0 }
          cur.remain += remain
          cur.size += Number.isFinite(size) && size > 0 ? size : 0
          sagg.set(name, cur)
        }
      }
      if (hit && (stotal > 0 || sagg.size > 0)) {
        const sdetail = []
        for (const [name, cur] of sagg) sdetail.push({ name: `${want}·${name}`, remain: cur.remain, size: cur.size })
        return { unit: 'credits', total: stotal, detail: sdetail, account: want, accountWhy: picked.how }
      }
    } catch { /* summary 端点不可用（老版 wb-shim），回落整数口径 */ }
    const data = await fetchJson(`${base}/v1/credits`, { authorization: `Bearer ${key}`, accept: 'application/json' })
    if (data === undefined || data === null) return null
    // 聚合：顶层每个变体键（workbuddy / workbuddy-ai / …）取 total；
    // accounts 明细按套餐名聚合（51 个包同名合并，防 title 爆炸——同 wb-shim 看板口径）。
    // [2026-10-08 老大点名"国内版国际版显示同一个数"] 原来这里不分变体全加在一起 ⇒ 两条配置读到同一总数。
    // 现在按 entry.variant 只取那一家；没填 variant 才退回"全部相加"的老行为。
    // [2026-10-15 workbuddy] want 声明已上移到 summary 块之前（原先在这里，summary 块先用了它 → TDZ ReferenceError 被 catch 吞 → 永远回落整数口径）。
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
    return { unit: 'credits', total, detail, account: want, accountWhy: picked.how }
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
  async function snapshotChannel(channel, entryOrProvider, creds, model = '') {
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
        // [2026-10-19] 传 model：同一网关多账号按模型分账（国内/国际/N5105）。
        usage = await readWbShimCredits({ ...entry, provider: entry.provider ?? creds.provider ?? '' }, model)
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
   * @param {string} [model] - 当前模型 id（同一网关多账号时用来分账）。
   * @returns {Promise<{ balance: object|null, gatewayHealthy: boolean|null, usage: object|null }>}
   */
  async function snapshot(provider, model = '') {
    // [2026-10-19] 缓存键带模型：lecoo / lecoo-intl / n5105 三家地址相同，
    // 只按 provider 缓存会把 A 家的积分喂给 B 家。
    const cacheKey = model === '' ? provider : `${provider}\u0000${model}`
    const now = Date.now()
    const hit = cache.get(cacheKey)
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.value

    // [2026-10-09 重做] 通道来自能力表/高级覆盖（resolveBalanceEntry），每次重读文件 ⇒ 保存即生效。
    const doc = readBalanceDoc()
    const resolved = resolveBalanceEntry(provider, doc)
    // 三级隐身：总开关关掉 / 这家被取消勾选 / 压根不支持或没登记 ⇒ 输入框连占位都不画。
    if (!doc.showBalance || doc.disabled.includes(resolved.head)
      || resolved.kind === 'unsupported' || resolved.kind === 'unknown') {
      const value = { balance: null, gatewayHealthy: null, usage: null, hidden: true }
      cache.set(cacheKey, { at: now, value })
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
      ;({ balance, usage } = await snapshotChannel(channel, { ...entry, provider: resolved.head }, creds, model))
    }

    const gatewayHealthy = GATEWAY_PROVIDERS.has(provider) || channel === 'gw-balance' ? await readGatewayHealth() : null
    const value = { balance, gatewayHealthy, usage }
    cache.set(cacheKey, { at: now, value })
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
          const { balance, usage, reason } = await snapshotChannel(entry.channel, { ...entry, provider: String(body?.provider ?? '').split('/')[0] }, creds, String(body?.model ?? ''))
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
          // [2026-10-19] model：同一网关多账号（lecoo / lecoo-intl / n5105）按模型分账。
          const model = (url.searchParams.get('model') ?? '').trim()
          const { balance, gatewayHealthy, usage, hidden } = await snapshot(provider, model)
          write(200, { ok: true, balance, gatewayHealthy, usage: usage ?? null, hidden: hidden === true })
        } catch (error) {
          write(200, { ok: false, balance: null, gatewayHealthy: null, usage: null,
            error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }, 'dsh-balance')
}

/**
 * [2026-10-15 workbuddy] GET /api/turn-usage：本轮对话消耗查询。
 * 转发 wb-shim 的 /v1/usage-recent（官方按请求明细，每条自带精确 credit）。
 * 前端在 assistant 消息操作条注入「⚡X.XX」pill 时调用，窗口=上一条 assistant 消息到本条。
 * 复用 workbuddy 的 wb-shim 通道配置（url/tokenFile，同余额显示）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function applyTurnUsage(ctx) {
  ctx.effect(() => {
    if (typeof ctx.webServer?.register !== 'function') return undefined
    // [2026-10-21 对账] /api/conv-ids：把 wb-shim 的 /v1/conv-ids 代理给浏览器。
    // 为什么要代理：前端拿不到网关地址（/api/balance 实测返回 balance:null，没有 channels 字段），
    // 浏览器也没法直接带 Bearer 访问 wb-shim ⇒ 之前迟迟拿不到本轮 id，pill 恒 0。
    try {
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/conv-ids',
        handler: async (req, res) => {
          const write = (code, obj) => {
            res.statusCode = code
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(obj))
          }
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const since = Number(url.searchParams.get('since')) || Date.now() - 300000
            const until = Number(url.searchParams.get('until')) || Date.now() + 60000
            const doc = readBalanceDoc()
            const resolved = resolveBalanceEntry('workbuddy', doc)
            const entry = resolved && typeof resolved === 'object' && resolved.entry ? resolved.entry : null
            const base = entry && typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : ''
            if (base === '' || !/^https?:\/\//.test(base)) return write(200, { ok: false, ids: [], error: 'wb-shim 通道没配网关地址' })
            const key = await resolveWbShimKey(entry, base)
            if (!key) return write(200, { ok: false, ids: [], error: 'wb-shim 通道没拿到 token' })
            const data = await fetchJson(`${base}/v1/conv-ids?since=${Math.floor(since)}&until=${Math.floor(until)}`, { authorization: `Bearer ${key}`, accept: 'application/json' })
            const ids = data && Array.isArray(data.ids) ? data.ids : []
            // [2026-10-21] turns 也要透传：前端靠它把 id 按"轮"分组对到每条消息上。
            const turns = data && Array.isArray(data.turns) ? data.turns : []
            return write(200, { ok: true, count: ids.length, ids, turns })
          } catch (error) {
            return write(200, { ok: false, ids: [], error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
    } catch (e) { console.error('[dsh-turn-usage] /api/conv-ids 注册失败:', e) }
    return ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-usage',
      handler: async (req, res) => {
        const write = (code, obj) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(obj))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const until = Number(url.searchParams.get('until')) || Date.now()
          const since = Number(url.searchParams.get('since')) || until - 5 * 60000
          // [2026-10-21 精确对账] 调用方可以带本轮自己的会话请求 id（逗号分隔）：
          //   ?conv=01a15a13b96e7864...,01a15a1e4fda783e...
          // 带了就只认这些 id 命中的官方行，彻底摆脱"时间窗里全是别人的账"。
          // 依据（00:2x 实测 3/3 命中）：wb-shim 现在发 UUIDv7-32hex，官方账 requestId 原样采用它。
          const convIds = String(url.searchParams.get('conv') || '').split(',').map((s) => s.trim()).filter(Boolean)
          const convSet = new Set(convIds)
          // wb-shim entry：与余额显示同源（workbuddy 默认通道，配置文件可覆盖）
          const doc = readBalanceDoc()
          const resolved = resolveBalanceEntry('workbuddy', doc)
          const entry = resolved && typeof resolved === 'object' && resolved.entry ? resolved.entry : null
          const base = entry && typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : ''
          if (base === '' || !/^https?:\/\//.test(base)) {
            return write(200, { ok: false, error: 'wb-shim 通道没配网关地址' })
          }
          const key = await resolveWbShimKey(entry, base)
          if (key === undefined || key === '') {
            return write(200, { ok: false, error: 'wb-shim 通道没拿到 token' })
          }
          // [2026-10-15 v6 定案] 官方账为主：dsh 对话流量（web/客户端）都不走 wb-shim，
          // 走 dsh-workbuddy-connect 直连官方 —— credit-log 里只有其他消费方的杂流量
          // （WB 会话/12bot/litellm），当主源会把别人的账算进来（实测同轮 220.33 vs 真 24.86）。
          // shim /v1/credit-log 只在官方拿不到数据时兜底（官方入账延迟 1~2 分钟）。
          // rows 统一形状带 t（epoch ms）：前端按 t 分配到「上一轮完成 → 本轮完成」窗口。
          let rows = []
          let allOfficialRows = []   // 窗口内全部官方行（精确模式下给"账本漏记"兜底用）
          let source = 'official'
          let officialOk = false
          try {
            const data = await fetchJson(`${base}/v1/usage-recent?since=${Math.floor(since)}&until=${Math.floor(until)}`,
              { authorization: `Bearer ${key}`, accept: 'application/json' })
            // t：requestTime（"YYYY-MM-DD HH:mm:ss" 本地时区）转 epoch ms（2026-10-15 v6）。
            const parseT = (rt) => {
              if (typeof rt === 'number') return rt
              if (typeof rt === 'string') {
                const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(rt.trim())
                if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
                const n = Number(rt)
                if (Number.isFinite(n) && n > 0) return n
              }
              return 0
            }
            if (data && Array.isArray(data.variants)) {
              for (const v of data.variants) {
                for (const r of (v.requests ?? [])) rows.push({ id: String(r.requestId ?? ''), model: r.model, credit: Number(r.credit) || 0, t: parseT(r.requestTime), p: typeof r.agentPurpose === 'string' ? r.agentPurpose : '', acct: String(v.id ?? ''), input: String(r.input ?? '') })
              }
              // [2026-10-21] 先把窗口内全部官方行留底，再按 convId 精确筛。
              // 留底是给后面"账本漏记兜底"用的：只靠 convId 会漏掉 ring 里已滚出的 id
              // （实测漏 0.15：00:40 那批官方有、ring 没了 ⇒ pill 少算）。
              allOfficialRows = rows.slice()
              if (convSet.size > 0) rows = rows.filter((r) => convSet.has(r.id))
              officialOk = rows.length > 0
            }
          } catch { /* 官方挂了走 shim 兜底 */ }
          if (!officialOk && convSet.size === 0) {
            // [2026-10-21] 只在**非精确模式**兜底：精确模式下 rows 已被官方按 convId 筛过，
            // 这里整体替换会把 convId 抹掉，后面按 id 合并就永远匹配不上（pill 恒 0 的元凶）。
            const shimData = await fetchJson(`${base}/v1/credit-log?since=${Math.floor(since)}&until=${Math.floor(until)}`,
              { authorization: `Bearer ${key}`, accept: 'application/json' })
            if (shimData && shimData.ok && Array.isArray(shimData.entries)) {
              rows = shimData.entries.map((e, i) => ({ id: `shim-${i}-${e.t}`, model: e.model, credit: Number(e.credit) || 0, t: Number(e.t) || 0 }))
              source = 'shim-credit'
            }
          }
          // [2026-10-20 老大定·三钥匙账本] 拉全量账本（不带 caller 过滤），
          // 由前端按当前对话的 caller 筛。账本零延迟（响应 usage.credit 直出），
          // 官方账延迟 1~2 小时（延迟期 credit=0）⇒ 账本值优先覆盖。
          // 幂等合并：±5s 同模型视为同一笔。
          try {
            const shimData = await fetchJson(`${base}/v1/credit-log?since=${Math.floor(since)}&until=${Math.floor(until)}`,
              { authorization: `Bearer ${key}`, accept: 'application/json' })
            if (shimData && shimData.ok && Array.isArray(shimData.entries)) {
              for (const e of shimData.entries) {
                const t = Number(e.t) || 0
                // [2026-10-21 对账] 账本行自带 convId（= 官方 requestId），credit 来自响应 usage.credit
                // ⇒ **零延迟、官方未入账也有数**。这才是 WorkBuddy 的算法，不用等官方账。
                // 精确模式下只认 convId 命中本轮的账本行：bot 各有自己的 convId，天然排除。
                if (convSet.size > 0) {
                  const cid = String(e.convId ?? '')
                  if (!cid || !convSet.has(cid)) continue
                  const hit = rows.find((r) => r.id === cid)
                  if (hit) {
                    // 官方行同 id 已在：credit 以较大者为准（官方偶尔比响应值略低，别把已显示的数值改小）
                    hit.credit = Math.max(Number(hit.credit) || 0, Number(e.credit) || 0)
                    hit.caller = e.caller; hit.turn = e.turn
                  } else {
                    rows.push({ id: cid, model: e.model, credit: Number(e.credit) || 0, t, turn: e.turn, caller: e.caller })
                  }
                  continue
                }
                const dup = rows.find((r) => Math.abs(r.t - t) < 5000 && r.model === e.model)
                if (dup) {
                  if (Number(e.credit) > 0) dup.credit = Number(e.credit)
                  dup.turn = e.turn
                  dup.caller = e.caller
                } else {
                  rows.push({ id: `shim-${e.t}-${e.turn ?? 0}`, model: e.model, credit: Number(e.credit) || 0, t, turn: e.turn, caller: e.caller })
                }
              }
              if (rows.length) source = officialOk ? 'official+ledger' : 'shim-credit'
            }
          } catch { /* ledger unavailable: official account alone still answers */ }
          // [2026-10-20 老大定·WB 指南第 6 步：官方对账兜底] WorkBuddy 客户端漏记无补偿
          // （实测它 144 个会话里 34 个 used>0 但 credit_json=NULL）；我们必须补：
          // 官方账里 credit>0 的行，若账本没有对应记录（±60s 同模型），说明账本漏记
          // ⇒ 补一条官方行，保证"官方账 ≥ 账本"，最终显示不漏。
          if (officialOk) {
            try {
              const ledgerRows = rows.filter((r) => r.caller)
              for (const off of rows) {
                if (off.caller) continue
                if (!(Number(off.credit) > 0)) continue
                const covered = ledgerRows.some((l) => Math.abs((l.t || 0) - (off.t || 0)) < 60000 && l.model === off.model)
                if (!covered) off.needLedger = true
              }
            } catch { /* 补录标记失败不阻断 */ }
          }
          // [2026-10-21] 精确模式出口再滤一次：只留 id ∈ convSet 的行。
          // 上游 collect 阶段会混进"官方时间窗里的全部行"，不过滤就会把别人的账带出去。
          const outRows = convSet.size > 0 ? rows.filter((r) => convSet.has(String(r.id))) : rows
          return write(200, { ok: true, since, until, source, mode: convSet.size > 0 ? 'conv' : 'window', conv: convSet.size, rows: outRows })
        } catch (error) {
          return write(200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }, 'dsh-turn-usage')
}

/* ══════════════════════════════════════════════════════════════════
 * [2026-10-23] 单轮金额（DeepSeek 官方 token 计价）
 *
 * 背景：wb-shim 全线停用（2026-10-23），原 /api/turn-usage 整条链依赖它的
 *   /v1/usage-recent + /v1/credit-log，已全部失效 ⇒ ⚡pill 永远空着。
 * 改为读 DSH 自己的会话事件：assistant/message.data.usage 是 provider 侧精确计数
 *   （token-meter 的 uncachedInputTokens 来源），乘官方价目表 = 单轮人民币。
 *
 * 数据源：~/.dsh/sessions/<workspace>/session-<sid>/session.v<N>.jsonl[.zstd]
 *   🔴 会话是**追加写**的 ⇒ 多 zstd 帧拼接，zstdDecompressSync 只解第一帧，
 *   必须按 magic(28 B5 2F FD) 切帧逐段解。
 * 口径：usage.inputTokens = **未缓存**输入（不含 cacheRead/cacheWrite），
 *   与 cacheReadTokens 分开计价；cacheWriteTokens 官方未单列，按未命中价近似。
 * ══════════════════════════════════════════════════════════════════ */

/** 官方价目表（元 / 百万 token）。来源 api-docs.deepseek.com「模型 & 价格」，2026-10-23 抓取。
 *  高峰 = 周一至周五 09:00-12:00、14:00-18:00（不含法定节假日）；其余时段空闲，价格半价。 */
const DS_TOKEN_PRICES = {
  'deepseek-flash': { peak: { inMiss: 2, inHit: 0.04, out: 8 }, idle: { inMiss: 1, inHit: 0.02, out: 4 } },
  'deepseek-v4-flash': { peak: { inMiss: 2, inHit: 0.04, out: 8 }, idle: { inMiss: 1, inHit: 0.02, out: 4 } },
  'deepseek-v4-pro': { peak: { inMiss: 9, inHit: 0.3, out: 27 }, idle: { inMiss: 4.5, inHit: 0.15, out: 13.5 } },
}

/** 当前是否高峰时段（工作日的 9-12 / 14-18）。法定节假日无法离线判定，按工作日处理。 */
function dsPeakNow(d = new Date()) {
  const wd = d.getDay()
  if (wd === 0 || wd === 6) return false
  const h = d.getHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 逐帧解压多 zstd 帧（会话追加写产生）。遇到半截帧跳过，不整体失败。 */
function zstdDecodeAllFrames(buf) {
  if (!buf || buf.length < 4) return ''
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let i = 0
  while (i <= buf.length - 4) {
    const at = buf.indexOf(magic, i)
    if (at < 0) break
    offsets.push(at)
    i = at + 4
  }
  if (!offsets.length) return ''
  let out = ''
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(start, end)).toString('utf8') } catch { /* 半截帧 */ }
  }
  return out
}

/** 按 sessionId 找会话文件。**两级策略**：
 *  ① 传了 sid → 先精确匹配 session-<sid>；
 *  ② 精确匹配不到（前端拿到的 sid 是旧的/别的会话/空）→ **退回"最近修改的会话"**。
 *  为什么必须兜底：网页版 URL 没有 session-xxx，`currentSessionIdNow()` 依赖的
 *  [data-session-id] 在新版客户端已移除 ⇒ 前端可能传错或传空，pill 就一直是 ⚡—。
 *  单会话场景下"最近修改"必然就是当前会话。 */
function findSessionFile(sessionId) {
  // 🔴 [2026-10-23 实测] 前端传的是**带前缀**的 `session-<uuid>`（currentSessionIdNow 从
  // URL/DOM 拿到的就是这个形状），而目录名已含 session-，不剥前缀会拼成
  // session-session-<uuid> ⇒ 永远精确匹配不到（之前全靠"最近会话"兜底碰巧命中）。
  const sid = String(sessionId || '').trim().replace(/^session-/i, '')
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

  const scan = (onlySid) => {
    let best = ''
    let bestT = 0
    try {
      for (const ws of readdirSync(root)) {
        const wsDir = join(root, ws)
        let names
        try { names = readdirSync(wsDir) } catch { continue }
        for (const nm of names) {
          if (onlySid !== '' && nm !== `session-${onlySid}`) continue
          if (!/^session-[0-9a-zA-Z_-]{8,}$/.test(nm)) continue
          const dir = join(wsDir, nm)
          let files
          try { files = readdirSync(dir) } catch { continue }
          for (const f of files) {
            if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(f)) continue
            const fp = join(dir, f)
            try {
              const st = statSync(fp)
              if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = fp }
            } catch { /* 单文件读不到跳过 */ }
          }
        }
      }
    } catch { /* 目录读不到 */ }
    return best
  }

  // ① 精确
  if (sid !== '' && /^[0-9a-zA-Z_-]{8,}$/.test(sid)) {
    const exact = scan(sid)
    if (exact !== '') return exact
  }
  // ② 兜底：最近修改的会话
  return scan('')
}

/** 从会话事件里按 turn 汇总 token，并按模型价目算金额。 */
function computeTurnCosts(text, isPeak) {
  const acc = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    // 快筛：绝大多数行不是 assistant/message
    if (!line || line.indexOf('"assistant/message"') < 0) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o?.type !== 'assistant/message') continue
    const u = o.data?.usage
    if (!u || typeof u !== 'object') continue
    const turn = Number(o.data?.turn)
    if (!Number.isFinite(turn)) continue
    const model = String(o.data?.message?.source?.model || '') || 'deepseek-flash'
    const cur = acc.get(turn) || { turn, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, models: new Map() }
    cur.input += Number(u.inputTokens) || 0
    cur.cacheRead += Number(u.cacheReadTokens) || 0
    cur.cacheWrite += Number(u.cacheWriteTokens) || 0
    cur.output += Number(u.outputTokens) || 0
    cur.models.set(model, (cur.models.get(model) || 0) + 1)
    acc.set(turn, cur)
  }
  const list = [...acc.values()].sort((a, b) => a.turn - b.turn)
  return list.map((t) => {
    // 同一轮理论上单模型；万一混了，取出现次数最多的那个定价格
    const model = [...t.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'deepseek-flash'
    const table = DS_TOKEN_PRICES[model] ?? DS_TOKEN_PRICES['deepseek-flash']
    const pr = isPeak ? table.peak : table.idle
    const cost = (t.input * pr.inMiss + t.cacheRead * pr.inHit + t.cacheWrite * pr.inMiss + t.output * pr.out) / 1e6
    return {
      turn: t.turn,
      model,
      input: t.input,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      output: t.output,
      total: t.input + t.cacheRead + t.cacheWrite + t.output,
      cost: Math.round(cost * 1e6) / 1e6,
    }
  })
}

/**
 * 注册 GET /api/turn-cost?sessionId=<id>
 *   -> { ok, isPeak, turns:[{turn, model, input, cacheRead, cacheWrite, output, total, cost}] }
 * 前端按「第 N 条已定稿 assistant 消息 ↔ 第 N 个 turn」（尾部对齐）配到 pill 上。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function applyTurnCost(ctx) {
  ctx.effect(() => {
    if (typeof ctx.webServer?.register !== 'function') return undefined
    return ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-cost',
      handler: async (req, res) => {
        const write = (code, obj) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(obj))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const sessionId = String(url.searchParams.get('sessionId') || '').trim()
          const file = findSessionFile(sessionId)
          if (file === '') return write(200, { ok: false, turns: [], error: `找不到会话文件（session=${sessionId || '空，且没有最近会话'}）` })
          const buf = readFileSync(file)
          const text = file.endsWith('.zstd') ? zstdDecodeAllFrames(buf) : buf.toString('utf8')
          const isPeak = dsPeakNow()
          const turns = computeTurnCosts(text, isPeak)
          // [2026-10-23 诊断] 前端到底有没有来问、问到哪个会话、算出几轮 —— 一行看全。
          console.error(`[dsh-turn-cost] sid='${sessionId || '(空)'}' file=${file.split(/[\\/]/).slice(-2).join('/')} turns=${turns.length} peak=${isPeak}`)
          return write(200, { ok: true, isPeak, file, turns })
        } catch (error) {
          return write(200, { ok: false, turns: [], error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }, 'dsh-turn-cost')
}

