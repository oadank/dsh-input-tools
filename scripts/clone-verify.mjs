// 验证设置页克隆列表显示小团团
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://127.0.0.1:3080/?token=jFTnIejznnQCS4LDowDVc5Gr8gWxhMtyS0WCziUj0XNTLK_4', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3500)
const settings = page.locator('[aria-label*="设置"]').first()
if (await settings.count() > 0) { await settings.click().catch(() => {}); await page.waitForTimeout(1500) }
const voiceTab = page.getByText('语音服务', { exact: true }).last()
if (await voiceTab.count() > 0) { await voiceTab.click().catch(() => {}); await page.waitForTimeout(1800) }
const body = await page.evaluate(() => document.body.innerText)
const i = body.indexOf('克隆')
console.log('hasClone:', body.includes('MiMo-V2.5-TTS-VoiceClone'))
console.log('hasTTuan:', body.includes('小团团'))
console.log('empty:', body.includes('暂无'))
console.log('snippet:', i >= 0 ? body.slice(i, i + 180) : '(无克隆段)')
await page.screenshot({ path: 'C:/D/opt/clone-restore.png' })
await browser.close()
