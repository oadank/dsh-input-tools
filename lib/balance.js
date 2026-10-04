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
 * ── provider 路由表 ──────────────────────────────────────────────────
 *   deepseek-account  → 登录账号钱包（platform /api/v0/users/get_user_summary）
 *   deepseek / deepseek-official / llm-deepseek
 *                     → API key 直连（api.deepseek.com/user/balance）
 *   gw / litellm      → 网关健康（gateway.henry-gao.com/health）
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

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DeepSeek 官方 API key 余额端点。 */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** LiteLLM 网关健康端点（返回 { ready: boolean }）。 */
const GATEWAY_HEALTH_URL = 'https://gateway.henry-gao.com/health'
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
   * 按 provider 取一份余额快照。
   * @param {string} provider - 前端传来的 provider 前缀。
   * @returns {Promise<{ balance: object|null, gatewayHealthy: boolean|null }>}
   */
  async function snapshot(provider) {
    const now = Date.now()
    const hit = cache.get(provider)
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.value

    const creds = await readCredentials()
    let balance = null

    if (ACCOUNT_PROVIDERS.has(provider)) {
      if (creds.accountToken !== undefined) balance = await readAccountBalance(creds.accountToken, creds.accountIssuer)
    } else if (APIKEY_PROVIDERS.has(provider)) {
      const key = creds.apiKey ?? process.env.DEEPSEEK_API_KEY
      if (key !== undefined && key !== '') balance = await readApiKeyBalance(key)
    } else if (provider === '') {
      // 前端没给出 provider：API key 优先，其次登录账号，两条通道对同一账号结果一致。
      const key = creds.apiKey ?? process.env.DEEPSEEK_API_KEY
      if (key !== undefined && key !== '') balance = await readApiKeyBalance(key)
      if (balance === null && creds.accountToken !== undefined) {
        balance = await readAccountBalance(creds.accountToken, creds.accountIssuer)
      }
    }

    const gatewayHealthy = GATEWAY_PROVIDERS.has(provider) ? await readGatewayHealth() : null
    const value = { balance, gatewayHealthy }
    cache.set(provider, { at: now, value })
    return value
  }

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
          const { balance, gatewayHealthy } = await snapshot(provider)
          write(200, { ok: true, balance, gatewayHealthy, usage: null })
        } catch (error) {
          write(200, { ok: false, balance: null, gatewayHealthy: null, usage: null,
            error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  }, 'dsh-balance')
}
