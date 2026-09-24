#!/usr/bin/env node
/**
 * repo-rerank.mjs —— 用阿里云判断模型给仓库文件按"与当前任务的相关度"排序。
 * 自研简版（不装国外 jev 工具），核心区别：**只把文件路径发给模型，文件内容一个字节都不出门**。
 *
 * 用法：
 *   node scripts/repo-rerank.mjs "把 ⚡ 提示词优化的等待时间降下来，先找该看哪几个文件" [--repo 路径] [--top 20] [--batch 16] [--out .rerank.json] [--all]
 *
 * 凭证/地址推导链与宿主端一致：env DECISION_URL/DECISION_KEY → opencode.json 的 litellm baseURL
 *   → 兜底 http://127.0.0.1:4000；key：env → HKCU OPENAI_API_KEY。代码里不写死任何密钥。
 * 依赖：本机 litellm 已挂上 /systemone 透传口（配置真源：litellm_config.yaml → general_settings.pass_through_endpoints）。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs' // ESM 里没有 require，遍历目录直接用 readdirSync
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

// ── 参数 ──
const argv = process.argv.slice(2)
const task = argv.find((a) => !a.startsWith('--')) || ''
if (task === '') {
  console.error('用法: node repo-rerank.mjs "<任务描述>" [--repo 路径] [--top 20] [--batch 16] [--out 文件] [--all]')
  process.exit(2)
}
const flag = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def }
const repoRoot = flag('repo', process.cwd())
const topN = Number(flag('top', 20))
const batchSize = Math.max(1, Math.min(16, Number(flag('batch', 16)))) // 官方建议单次 ≤16 题，延迟随题数近线性
const outPath = flag('out', join(repoRoot, '.rerank.json'))
const keepAll = argv.includes('--all')   // --all = 连"无关"也写进结果文件（默认只留 ≥1 分的）

// ── 凭证 ──
function creds() {
  let url = String(process.env.DECISION_URL || '').trim()
  let key = String(process.env.DECISION_KEY || '').trim()
  if (url === '') {
    let base = String(process.env.LITELLM_BASE_URL || '').trim()
    if (base === '') {
      try {
        const j = JSON.parse(readFileSync(join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'))
        base = String(j?.provider?.litellm?.options?.baseURL ?? '').trim()
      } catch { /* 走兜底 */ }
    }
    url = (base || 'http://127.0.0.1:4000').replace(/\/+$/, '').replace(/\/(v1|compatible-mode\/v1)$/i, '') + '/systemone'
  }
  if (key === '') key = String(process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '').trim()
  if (key === '') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY'], { encoding: 'utf8', timeout: 5000 })
      const m = /OPENAI_API_KEY\s+REG_SZ\s+(\S+)/.exec(out)
      if (m) key = m[1]
    } catch { /* 取不到就报错退出 */ }
  }
  return { url, key }
}

// ── 文件清单：只拿路径，绝不读文件内容 ──
function listFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const v = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (v.length) return { files: v, how: 'git ls-files' }
  } catch { /* 不是 git 仓库，转目录遍历 */ }
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', 'out', 'coverage', '.dsh-tmp'])
  const files = []
  const walk = (dir, rel) => {
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) walk(join(dir, e.name), rel + e.name + '/') }
      else if (files.length < 5000) files.push((rel + e.name).replaceAll(sep, '/'))
    }
  }
  walk(root, '')
  return { files, how: '目录遍历（非 git 仓库）' }
}

// ── 敏感路径闸门：路径本身也会泄密（如 密码本.xlsx / id_rsa），默认跳过不外发 ──
const SECRET_RE = /(secret|token|passw|credential|api[_-]?key|private[_-]?key|id_rsa|\.pem$|\.p12$|\.key$|密码|凭据|私钥)/i

// [2026-09-25 实测纠偏] 第一版题面写的是"宁可给略相关也别一律给无关"，结果 68 个文件全挤在 1.06~1.64、
//   没有一个"无关"——分数被压扁成噪音，排序纯属碰运气。改成**逼稀疏**：绝大多数必须判无关，只有极少数能给高分。
// [2026-09-25 英文题面实测换血] 中文题面下 68 个文件全挤在 1.06~1.73，核心源码 1.73 与一张 jpg 截图 1.69
//   只差 0.04 —— 等于瞎排。换成英文题面（内容仍保留中文任务描述）后：lib/index.js 1.33 / lib/client.js 1.41 排前，
//   vision-test.jpg 掉到 0.13（模型 89% 把握判"无关"）。差距从 0.04 拉成 1.2 倍，排序才有信息量。
//   依据：jev 官方口径"主训练语言是英文，题目用英文、内容原样"（见 jev-chat-jarvis README 已知限制一节）。
const INSTRUCTIONS = 'You rank repository files by how relevant each path is to the given task, to decide which few files to open first.' +
  ' You see ONLY the path string — never file contents — so judge from directory names, file naming and extensions.' +
  ' Relevance is rare: a task really needs only 3-8 files, so most paths in a repo are irrelevant and must be scored irrelevant.' +
  ' Source code that owns the feature named in the task -> must read. Config/manifest/test/screenshot/image/patch/lock files -> usually irrelevant,' +
  ' even when the repo is about that feature. When unsure, judge lower. Never spread a whole batch across the middle: that is not a ranking.'
