// /de 候选的「分歧轴」词表 + 撞轴校验。
// 2026-09-26 老大选 C：三条不排序、不显示百分比，他自己挑；
// 并且废掉固定的「推进/收窄/叫停」——那三个是**态度**不是**分歧点**，三条容易写成同一态度的三种语气。
// 改成：从下面这张轴清单里按局面挑 3 条**不同的轴**，每条攻一个真实分歧点。
// 🔴 这份词表与飞书桥 agents-to-feishu/src/bridge/local-engines.ts 的 rolesForJudge 同源，别两边各写各的。
'use strict'

const AXES = [
  { id: '表态', hint: '直接给答案：对面给了编号选项就回"选 X"+一句附加要求；没给选项就明确"就按你说的做"并把验收钉死', eg: '选 C。另外：改完把自测原文贴给我。' },
  { id: '改范围', hint: '只做其中一块，或先只做只读探测，别扩做', eg: '先只做 A 那一步，别的别碰。' },
  { id: '换路径', hint: '活继续，但换做法/换工具/换顺序/换到哪一层', eg: '别碰那个提权服务，改上层，不用重编。' },
  { id: '换人', hint: '这活谁来做：交给别的 bot、让它只出方案不动手、或我自己来', eg: '这活甩给 WorkBuddy 自己测自己改，你只出方案。' },
  { id: '要证据', hint: '先回答我的疑问 / 把读到的原文贴出来 / 自己验证过再回话', eg: '把你读到的那行原文和坐标贴出来，读不到就明说读不到。' },
  { id: '加约束', hint: '划边界：先备份、不许重启、不许提交、只读、改前报备', eg: '改前备份，不许重启服务，改法回法实时报备。' },
  { id: '定完成标准', hint: '怎么算干完了、多久、失败怎么办', eg: '自己验证过再回话，验证方式写清楚，两小时内。' },
  { id: '停/推迟', hint: '现在不做：喊停、撤回、等条件成熟', eg: '停，先别动，等我看完那份文档。' },
]
const AXIS_IDS = AXES.map((x) => x.id)
const byId = (id) => AXES.filter((x) => x.id === id)[0] || null

// 对面这轮是不是给了编号选项（给了，"表态"就必须排第一 —— 老大 09-26 定的回法铁律：
// 他给 A/B/C，回话就得是 A/B/C 之一或"都不选+我的要求"，不许另起一套）
function hasNumberedOptions (text) {
  const tail = String(text || '').slice(-1600)
  return /(^|\n)\s*[A-D][.、：:）)]\s*\S/.test(tail)
    || /选\s*[A-D]\b/.test(tail)
    || /[一二三四1-4][)）、.]\s*\S/.test(tail)
    || /(二选一|三选一|以下选项|给你三个选项|给你几个选项|哪个方案|你选|要不要|是否)/.test(tail)
}

