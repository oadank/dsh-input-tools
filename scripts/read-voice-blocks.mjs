// 解压最新会话日志，检查 voice 块的 transcript
import { readFileSync } from 'node:fs'
import { decompress } from 'fzstd'

const src = process.argv[2]
const bin = readFileSync(src)
const txt = new TextDecoder().decode(decompress(bin))
const lines = txt.split('\n').filter(Boolean)
const marker = '"voice"'
const voices = []
for (const line of lines) {
  if (!line.includes(marker)) continue
  try {
    const ev = JSON.parse(line)
    const blocks = ev?.data?.message?.content ?? ev?.data?.content ?? []
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b.type === 'voice') {
        voices.push({
          seq: ev.seq,
          type: ev.type,
          voiceId: String(b.attachment?.voiceId || '').slice(0, 22),
          transcript: String(b.attachment?.transcript || '(无)').slice(0, 60),
          bytes: b.attachment?.bytes,
        })
      }
    }
  } catch { /* 跳过解析失败行 */ }
}
console.log(JSON.stringify(voices.slice(-8), null, 1))
