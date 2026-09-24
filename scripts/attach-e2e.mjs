// E2E：上传 文件+图片，验证悬浮墙 chip + 缩略图
import { createRequire } from 'module'
import { readFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)
const row = page.locator('text=语音识别测试音频生成标题').first()
if (await row.count() > 0) { await row.click().catch(() => {}); await page.waitForTimeout(3000) }

const setInput = page.locator('[data-composer-card] input[type=file]').first()
console.log('file input count:', await setInput.count())
const jpg = await readFile('C:/D/opt/deepseek-harness/plugins/dsh-input-tools/assets/vision-test.jpg').catch(() => Buffer.from('x'))
await setInput.setInputFiles([
  { name: '测试说明.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  { name: 'vision-test.jpg', mimeType: 'image/jpeg', buffer: jpg },
])
await page.waitForTimeout(2500)
const r = await page.evaluate(() => {
  const body = document.body.innerText || ''
  return {
    hasTxtChip: body.includes('测试说明.txt'),
    thumbCount: document.querySelectorAll('[data-composer-card] img').length,
    removeBtns: Array.from(document.querySelectorAll('[aria-label="移除"]')).length,
  }
})
console.log(JSON.stringify(r, null, 2))
await page.screenshot({ path: 'C:/D/opt/attach-preview.png' })
await browser.close()
