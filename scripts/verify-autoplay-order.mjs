// [2026-09-11] Bug1 验证：自动播放顺序（批量到达语音按正序播放）
// 方法：DOM 注入模拟多条 [data-voice-reply] 语音横幅，监听 play 事件，断言播放顺序。
import { createRequire } from 'module'
const require = createRequire('file:///C:/Users/oadan/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/package.json')
const { chromium } = require('playwright-core')

const URL = 'http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4&x=autoplay-order'
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

// 500ms 静音 wav (data URI) —— 足够短让一条播完再播下一条
// 由脚本动态生成 base64 wav
function makeSilentWavBase64(ms = 500, sampleRate = 8000) {
  const numSamples = Math.floor(sampleRate * ms / 1000)
  const byteRate = sampleRate * 2
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  // 静音（全 0），第 44 字节起为数据
  return buf.toString('base64')
}

const wavB64 = makeSilentWavBase64(500)
const wavUri = `data:audio/wav;base64,${wavB64}`

const browser = await chromium.launch({
  executablePath: EXE,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const ctx = await browser.newContext()
const page = await ctx.newPage()

// 注入脚本：拦截 /voice-config GET，返回空 autoPlayedVoiceIds，保证"全部未播"
// 同时也拦截 localStorage 播放标记读取 → 强制视为未播
await page.addInitScript(() => {
  try { localStorage.setItem('dsh.autoPlayAssistantVoice', '1'); } catch {}
  try { localStorage.setItem('dsh.autoPlayedVoiceIds', '[]'); } catch {}
})

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto warn:', e.message))
await page.waitForTimeout(4000)

// 用唯一 ID + 拦截 /voice-config GET 返回空 autoPlayedVoiceIds，彻底隔离服务端缓存
const token = Date.now() + '-' + Math.random().toString(36).slice(2, 6)
await page.route('**/voice-config', async (route) => {
  const req = route.request()
  if (req.method() === 'GET') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ config: { autoPlayedVoiceIds: [] } }) })
  } else {
    await route.continue() // POST 照发（无害）
  }
})
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForTimeout(2500)

const result = await page.evaluate(async ({ wavUri, token }) => {
  const seq = []
  const attachOverlay = () => {
    // 注入容器到 body，构造 3 条语音横幅
    const wrap = document.querySelector('[data-autoplay-test]')
    if (wrap) wrap.remove()
    const container = document.createElement('div')
    container.setAttribute('data-autoplay-test', '1')
    document.body.appendChild(container)
    const ids = [`${token}-A`, `${token}-B`, `${token}-C`]  // 期望正序 A→B→C
    for (const id of ids) {
      const card = document.createElement('div')
      card.setAttribute('data-voice-reply', '1')
      card.setAttribute('data-voice-id', id)
      const audio = document.createElement('audio')
      audio.src = wavUri
      audio.setAttribute('data-test-aud', id)
      audio.addEventListener('play', () => { seq.push(id) })
      card.appendChild(audio)
      container.appendChild(card)
    }
  }
  attachOverlay()

  // 等待 scanAndPlay 的 interval（1500ms）跑几轮，观察 play 顺序
  await new Promise((r) => setTimeout(r, 8000))

  return {
    seq,
    autoPlayAssistantVoice: (() => { try { return localStorage.getItem('dsp.autoPlayAssistantVoice') || localStorage.getItem('dsh.autoPlayAssistantVoice') } catch { return null } })(),
  }
}, { wavUri, token })

console.log('play seq:', JSON.stringify(result.seq))
// 提取批次后缀 A/B/C
const suffixSeq = result.seq.map((s) => s.split('-').pop())
const expected = ['A', 'B', 'C']
const ok = JSON.stringify(suffixSeq) === JSON.stringify(expected)
console.log('expected:', JSON.stringify(expected))
console.log(ok ? 'PASS: 正序播放（旧→新）' : 'FAIL: 顺序不对（可能仍倒序或未触发）')

await page.screenshot({ path: 'C:/D/opt/deepseek-harness/plugins/dsh-input-tools/scripts/autoplay-order.png' }).catch(() => {})
await browser.close()
process.exit(ok ? 0 : 1)
