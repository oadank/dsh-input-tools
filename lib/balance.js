/**
 * [XDN 本地占位 · 2026-10-04] —— 这不是本文件的最终形态，拿到真文件请直接覆盖。
 *
 * 为什么会有这个文件：
 *   lib/balance.js 从未提交进 github.com/oadank/dsh-input-tools
 *   （`git log --all -- lib/balance.js` 为空），只存在于 lecoo 的工作副本
 *   C:\D\opt\deepseek-harness\plugins\dsh-input-tools\lib\balance.js。
 *   而 lib/index.js 第 35 行是**静态** import：
 *       import { applyBalance } from './balance.js'
 *   缺文件 = 整个插件加载失败（语音/人设/MCP/Skill 全套一起死），
 *   所以这里先放一个空实现，保证插件能起来。
 *
 * 代价：余额（GET /api/balance，deepseek/gw/ark 三家快照）不可用，其余不受影响。
 * 恢复：把 lecoo 的真 balance.js 拷过来覆盖本文件，然后提交进仓库。
 */

/** 占位实现：余额端点不挂载，只打一条显眼的警告。 */
export function applyBalance() {
  console.warn(
    '[dsh-balance] lib/balance.js 是 XDN 本地占位实现 —— 余额端点未挂载；'
    + '真文件需从 lecoo 工作副本取回并提交进 github.com/oadank/dsh-input-tools',
  )
}