// 一条候选落在哪条轴上：按**命中数计分**取最高（纯关键词会互相抢：
// "别碰那个服务，改上层"既像停手又像换路径，谁词多算谁的）。判不出返回 null。
const SCORED = [
  ['表态', ['^选\\s*[A-D]', '^选[一二三四1-4]', '^就选', '^都不选', '^按你说的', '^就按', '^同意', '^照办', '^干吧', '都不选.{0,6}要求', '^行吧', '^可以.{0,4}(改|做|继续)']],
  ['改范围', ['只做', '先只', '只改', '这一步', '这一项', '一半', '局部', '只.{0,4}(读|探测|看)', '砍.{0,3}范围', '范围.{0,4}缩小', '先做.{0,8}(这一步|一块|一个)']],
  ['换路径', ['换成', '改用', '换个做法', '换个思路', '换条', '另一条', '换到.{0,6}(层|条|路)', '上层', '重编', '换工具', '换顺序', '绕开', '别走.{0,8}走']],
  ['换人', ['交给', '甩给', '派给', '你只出', '我来做', '我自己', '让它自己', '让\\s*\\S+\\s*自己', '别自己改', '别自己动', '只出方案']],
  ['加约束', ['备份', '不许', '禁止', '别碰', '别改', '不要提交', '只读', '先确认', '报备', '别删', '限定', '回法.{0,4}报备']],
  ['要证据', ['贴出来', '贴给我', '给我看', '原文', '证明', '证据', '凭什么', '为什么', '解释', '列出来', '读不到就明说', '日志', '截图', '你自己.{0,6}验证']],
  ['定完成标准', ['算做完', '算数', '怎么验', '验证方式', '截止', '小时内', '超时', '失败怎么', '自己验证', '多久', '验证过再回话']],
  ['停/推迟', ['^停', '先别动', '别动', '先搁', '搁着', '等我', '推迟', '撤回', '回退', '停手', '别做了', '先别', '等.{0,10}再']],
]
// 以「选 X / 都不选 / 就按你说的」开头的句子**无条件算表态**，不参与计分 ——
// 老大 09-26 的回法铁律：对面给了编号选项，回话就得是那个编号之一。这类句子后面常带附加要求
// （"选 C。另外：把原文贴给我"），计分就会被"贴给我"抢成要证据，实测栽过一次。
const STANCE_PREFIX = /^选\s*[A-D一二三四1-4](\b|[。、，,：:])|^就选|^都不选|^按你说的|^就按|^同意|^照办|^干吧|^行吧/
function axisOf (text) {
  const s = String(text || '').trim()
  if (!s) return null
  if (STANCE_PREFIX.test(s)) return '表态'
  let best = null, bs = 0
  for (let i = 0; i < SCORED.length; i++) {
    const pats = SCORED[i][1]
    let n = 0
    for (let k = 0; k < pats.length; k++) { try { if (new RegExp(pats[k]).test(s)) n++ } catch (e) {} }
    if (n > bs) { bs = n; best = SCORED[i][0] }
  }
  return bs >= 1 ? best : null
}
function distinctAxes (list) {
  const seen = {}
  const arr = list || []
  for (let i = 0; i < arr.length; i++) { const a = axisOf(arr[i]); if (a) seen[a] = 1 }
  return Object.keys(seen).length
}

// 按局面挑 3 条不同的轴。judge = 决策模型那八维（可能为 null：它挂了就走默认，绝不卡住候选）。
function pickAxes (judge, opts) {
  const picked = []
  const push = (id) => { if (byId(id) && picked.indexOf(id) < 0) picked.push(id) }
  const j = judge || {}
  const intent = String(j.intent || '')
  const mood = String(j.mood || '')
  if (opts && opts.hasOptions) push('表态')
  if (intent === 'verify' || mood === 'doubtful' || mood === 'annoyed') { push('要证据'); push('停/推迟') }
  if (j.risk === 'high' || j.risk === 'mid') push('加约束')
  if (Number(j.needsFact) === 1) push('要证据')
  if (j.scope === 'large') { push('改范围'); push('定完成标准') }
  if (intent === 'question' || intent === 'ask_info') { push('表态'); push('要证据') }
  else if (intent === 'decide') { push('表态'); push('换路径') }
  else if (intent === 'accept') { push('表态'); push('定完成标准') }
  else if (intent === 'assign') { push('改范围'); push('换人') }
  else if (intent === 'narrow' || intent === 'stop') { push('停/推迟'); push('改范围') }
  else if (intent === 'chase') { push('定完成标准'); push('要证据') }
  const fill = ['要证据', '改范围', '换路径', '定完成标准', '加约束', '换人', '停/推迟', '表态']
  for (let i = 0; i < fill.length && picked.length < 3; i++) push(fill[i])
  return picked.slice(0, 3)
}

// 把选中的轴拼成起草提示词里那段"三条必须按这个顺序、这个轴"
function roleBlock (axes) {
  const lines = []
  for (let i = 0; i < axes.length; i++) {
    const a = byId(axes[i])
    if (a) lines.push('第 ' + (i + 1) + ' 条【' + a.id + '】：' + a.hint + '（示例口吻："' + a.eg + '"）；')
  }
  return lines.join('\n')
}

export { AXES, AXIS_IDS, byId, pickAxes, axisOf, distinctAxes, hasNumberedOptions, roleBlock }