const LEVELS = ['irrelevant', 'slightly related', 'fairly related', 'must read']

function gradeOne(path) {
  return { type: 'score', instructions: `How relevant is this file path to the task: ${path}`, criteria: LEVELS }
}

async function askBatch(c, paths) {
  const body = {
    model: 'decision-model-preview',
    instructions: INSTRUCTIONS,
    state: { 任务: task, 说明: '仅提供文件路径清单，未提供任何文件内容' },
    questions: Object.fromEntries(paths.map((p, i) => ['f' + i, gradeOne(p)])),
  }
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const t = await r.text().catch(() => '')
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 160)}`)
  const j = JSON.parse(t)
  return paths.map((p, i) => ({ path: p, score: Number(j?.answers?.['f' + i]?.score ?? 0), probs: j?.answers?.['f' + i]?.probabilities ?? null }))
}

const c = creds()
if (!c.key) { console.error('拿不到网关 key（env DECISION_KEY / LITELLM_API_KEY / HKCU OPENAI_API_KEY 都为空），退出'); process.exit(3) }
const { files, how } = listFiles(repoRoot)
const secret = files.filter((f) => SECRET_RE.test(f))
const use = keepAll ? files : files.filter((f) => !SECRET_RE.test(f))
console.log(`仓库 ${repoRoot}\n清单来源: ${how}  共 ${files.length} 个文件` + (secret.length ? `\n⚠ 跳过 ${secret.length} 个路径含敏感字样的（路径本身也算泄密），加 --all 可强行包含：\n   ${secret.slice(0, 6).join('\n   ')}` : ''))
console.log(`任务: ${task}`)
console.log(`网关: ${c.url}  每批 ${batchSize} 个文件  预计 ${Math.ceil(use.length / batchSize)} 次请求`)

const t0 = Date.now()
const results = []
let errs = 0
const queue = []
for (let i = 0; i < use.length; i += batchSize) queue.push(use.slice(i, i + batchSize))
const CONC = 4 // 并发 4 批：官方 RPM 1200，这点量远不到，留余量给别的进程
let cursor = 0
async function worker() {
  for (;;) {
    const i = cursor++
    if (i >= queue.length) return
    try { results.push(...await askBatch(c, queue[i])) }
    catch (e) { errs++; console.error(`  批 ${i} 失败: ${e.message}`) }
    if (results.length % 200 < batchSize) process.stdout.write(`  …已排 ${results.length}/${use.length}\r`)
  }
}
await Promise.all(Array.from({ length: CONC }, worker))
const secs = ((Date.now() - t0) / 1000).toFixed(1)

// [2026-09-25] 别拿固定分当切线：严格英文题面下 16 个一批会把分数整体压低（同文件单问 1.33、批量 0.6 附近），
//   写死 "≥1 才留" 会一个都不剩。改为：默认切线 = 本批最高分的一半（相对量，随题面/批量自动漂移），
//   并且**排序表永远打前 N 行**，打表与过滤互不卡脖子。
results.sort((a, b) => b.score - a.score)
const maxScore = results.length ? results[0].score : 0
const cut = Number(flag('cut', (maxScore / 2).toFixed(3)))
const keep = keepAll ? results : results.filter((r) => r.score >= cut)
writeFileSync(outPath, JSON.stringify({ task, repo: repoRoot, generatedAt: new Date().toISOString(), files: results.length, secretSkipped: secret.length, elapsedSec: +secs, cut, ranking: results }, null, 2), 'utf8')

console.log(`\n耗时 ${secs}s（${queue.length} 批 / ${use.length} 文件，失败 ${errs} 批）—— 全程只发路径，零文件内容外发`)
console.log(`结果已写 ${outPath}（全 ${results.length} 条，切线 ${cut}，线上 ${keep.length} 条）\n`)
console.log('分   文件路径')
for (const r of results.slice(0, topN)) console.log(`${r.score.toFixed(2).padStart(5)}  ${r.score >= cut ? '↑' : ' '} ${r.path}`)
