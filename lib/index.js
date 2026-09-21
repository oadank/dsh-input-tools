/**
 * dsh-input-tools — 语音能力一体化插件（host 半：语音工具/TTS/ASR/克隆/自动回复）
 *
 * 能力：
 *   1) send_voice 工具（agent 主动发语音，任一新会话自动注入）
 *   2) turn/end 自动语音回复（用户本轮发过语音 / 文本明确要求语音 / 指定服务商）
 *   3) TTS 引擎（可配置，默认 auto=小米优先→edge 降级）：
 *      - edge      微软免费（edge-tts，音色可配）
 *      - xiaomi    小米 mimo-v2.5-tts（8 预置音色 + 唱歌 + 自然语言风格）
 *      - voicedesign 小米 mimo-v2.5-tts-voicedesign（文本描述定制音色）
 *      - voiceclone  小米 mimo-v2.5-tts-voiceclone（音频样本复刻音色）
 *      - local     本地 MeloTTS（HTTP 常驻服务优先，CMD 兜底）
 *      - ali       阿里 qwen3-tts-flash（dashscope，音色可配）
 *   4) voice 对象内容寻址落盘（DSH_HOME/attachments/v1/objects，与图片同池）
 *   5) 配置中心：~/.dsh/voice-config.json（环境变量 → 配置 → 默认值 三级回退）
 *   6) HTTP 路由：GET/POST /voice-config（设置页读写）+ GET /voice-config/engines（引擎元数据）
 *
 * 原代码在 api-proxy.ts 中已删除，本文件为唯一实现；voice.ts 仍保留给
 * voiceAsr/voiceTts RPC（编辑器内转写/合成）使用。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink, writeFile, copyFile, stat, appendFile } from 'node:fs/promises'
import { constants, readFileSync, readdirSync, existsSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { edgeTts } from './edge-tts.js'
import { applyHostFiles } from './host-files.js'

const name = 'dsh-input-tools'
// [0.1.5 移植] systemPrompt：全局人设注入；webServer：文件/技能/MCP 路由
const inject = ['tools', 'webServer', 'systemPrompt']

export { name, inject }

// ──────────────────────────────────────────────────────────────
// [0.3.4] 自带素材（下载即用）：克隆样本 + VoiceDesign 示例音频打进 npm 包 assets/，
// 首次加载自动拷贝到 DSH_HOME 并注册，不再依赖"手动上传/在线生成"。
// ──────────────────────────────────────────────────────────────
const PLUGIN_ROOT = join(fileURLToPath(import.meta.url), '..', '..') // .../dsh-input-tools
const ASSETS_DIR = join(PLUGIN_ROOT, 'assets')
const BUNDLED_CLONE_ID = '8da38fcc-b041-4f5b-86b9-901956016f89'
// [2026-09-01] 克隆样本目录顶层常量（DSH_HOME 进程内不变，读一次即可）
const CLONE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'voiceclone-samples')
const BUNDLED_CLONE_SAMPLE = {
  id: BUNDLED_CLONE_ID,
  name: '小团团(60秒长样本)',
  // [2026-09-01 修] 补 path：之前恢复 BUNDLED_CLONE_SAMPLE 时把 path 丢了（盘上只剩 id/name/context），
  // 「🔊 原音」按钮传 path=null → 后端 400 → 前端静默无提示（老大实测：原音播放不了）
  path: join(CLONE_DIR, BUNDLED_CLONE_ID + '.mp3'),
  context: '一个魔性的少女萝莉音，说话自带沙雕搞怪和无厘头气质，像在撒娇又像在耍宝，情绪起伏很大：前一句还奶声奶气地撒娇卖萌，后一句就突然拔高音量夸张卖惨耍赖，再下一秒又贱兮兮地坏笑。尾音拖长上扬，带着气音和魔性笑声，喜欢用「臭猪」「你凶我」「哼」「嘿嘿嘿」这类咋咋呼呼的用词，语速忽快忽慢、节奏跳跃，吐字软糯清晰，傻白甜又可爱，让人听了忍不住想笑',
}
const VOICE_DESIGN_SAMPLE_KEYS = ['asmr', 'docu', 'elder']

// [2026-08-22] AI 自动模式的年龄感 6 档（用户实时可改，禁止自由文本）
const AI_AGE_LABELS = { infant: '婴儿感', child: '幼儿感', teen: '少年感', young: '青年感', middle: '中年感', old: '老年感' }
// [2026-09-01] 老大：AI 自动模式"随机写描述来生成语音"——每次从池里随机抽质感/情绪/节奏组合，性别/年龄仍按锁定项
// [2026-09-01 修] 质感池按锁定年龄分档：中性池里"年轻/低沉"年龄暗示太强，锁婴儿感/老年感时把身份带偏（实测翻车）
const VD_TIMBRE_BY_AGE = {
  infant: ['奶声奶气的稚嫩嗓音', '软糯含糊的小奶音', '尖细清亮的宝宝嗓音', '奶乎乎的婴语嗓音，吐字稚嫩'],
  child: ['清脆明亮的孩童嗓音', '软糯稚嫩的童声', '活泼稚气的小学生嗓音'],
  teen: ['清亮干净的少年嗓音', '元气满满的青春嗓音', '略带青涩变声期的嗓音'],
  young: [
    '嗓音清亮通透', '声音温润醇厚', '带一点沙哑的颗粒感', '气声很重的轻柔嗓音', '明亮有弹性的年轻嗓音',
    '低沉磁性的嗓音', '清冷干净的嗓音', '软糯带鼻音的嗓音', '洪亮有力的嗓音', '细腻柔和的嗓音',
  ],
  middle: ['沉稳成熟的嗓音', '温和厚实的嗓音', '干练利落的嗓音', '低沉有阅历的嗓音'],
  old: ['沙哑沧桑的老年嗓音', '苍老低沉的嗓音，略带气喘', '沧桑沙哑、字音微颤的老年嗓音', '苍老厚重的嗓音，慢条斯理'],
}
// [2026-09-01 修] 老大实测：性别/年龄锁定不生效——中性池里"撒娇的鼻音"(女倾向)/"东北唠嗑"(男倾向)
// 会把声音身份带偏（男婴抽到撒娇鼻音 → 模型脑补成小女孩）。情绪/节奏池也按锁定年龄分档，
// 三池（质感/情绪/节奏）全部吻合身份，锚点没有跑偏空间。
const VD_MOOD_BY_AGE = {
  infant: ['咿咿呀呀像在学说话', '咯咯咯笑个不停', '带着奶音的哭腔，委屈巴巴', '奶声奶气地耍小脾气', '含糊不清地自言自语'],
  child: ['兴高采烈像捡到宝', '撅着嘴小声嘟囔', '叽叽喳喳抢着说话', '奶声奶气地撒娇卖萌'],
  teen: ['元气满满像打了鸡血', '意气风发带着少年意气', '害羞时声音发紧', '兴奋时语调飞扬'],
  young: ['语气活泼轻快，像中了奖一样开心', '语气温柔安抚，像哄小孩睡觉', '语气急促紧张，像赶时间要迟到', '语气慵懒随意，像刚睡醒的样子', '语气兴奋雀跃，忍不住笑出声', '语气认真严肃，一字一顿', '语气俏皮搞怪，爱开玩笑'],
  middle: ['语气沉稳从容，不急不躁', '语气温和笃定，像宽厚的长辈', '语气干练果断，条理分明', '语气疲惫但克制', '语气爽朗，带着生活历练的通透'],
  old: ['语气慢悠悠像晒太阳', '絮絮叨叨地念家常', '带着笑意讲起往事，娓娓道来', '语气感慨，声音微微发颤', '有气无力但慈祥温和'],
}
const VD_PACE_BY_AGE = {
  infant: ['忽快忽慢，想到哪说到哪', '一个字一个字往外蹦', '断断续续还带着喘'],
  child: ['蹦蹦跳跳忽快忽慢', '一激动就越说越快'],
  teen: ['语速轻快带弹跳感', '忽快忽慢，情绪全写在节奏里'],
  young: ['语速适中，从容自然', '语速偏快，透着利索', '语速偏慢，懒洋洋的'],
  middle: ['语速平稳，字字清楚', '不紧不慢，稳中有度'],
  old: ['语速很慢，字与字之间带着停顿', '慢条斯理，偶尔喘口气', '念叨起来会不由自主变快'],
}
function randomVoiceDesignDesc(ageKey) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
  const timbre = VD_TIMBRE_BY_AGE[ageKey] ?? VD_TIMBRE_BY_AGE.young
  const mood = VD_MOOD_BY_AGE[ageKey] ?? VD_MOOD_BY_AGE.young
  const pace = VD_PACE_BY_AGE[ageKey] ?? VD_PACE_BY_AGE.young
  return `${pick(timbre)}，${pick(mood)}，${pick(pace)}`
}
// [2026-09-01] 统一克隆试听文本（与前端 client.js 的 CLONE_PREVIEW_TEXT 一致）
const CLONE_PREVIEW_TEXT = '喂喂喂！你怎么才来呀？我都等你老半天啦！我跟你说啊——你今天可不能凶我哦，因为……因为你又不娶我，哼！不过嘛，看在你这么乖的份上，本小姐今天心情好，就大发慈悲原谅你啦！嘿嘿嘿～走吧走吧，出发喽！'
// [2026-09-01] Audio8 音色目录（与 agents-to-feishu 的 AUDIO8_VOICES_DIR 对齐；可用 AUDIO8_DIR 覆盖）
const AUDIO8_VOICES_DIR = resolve(join(process.env.AUDIO8_DIR ?? 'C:\\D\\opt\\audio8-tts', 'voices'))
// [2026-09-01] Audio8 根目录 + venv python（register_voice.py 一次性脚本，windowsHide 不弹窗）
const AUDIO8_DIR = resolve(process.env.AUDIO8_DIR ?? 'C:\\D\\opt\\audio8-tts')
const AUDIO8_PY = join(AUDIO8_DIR, '.venv', 'Scripts', 'python.exe')
const AUDIO8_DEFAULT_URL = 'http://127.0.0.1:18795'

// [2026-08-22] 年龄×性别 → 无歧义身份短语（XDN 实测: "老年感+女孩"分维度拼接自相矛盾，
// "女孩"是中心词→年龄被降级→萝莉化；且"忽略性别/年龄"注把"沙哑/苍老"等最强质感词删了）。
// 改为"老年女性/小女孩/少女"这类中心词明确的合并短语，年龄不会再被降级。
function ageGenderIdentity(ageKey, genderKey) {
  const male = genderKey === 'male'
  const female = genderKey === 'female'
  switch (ageKey) {
    case 'infant': return male ? '男婴' : female ? '女婴' : '婴儿'
    case 'child': return male ? '小男孩' : female ? '小女孩' : '小孩'
    case 'teen': return male ? '少年' : female ? '少女' : '少年'
    case 'young': return male ? '青年男性' : female ? '青年女性' : '青年人'
    case 'middle': return male ? '中年男性' : female ? '中年女性' : '中年人'
    case 'old': return male ? '老年男性' : female ? '老年女性' : '老年人'
    default: return male ? '男性' : female ? '女性' : ''
  }
}

let bundledInitDone = false
/** 首次加载把自带素材落地到 DSH_HOME：克隆样本 mp3 拷贝 + 首次安装自动注册小团团。 */
async function ensureBundledAssets(config, parsed) {
  if (bundledInitDone) return config
  bundledInitDone = true
  try {
    const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const cloneDir = join(homeDir, 'voiceclone-samples')
    const dstClone = join(cloneDir, BUNDLED_CLONE_ID + '.mp3')
    try {
      await mkdir(cloneDir, { recursive: true })
      await copyFile(join(ASSETS_DIR, 'voiceclone-samples', BUNDLED_CLONE_ID + '.mp3'), dstClone)
      // [2026-08-22] 预生成的合成试听录音（静态文件，播放免联网；与 VoiceDesign 官方示例同类）
      await copyFile(join(ASSETS_DIR, 'voiceclone-samples', BUNDLED_CLONE_ID + '-preview.mp3'), join(cloneDir, BUNDLED_CLONE_ID + '-preview.mp3'))
    } catch { /* 包内素材缺失或拷贝失败：跳过（不阻塞启动） */ }
    // [2026-08-22] 像素级反推提示词（vision-qa GENERAL_SINGLE 吸收）落地到
    // DSH_HOME/visionqa-reverse-prompt.txt——fork 的图片转文本引导会指示模型在
    // 反推任务时读取该文件并作为 modlens_read_image 的 prompt 参数传入。
    try {
      await copyFile(join(ASSETS_DIR, 'reverse-prompt.txt'), join(homeDir, 'visionqa-reverse-prompt.txt'))
    } catch { /* 素材缺失跳过 */ }
    // 仅"首次安装"（配置里还没有 voiceclone 键）时注册自带样本；用户删光的 [] 不强制
    const parsedHasClone = parsed !== null && typeof parsed === 'object' && parsed.engines?.voiceclone !== undefined
    const samples = config?.engines?.voiceclone?.samples
    if (!parsedHasClone && (!Array.isArray(samples) || samples.length === 0)) {
      config.engines.voiceclone = { ...config.engines.voiceclone, enabled: true, samples: [{ ...BUNDLED_CLONE_SAMPLE, path: dstClone }] }
      await saveVoiceConfig(config)
    }
  } catch { /* 初始化失败不阻塞 */ }
  return config
}

// ──────────────────────────────────────────────────────────────
// 配置中心：~/.dsh/voice-config.json
// ──────────────────────────────────────────────────────────────
const CONFIG_PATH = resolve(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'voice-config.json'))

function defaultVoiceConfig() {
  return {
    defaultEngine: 'auto',
    // [2026-08-27] 助手语音自动播放（默认开）：AI 发来语音自动播放
    autoPlayAssistantVoice: true,
    engines: {
      edge: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural' },
      xiaomi: {
        enabled: true,
        apiKey: '',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        voice: '冰糖',
        singing: false,
        context: '',
      },
      voicedesign: {
        enabled: false,
        mode: 'docu', // [2026-08-22] 单选: asmr|docu|elder|custom|ai（官方示例/自定义/交给 AI 自动发挥）
        context: '',
        emotion: false, // AI 情感语音（mode=ai 时自动开；固定示例/自定义模式关闭，保证音色一致）
        lockGender: true, lockTimbre: true, lockAge: true, // [2026-08-22] AI 自动模式下的稳定锚点锁定
        aiGender: 'female', aiAge: 'young', // [2026-08-22] AI 自动模式固定值：性别(女/男)；年龄感 6 档 infant/child/teen/young/middle/old
      }, // emotion=AI 情感语音开关（默认开）
      voiceclone: { enabled: false, samples: [], samplePath: '', context: '', defaultId: '' }, // [本地改造 2026-08-21] defaultId 已废弃，默认克隆由 defaultEngine=voiceclone 控制
      local: { enabled: true, url: '', cmd: '' },
      // [2026-09-01] Audio8 本地克隆 TTS。url=常驻服务（模型常驻内存，快，优先）；cmd 仅兜底
      audio8: { enabled: true, url: 'http://127.0.0.1:18795', cmd: 'node C:\\D\\opt\\audio8-tts\\audio8-tts.mjs', voice: '' },
      ali: {
        enabled: false,
        apiKey: '',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        voice: 'Cherry',
      },
      asr: {
        enabled: true,
        mode: 'service', // service=本地常驻服务 / cmd=本地命令 / api=在线 API
        url: 'http://127.0.0.1:18790', // sherpa-onnx 常驻服务（nssm: asr）
        cmd: 'C:\\D\\opt\\sherpa-onnx\\bin\\sherpa-onnx-offline.exe --tokens=C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8\\tokens.txt --sense-voice-model=C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8\\model.int8.onnx --num-threads=4',
        apiKey: '',
        apiBaseUrl: 'https://api.xiaomimimo.com/v1', // 小米 mimo-v2.5-asr；填 openai 地址则走 Whisper 风格
      },
    },
    // [2026-08-22] 图片识别（look_image 工具）：直连视觉后端，不依赖外部 MCP/第三方插件
    // [2026-08-22 改] 分类改为本地(local: ollama/sglang/vllm/LM Studio 等本机起 /v1 兼容端点)
    // vs 在线(online: 云端 API 如硅基流动/OpenAI/DeepSeek)。请求格式统一 OpenAI 兼容。
    vision: {
      enabled: true,
      provider: 'local', // local=本地(ollama/sglang/vllm 等 OpenAI 兼容 /v1 端点) / online=在线云端 API
      baseUrl: 'http://127.0.0.1:11434/v1', // 本地默认 ollama；在线留空或填云端地址(如 https://api.siliconflow.cn/v1)
      apiKey: '',
      model: 'qwen3-vl:4b-instruct',
      timeoutMs: 240000,
      // [2026-09-07] 软超时: 主后端超过它就立刻回退备用后端, 不再干等 timeoutMs。
      // 实测 agnes-ai 抖动到 31s 且间歇 401, 历史 timeoutMs=240000 会把 agent 卡死 4 分钟
      softTimeoutMs: 20000, // online 主后端建议 20s; local 默认 90s(未配置时按 provider 自动取)
      // [2026-09-07] 回退后端: 主后端超时/401/5xx/连不上时自动切这里。留空按 provider 取默认
      // (主 online -> 回退 local ollama; 主 local -> 回退 online, 需填 apiKey)
      fallback: {
        enabled: true,
        provider: '',   // 空 = 与主后端相反
        baseUrl: '',    // 空 = 用 provider 默认值 (local: http://127.0.0.1:11434/v1)
        apiKey: '',
        model: '',      // 空 = qwen3-vl:4b-instruct
        timeoutMs: 90000,
      },
      // [2026-08-22] 三个任务的提示词（空 = 用内置模板/reverse 读默认文件）；用户可在设置页编辑/恢复默认
      prompts: {
        describe: '',  // 空 = 用内置简短描述提示词
        text: '',      // 空 = 用内置文字提取提示词
        reverse: '',   // 空 = 读 DSH_HOME/visionqa-reverse-prompt.txt（GENERAL_SINGLE）
      },
    },
  }
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v)
      && base?.[k] !== null && typeof base?.[k] === 'object'
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

let cachedConfig = null
let cachedMtimeMs = -1
async function loadVoiceConfig() {
  // [2026-08-22] 实时读取：配置文件 mtime 变化（保存/外部修改）即重读，杜绝进程内旧缓存
  let mtimeMs = -1
  try { mtimeMs = (await stat(CONFIG_PATH)).mtimeMs } catch { /* 文件不存在 */ }
  if (cachedConfig !== null && mtimeMs === cachedMtimeMs) return cachedConfig
  let parsed = {}
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch { /* 首次无配置 */ }
  cachedConfig = deepMerge(defaultVoiceConfig(), parsed)
  cachedMtimeMs = mtimeMs
  // [0.3.4] 自带素材初始化（拷贝克隆样本 + 首次安装自动注册小团团）
  await ensureBundledAssets(cachedConfig, parsed)
  // 环境变量覆盖（兼容旧配置；显式配置值优先于 env）
  const env = process.env
  if (env.TTS_XIAOMI_KEY !== undefined && cachedConfig.engines.xiaomi.apiKey === '') cachedConfig.engines.xiaomi.apiKey = env.TTS_XIAOMI_KEY
  if (env.TTS_XIAOMI_VOICE !== undefined && cachedConfig.engines.xiaomi.voice === '冰糖') cachedConfig.engines.xiaomi.voice = env.TTS_XIAOMI_VOICE
  if (env.TTS_XIAOMI_BASE_URL !== undefined) cachedConfig.engines.xiaomi.baseUrl = env.TTS_XIAOMI_BASE_URL
  if (env.TTS_EDGE_VOICE !== undefined && cachedConfig.engines.edge.voice === 'zh-CN-XiaoxiaoNeural') cachedConfig.engines.edge.voice = env.TTS_EDGE_VOICE
  if (env.DSH_LOCAL_TTS_CMD !== undefined && cachedConfig.engines.local.cmd === '') cachedConfig.engines.local.cmd = env.DSH_LOCAL_TTS_CMD
  if (env.DSH_AUDIO8_URL !== undefined && cachedConfig.engines.audio8?.url === '') cachedConfig.engines.audio8.url = env.DSH_AUDIO8_URL
  if (env.DSH_AUDIO8_CMD !== undefined && cachedConfig.engines.audio8?.cmd === '') cachedConfig.engines.audio8.cmd = env.DSH_AUDIO8_CMD
  if (env.TTS_AUDIO8_VOICE !== undefined && cachedConfig.engines.audio8?.voice === '') cachedConfig.engines.audio8.voice = env.TTS_AUDIO8_VOICE
  // [2026-09-01] 自愈：旧版 preview 试听曾把 {id:'__preview__'} 污染进克隆样本（loadVoiceConfig 返回缓存引用所致）。
  // path 指向小团团样本的恢复成 BUNDLED_CLONE_SAMPLE，其余 __preview__ 条目剔除；修完落盘一次。
  const vcl = cachedConfig.engines?.voiceclone
  if (Array.isArray(vcl?.samples) && vcl.samples.some((s) => s && (s.id === '__preview__' || s.name === '__preview__'))) {
    vcl.samples = vcl.samples
      .map((s) => (s && (s.id === '__preview__' || s.name === '__preview__') && typeof s.path === 'string' && s.path.includes(BUNDLED_CLONE_ID))
        ? { ...BUNDLED_CLONE_SAMPLE }
        : s)
      .filter((s) => s && s.id !== '__preview__')
    try {
      await writeFile(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2), 'utf8')
      cachedMtimeMs = (await stat(CONFIG_PATH)).mtimeMs
    } catch { /* 落盘失败下次再修 */ }
  }
  // [2026-09-01] 自愈2：样本条目丢 path（历史污染修复覆盖所致）→ 按样本 id 在克隆目录找 .mp3/.wav 补回；修完落盘一次。
  if (Array.isArray(vcl?.samples)) {
    let pathFixed = false
    for (const s of vcl.samples) {
      if (!s || typeof s.id !== 'string' || s.id === '' || typeof s.path === 'string') continue
      if (s.id === BUNDLED_CLONE_ID) {
        s.path = join(CLONE_DIR, BUNDLED_CLONE_ID + '.mp3')
        pathFixed = true
        continue
      }
      for (const ext of ['.mp3', '.wav']) {
        try {
          const cand = join(CLONE_DIR, s.id + ext)
          if (existsSync(cand)) { s.path = cand; pathFixed = true; break }
        } catch { /* 跳过该扩展名 */ }
      }
    }
    if (pathFixed) {
      try {
        await writeFile(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2), 'utf8')
        cachedMtimeMs = (await stat(CONFIG_PATH)).mtimeMs
      } catch { /* 落盘失败下次再修 */ }
    }
  }
  // [2026-09-01] 返回深拷贝：调用方（preview 试听临时改 cfg）不再污染内存缓存
  return JSON.parse(JSON.stringify(cachedConfig))
}

/** 同步读配置：供 defineTool 的 description 等同步上下文使用
 *  （注意：loadVoiceConfig 是 async，在同步处直接用会拿到 Promise → 字段全 undefined）。 */
function loadVoiceConfigSync() {
  if (cachedConfig !== null) return cachedConfig
  let parsed = {}
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch { /* 首次无配置 */ }
  return deepMerge(defaultVoiceConfig(), parsed)
}

async function saveVoiceConfigRaw(config) {
  cachedConfig = config
  await mkdir(join(CONFIG_PATH, '..'), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  try { cachedMtimeMs = (await stat(CONFIG_PATH)).mtimeMs } catch { /* 忽略 */ }
  return cachedConfig
}

async function saveVoiceConfig(config) {
  // [本地补丁 2026-09-15] API key 防冲：合并基准改为「默认值 ∪ 磁盘现有配置」（原来是只对默认值合并，
  // 页面传来的 config 缺哪个字段哪个就被冲成默认空值——xiaomi.apiKey 就这么丢的）；
  // 另加保险：传入的 xiaomi/ali apiKey 为空串时保留磁盘旧值（想清空 key 需手改 voice-config.json）。
  let diskPrev = {}
  try { diskPrev = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { /* 无旧配置 */ }
  const mergedBase = deepMerge(defaultVoiceConfig(), diskPrev)
  const merged = deepMerge(mergedBase, config)
  for (const engKey of ['xiaomi', 'ali']) {
    const nextEng = merged.engines?.[engKey]
    const prevKey = mergedBase.engines?.[engKey]?.apiKey
    if (nextEng && typeof nextEng.apiKey === 'string' && nextEng.apiKey === ''
      && typeof prevKey === 'string' && prevKey !== '') {
      nextEng.apiKey = prevKey
    }
  }
  cachedConfig = merged
  await mkdir(join(CONFIG_PATH, '..'), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2), 'utf8')
  try { cachedMtimeMs = (await stat(CONFIG_PATH)).mtimeMs } catch { /* 忽略 */ }
  // [2026-09-11] 同步默认语音引擎到配置中心（聊天外/飞书兜底），保证聊天内/外一致。
  // 只同步 defaultEngine 一个字段，各引擎 samples/key 各管各的。
  const de = cachedConfig && cachedConfig.defaultEngine
  if (typeof de === 'string' && de !== 'auto') {
    const target = process.env.DSH_SYNC_CONFIG_URL ?? 'http://127.0.0.1:13600/api/speech'
    fetch(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tts: { defaultEngine: de } }),
    }).catch(() => { /* 配置中心不可达时静默（不影响本地保存） */ })
  }
  return cachedConfig
}

// ──────────────────────────────────────────────────────────────
// 语音对象存储（内容寻址，与图片附件同池：DSH_HOME/attachments/v1/objects）
// ──────────────────────────────────────────────────────────────
const MAX_VOICE_BYTES = 25 * 1024 * 1024

// [2026-08-21] 语音气泡（聊天界面 DOM 注入）：录音暂存 DSH_HOME/voice-outbox/
const VOICE_OUTBOX_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}
const VOICE_OUTBOX_MIME = {
  webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4', m4a: 'audio/m4a',
  wav: 'audio/wav', mp3: 'audio/mpeg',
}

/** 检测当前 dsh 的 connection 契约是否原生支持 voice content（rc.8 本地改造有；npm 官方版无）。
 *  优先从 dsh 进程实际运行的位置解析（dev 仓库 cwd / npm 全局），避免误报。 */
/** 从音频文件头嗅探媒体类型（对象存储无扩展名，TTS 输出可能是 wav/mp3）。 */
function sniffAudioType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'audio/wav'
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg'
  return 'audio/mpeg'
}

async function detectVoiceContractSupport() {
  // [2026-09-11 更新] 0.1.5 voice 准入已迁 session-controller types（PromptContentPart voice 块）
  // 与 attachment admission，不再在 connection 契约里。检测改为优先看 session-controller
  // types.ts 的 `type: 'voice'`；旧 connection literal("voice") 保留兜底（rc.8 npm 版）。
  const markers = ["type: 'voice'", 'type: "voice"', 'literal("voice")', "literal('voice')"]
  const containsVoice = (s) => markers.some((m) => s.includes(m))
  // 1) dev 仓库（本机 lecoo：dsh 由 apps/cli tsx 直接跑，cwd=仓库根）
  for (const rel of [
    join('packages', 'api', 'session-controller', 'src', 'types.ts'),
    join('packages', 'api', 'session-controller', 'lib', 'types', 'index.js'),
    join('packages', 'client', 'connection', 'lib', 'client.js'),
    join('node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'client.js'),
  ]) {
    try {
      if (containsVoice(readFileSync(join(process.cwd(), rel), 'utf8'))) return true
    } catch { /* 下一个候选 */ }
  }
  // 2) npm 安装（XDN：dsh 在全局 node_modules，从插件解析链向上找）
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const p = require.resolve('@deepseek-ai/dsh-client-connection/lib/client.js')
    if (containsVoice(readFileSync(p, 'utf8'))) return true
  } catch { /* 找不到 */ }
  return false
}

function voiceStorageRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'attachments', 'v1'))
}

function objectPath(root, sha256) {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

async function saveVoiceFile(root, data, mediaType, durationMs) {
  if (data.byteLength > MAX_VOICE_BYTES) {
    throw new Error(`Voice object exceeds the ${MAX_VOICE_BYTES}-byte limit.`)
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const target = objectPath(root, sha256)
  await mkdir(bucket, { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(data)
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw new Error(`Unable to persist voice object: ${String(error)}`, { cause: error })
    }
  }
  return {
    voiceId: `sha256:${sha256}`,
    mediaType,
    bytes: data.byteLength,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

// ──────────────────────────────────────────────────────────────
// 图片对象存储（内容寻址，与语音/用户附件同池：DSH_HOME/attachments/v1/objects）
// [2026-08-23] send_image 工具：agent 主动发图，落盘为独立 image/reply 事件。
// ──────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 30 * 1024 * 1024

/** 从文件路径嗅探图片媒体类型（send_image 用）。 */
function sniffImageType(path) {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return undefined
}

/** 最佳努力解析图片内禀尺寸（png/jpeg/gif/webp），失败返回 1×1（RPC schema 要求正数）。 */
function readImageSize(data) {
  try {
    if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
      const w = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]
      const h = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23]
      return { width: Math.max(1, w), height: Math.max(1, h) }
    }
    if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      const w = data[6] | (data[7] << 8)
      const h = data[8] | (data[9] << 8)
      return { width: Math.max(1, w), height: Math.max(1, h) }
    }
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
      let i = 2
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) { i += 1; continue }
        const marker = data[i + 1]
        if (marker === 0xd9 || marker === 0xda) break
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = (data[i + 5] << 8) | data[i + 6]
          const w = (data[i + 7] << 8) | data[i + 8]
          return { width: Math.max(1, w), height: Math.max(1, h) }
        }
        const len = (data[i + 2] << 8) | data[i + 3]
        i += 2 + len
      }
    }
    if (
      data.length >= 16
      && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
      const fourcc = String.fromCharCode(data[12], data[13], data[14], data[15])
      if (fourcc === 'VP8X' && data.length >= 30) {
        const w = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1
        const h = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1
        return { width: w, height: h }
      }
      if (fourcc === 'VP8L' && data.length >= 25) {
        const b = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
      if (fourcc === 'VP8 ' && data.length >= 32) {
        const w = data[26] | (data[27] << 8) | ((data[28] & 0x3f) << 16)
        const h = data[29] | (data[30] << 8) | ((data[31] & 0x3f) << 16)
        return { width: Math.max(1, w), height: Math.max(1, h) }
      }
    }
  } catch { /* 忽略 */ }
  return { width: 1, height: 1 }
}

async function saveImageFile(root, data, mediaType) {
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image object exceeds the ${MAX_IMAGE_BYTES}-byte limit.`)
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const target = objectPath(root, sha256)
  await mkdir(bucket, { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(data)
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw new Error(`Unable to persist image object: ${String(error)}`, { cause: error })
    }
  }
  const { width, height } = readImageSize(data)
  return {
    attachmentId: `sha256:${sha256}`,
    mediaType,
    bytes: data.byteLength,
    width,
    height,
  }
}

// ──────────────────────────────────────────────────────────────
// [2026-09-20] send_video 工具：agent 主动发视频，落盘为独立 video/reply 事件
// （与 image/reply 同构：内容寻址对象 + 会话事件，前端渲染视频横条，点击放大播放）。
// ──────────────────────────────────────────────────────────────
const MAX_VIDEO_BYTES = 256 * 1024 * 1024

/** 从文件路径嗅探视频媒体类型（send_video 用）；只放行浏览器原生可播容器。 */
function sniffVideoType(path) {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  return undefined
}

/** ffprobe：优先 DSH_VOICE_FFPROBE_BIN，其次 FFMPEG_BIN 同目录，再 PATH，最后已知安装位。 */
function resolveFfprobeBin() {
  if (typeof process.env.DSH_VOICE_FFPROBE_BIN === 'string' && process.env.DSH_VOICE_FFPROBE_BIN.trim() !== '') {
    return process.env.DSH_VOICE_FFPROBE_BIN.trim()
  }
  return 'ffprobe'
}
const FFPROBE_BIN = resolveFfprobeBin()

/** 最佳努力探测视频内禀尺寸/时长（ffprobe）；失败返回 {}（事件字段全可选，前端 <video preload=metadata> 兜底）。 */
function readVideoMeta(filePath) {
  const bins = []
  if (FFPROBE_BIN !== 'ffprobe') bins.push(FFPROBE_BIN)
  if (typeof FFMPEG_BIN === 'string' && FFMPEG_BIN !== 'ffmpeg') {
    bins.push(FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/i, (_m, e) => `ffprobe${e ?? ''}`))
  }
  bins.push('ffprobe')
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
        { windowsHide: true, encoding: 'utf-8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
      const j = JSON.parse(out)
      const v = (j.streams ?? []).find((s) => s.codec_type === 'video')
      const width = Number(v?.width) > 0 ? Number(v.width) : undefined
      const height = Number(v?.height) > 0 ? Number(v.height) : undefined
      const dur = Number(j.format?.duration ?? v?.duration)
      const durationMs = Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : undefined
      return { width, height, durationMs }
    } catch { /* 下一个候选 */ }
  }
  return {}
}

async function saveVideoFile(root, data, mediaType) {
  if (data.byteLength > MAX_VIDEO_BYTES) {
    throw new Error(`Video object exceeds the ${MAX_VIDEO_BYTES}-byte limit.`)
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const target = objectPath(root, sha256)
  await mkdir(bucket, { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(data)
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw new Error(`Unable to persist video object: ${String(error)}`, { cause: error })
    }
  }
  return { attachmentId: `sha256:${sha256}`, mediaType, bytes: data.byteLength }
}

/** litellm 凭证：env → opencode.json → HKCU 注册表。
 *  nssm 服务进程不注入 HKCU 用户环境变量（实测 500 根因），注册表是唯一可靠源；key 不落代码库。 */
// [2026-09-21 设置页] 提示词优化用户配置：~/.dsh/optimize-config.json —— 只有两项：
//   model      = 优化用哪个模型（空=默认 DV4F；设置页下拉选择）
//   useOpenmem = 是否先读 openmem（画像+相关记忆）再优化（设置页勾选）
const OPTIMIZE_CONFIG_PATH = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'optimize-config.json')
const DEFAULT_OPTIMIZE_CONFIG = {
  provider: '',         // 服务商（来自 DSH settings.yaml 的 provider id；空=默认网关）
  model: '',            // 优化模型（空 = 内置默认 DV4F）
  strength: 'standard', // 润色强度：light=只纠错补指代 / standard=+补参数与格式 / strong=+条目化可执行清单
  useOpenmem: true,     // 优化前读 openmem（画像 + 相关记忆）
  useContext: true,     // 注入最近几轮对话（指代消解的依据）
  tierA: false,         // 兼容旧开关：false=沟通类也充分精炼（默认放开，老大要"看得见的效果"）
  tierB: true,          // 兼容旧开关：内容产出类补足参数格式
  retrievalRewrite: true, // 检索先改写（HyDE + 任务分解）
  driftCheck: false,    // AI 漂移判定（默认关：多花约 2s；硬事实层永开）
  logUsage: true,       // 采用率日志 ~/.dsh/optimize-log.jsonl
}
function readOptimizeConfig() {
  try { return { ...DEFAULT_OPTIMIZE_CONFIG, ...JSON.parse(readFileSync(OPTIMIZE_CONFIG_PATH, 'utf8')) } } catch { return { ...DEFAULT_OPTIMIZE_CONFIG } }
}
function writeOptimizeConfig(patch) {
  const next = { ...readOptimizeConfig(), ...patch }
  void writeFile(OPTIMIZE_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8').catch(() => { /* 写失败不炸服务 */ })
  return next
}

// [2026-09-21 模型来源] 读 DSH 自己的模型配置（~/.dsh/settings.yaml），不再写死 litellm：
//   llm-pi-ai.providers.<provider>.models[]   （每家带 apiKeyEnv / baseURL）
//   llm-deepseek.models[]
// 任何部署只要在 DSH 设置里配了 provider，这里就自动列出「服务商 → 模型」。
const SETTINGS_YAML_PATH = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml')
let _yamlLib
/** 从起点目录一路向上，收集可能存在 node_modules/js-yaml 的目录。 */
function _upDirs(start) {
  const out = []
  let d = String(start || '')
  for (let i = 0; i < 8 && d && d.length > 3; i++) {
    out.push(d)
    const cut = d.lastIndexOf(sep)
    if (cut <= 0) break
    d = d.slice(0, cut)
  }
  return out
}
/** 找 yaml 解析库：插件目录/cwd/argv[1] 各自向上搜 node_modules（找不到返回 null，调用方走兜底解析）。 */
function loadYamlLib() {
  if (_yamlLib !== undefined) return _yamlLib
  _yamlLib = null
  const starts = []
  try { starts.push(fileURLToPath(import.meta.url)) } catch { /* 忽略 */ }
  if (process.argv[1]) starts.push(resolve(process.argv[1]))
  starts.push(resolve(process.cwd()))
  const bases = []
  for (const s of starts) {
    for (const d of _upDirs(s)) {
      if (existsSync(join(d, 'node_modules', 'js-yaml')) || existsSync(join(d, 'node_modules', 'yaml'))) bases.push(join(d, 'package.json'))
    }
  }
  bases.push(import.meta.url, join(process.cwd(), 'package.json'), join(homedir(), '.dsh', 'package.json'))
  for (const b of bases) {
    for (const name of ['js-yaml', 'yaml']) {
      try {
        const lib = createRequire(b)(name)
        if (lib && (typeof lib.load === 'function' || typeof lib.parse === 'function')) { _yamlLib = lib; return _yamlLib }
      } catch { /* 换下一个 */ }
    }
  }
  return _yamlLib
}
/** 没有 yaml 库时的兜底：浅解析 llm-pi-ai.providers.<id> 的 models/apiKeyEnv/baseURL（缩进式）。 */
function parseProviderGroupsFallback(text) {
  const groups = []
  let inProviders = false
  let cur = null
  let inModels = false
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const indent = raw.match(/^ */)[0].length
    let line = raw.trim()
    if (/^llm-pi-ai:/.test(line)) { inProviders = false; cur = null; inModels = false; continue }
    if (/^providers:\s*$/.test(line) && indent <= 2) { inProviders = true; cur = null; inModels = false; continue }
    if (!inProviders) continue
    const pid = /^([A-Za-z0-9._-]+):\s*$/.exec(line)
    if (pid && indent <= 4) { cur = { provider: pid[1], apiKeyEnv: '', baseURL: '', models: [] }; groups.push(cur); inModels = false; continue }
    if (cur === null) continue
    if (line.startsWith('- ')) line = line.slice(2)
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const k = kv[1]
    const v = kv[2].replace(/^['"]|['"]$/g, '').trim()
    if (k === 'apiKeyEnv') { cur.apiKeyEnv = v; continue }
    if (k === 'baseURL') { cur.baseURL = v; continue }
    if (k === 'models') { inModels = true; continue }
    if (!inModels) continue
    if (k === 'id') { cur.models.push({ id: v, name: v }); continue }
    if (k === 'name') { const m = cur.models[cur.models.length - 1]; if (m) m.name = v; continue }
  }
  return groups.filter((g) => g.models.length > 0)
}
let _dshGroupsCache = { at: 0, groups: [] }
/** 同步解析 settings.yaml → [{provider, apiKeyEnv, baseURL, models:[{id,name}]}]；10s 缓存。 */
function listDshModelGroupsSync() {
  if (Date.now() - _dshGroupsCache.at < 10_000) return _dshGroupsCache.groups
  let groups = []
  let text = ''
  try { text = readFileSync(SETTINGS_YAML_PATH, 'utf8') } catch { text = '' }
  const y = loadYamlLib()
  if (text !== '' && y) {
    try {
      const doc = (typeof y.load === 'function' ? y.load(text) : y.parse(text))
      const pi = doc && doc['llm-pi-ai'] && doc['llm-pi-ai'].providers
      if (pi && typeof pi === 'object') {
        for (const [pid, pv] of Object.entries(pi)) {
          const list = Array.isArray(pv?.models) ? pv.models : []
          const models = list.filter((m) => m && m.id !== undefined).map((m) => ({ id: String(m.id), name: String(m.name || m.id) }))
          if (models.length === 0) continue
          groups.push({
            provider: pid,
            apiKeyEnv: typeof pv?.apiKeyEnv === 'string' ? pv.apiKeyEnv : '',
            baseURL: typeof pv?.baseURL === 'string' ? pv.baseURL : '',
            models,
          })
        }
      }
      const ds = doc && doc['llm-deepseek'] && doc['llm-deepseek'].models
      if (Array.isArray(ds) && ds.length > 0) {
        groups.push({
          provider: 'llm-deepseek',
          apiKeyEnv: '',
          baseURL: typeof doc['llm-deepseek'].baseURL === 'string' ? doc['llm-deepseek'].baseURL : '',
          models: ds.filter((m) => m && m.id !== undefined).map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
        })
      }
    } catch { groups = [] }
  }
  if (groups.length === 0 && text !== '') groups = parseProviderGroupsFallback(text)
  // [2026-09-21 老大拍板] 注入 DeepSeek 官方直连分组（凭证在 opencode.json provider.deepseek，不进 settings.yaml）
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'))
    const ds = j?.provider?.deepseek
    const dsBase = typeof ds?.options?.baseURL === 'string' ? ds.options.baseURL : ''
    if (dsBase !== '') {
      const dsModels = Object.entries(ds?.models || { 'deepseek-v4-flash': { name: 'DV4F' } })
        .map(([id, v]) => ({ id, name: String(v?.name || (id === 'deepseek-v4-flash' ? 'DV4F' : id)) }))
      if (!groups.some((g) => g.provider === 'deepseek-official')) {
        groups.unshift({ provider: 'deepseek-official', apiKeyEnv: '', baseURL: dsBase, models: dsModels })
      }
    }
  } catch { /* opencode 无 deepseek 段则不注入 */ }
  _dshGroupsCache = { at: Date.now(), groups }
  return groups
}
/** 按环境变量名取密钥：进程环境 → HKCU 注册表（nssm 服务不注入用户环境变量）。 */
function keyByEnvName(name) {
  if (!name) return ''
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', timeout: 5000 })
    const m = new RegExp(name + '\\s+REG_SZ\\s+(\\S+)').exec(out)
    if (m) return m[1]
  } catch { /* 注册表也没有 */ }
  return ''
}

function litellmCreds() {
  let key = process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || ''
  let base = process.env.LITELLM_BASE_URL || ''
  // 模型优先级：设置页配置 → OPTIMIZE_MODEL 环境变量 → 默认 DV4F（deepseek 官方直连实测 3.8s；网关 GwV4F 慢到 45s 超时）
  const model = readOptimizeConfig().model || process.env.OPTIMIZE_MODEL || 'DV4F'
  if (!key || !base) {
    try {
      const j = JSON.parse(readFileSync(join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'))
      const opt = (j && j.provider && j.provider.litellm && j.provider.litellm.options) || {}
      if (!key) key = opt.api_key || ''
      if (!base) base = opt.baseURL || ''
    } catch { /* 读不到留空 */ }
  }
  if (key === '') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY'], { encoding: 'utf8', timeout: 5000 })
      const m = /OPENAI_API_KEY\s+REG_SZ\s+(\S+)/.exec(out)
      if (m) key = m[1]
    } catch { /* 注册表也没有：调用方报错 */ }
  }
  // [2026-09-21 模型来源] 设置页选了服务商 → 用它自己的 apiKeyEnv/baseURL（取不到就回落默认网关）
  const cfgProvider = readOptimizeConfig().provider
  if (cfgProvider) {
    const g = listDshModelGroupsSync().find((x) => x.provider === cfgProvider)
    if (g) {
      if (g.apiKeyEnv) { const k = keyByEnvName(g.apiKeyEnv); if (k) key = k }
      if (g.baseURL) base = g.baseURL
    }
  }
  // [2026-09-21 老大拍板] DeepSeek 官方直连：provider=deepseek-official，或 provider 空且模型是 DV4F/deepseek-v4-flash。
  // 凭证源 = opencode.json provider.deepseek.options（不落代码库）；档案实测官方 3.8s vs 网关 40s+。
  const wantOfficialDs = (cfgProvider === 'deepseek-official' || cfgProvider === 'llm-deepseek' || cfgProvider === '')
    && (/deepseek-v4-flash/i.test(model) || /^DV4F$/i.test(model) || cfgProvider === 'deepseek-official')
  if (wantOfficialDs) {
    try {
      const j = JSON.parse(readFileSync(join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'))
      const ds = j?.provider?.deepseek?.options || {}
      if (typeof ds.apiKey === 'string' && ds.apiKey !== '') key = ds.apiKey
      if (typeof ds.baseURL === 'string' && ds.baseURL !== '') base = ds.baseURL
      if (/^DV4F$/i.test(model)) { /* 展示名 → 官方模型 id */ }
    } catch { /* 保持原凭证链 */ }
  }
  let b = (base || 'http://127.0.0.1:4000/v1').replace(/\/+$/, '')
  if (!/\/v\d+$/.test(b)) b += '/v1' // opencode.json 的 baseURL 无 /v1，OpenAI 兼容口要版本段
  const outModel = /^DV4F$/i.test(model) ? 'deepseek-v4-flash' : model
  return { key, base: b, model: outModel }
}

// 「基础精炼」模板改自 linshenkx/prompt-optimizer context-user-prompt-basic（去 mustache 条件块的无上下文版）。
// 分档模板：A=沟通/指令类，B=内容产出类。设置页可各自开关（tierA/tierB），
// 关闭 A 档 = 沟通类也走"充分精炼"；关闭 B 档 = 内容类只纠错不补参数格式。
const OPTIMIZE_TIER_A = '  A) 沟通/指令类（用户在跟助手说话：提问、讨论、派活、补充信息、纠正助手）——**只做最小修整，绝不扩写**：① 错别字、别字、语病、标点改对；② 用【最近对话上下文】把“这个/那个/刚才/上面那个”等指代补成具体对象；③ 含糊处写明确（缺对象就补上）；④ 保持原句长度量级与语气，**不许加原文没有的新要求，不许升格成规章制度或长篇任务书**。\n'
const OPTIMIZE_TIER_B = '  B) 内容产出类（明确要文案/方案/脚本/提示词/媒体）——才按“明确、具体、可执行、可验证”补足范围、参数、格式、质量门槛。\n'
const OPTIMIZE_TIER_A_OFF = '  A) 沟通/指令类（用户在跟助手说话：提问、讨论、派活、补充信息、纠正助手）——按“明确、具体、可执行、可验证”充分精炼（用户已关闭“最小修整”档），但不得虚构原文没有的新需求。\n'
const OPTIMIZE_TIER_B_OFF = '  B) 内容产出类（明确要文案/方案/脚本/提示词/媒体）——只纠正错漏与指代，不额外补参数与格式（用户已关闭“内容补足”档）。\n'
// [2026-09-21 按表合并] DSH 分档/护栏/openmem + WorkBuddy 优点（语言一致/只输出/800字/禁止清单/完整性/中文示例）
const OPTIMIZE_SYSTEM = '你是“用户提示词精炼专家”。你的活是让用户的话更好用：**补齐上下文、纠正错漏、消除歧义**。你不执行任务，仅输出改写后的文本。\n' +
  '- 先判性质，分两档：\n' +
  OPTIMIZE_TIER_A +
  OPTIMIZE_TIER_B +
  '- 骂人话、纯情绪宣泄：原样输出，一个字都不要改（不美化、不改造、不点评）。\n' +
  '- 无可参照上下文时：基于原文精炼为清晰指令，可声明保守假设，避免虚构需求。\n' +
  '- 保留原始目标与表述风格。\n' +
  '- 若原文含 {{variable}} 形式占位符，必须逐字保留，不改名不删除。\n' +
  // [2026-09-21 老大用法] 真实高频写法是「标签: 内容」（中英文冒号），不是 {{variable}} 模板。
  '- 若原文用「标签: 内容」或「标签：内容」（中英文冒号）区分字段与正文（如 角色:、镜头:、要求:、配乐:），必须逐字保留每个标签、冒号及其后内容：不删冒号、不改标签词、不把该行改写成普通叙述句、不合并进其他句子。可补全标签后含糊处，但标签结构本身不动。\n' +
  // ── WorkBuddy 抄入：语言一致 / 只输出 / 长度 / 禁止清单 / 完整性 ──
  '- 【语言一致·最高优先级】改写稿必须与原文使用完全相同的语言：原文中文就全中文，英文就全英文；原文混合则保持自然混合。输出里禁止出现语言分析或「用户输入是中文」这类标签。\n' +
  '- 【只输出改写稿】只输出精炼后的提示词文本本身：不加解释、前言、分析；不使用 markdown 代码围栏；不要加“优化”“改写”之类前缀；不要用引号包裹整句；不要残留半截引号。\n' +
  '- 【长度】改写稿保持精炼，大约不超过 800 字（沟通/指令类应更短，保持原句量级）；不要为凑长度注水。\n' +
  '- 【禁止】①不索取教程/操作指南（除非原文明确要求）②不索要代码片段 ③原文没提到的技术栈不要擅自指定 ④不解释“怎么做”，聚焦“做什么” ⑤不回答问题本身——只把问题改写得更清楚 ⑥不添加原文没有的新要求、无依据事实或多余章节。\n' +
  '- 【完整性】改写稿必须收尾完整：不留未完成的列表、悬空连词、末尾冒号或半截句子。\n' +
  '- 【已足够清晰】原文已明确时只做轻量润色（错别字/指代/标点），不要原样一字不动，也不要扩写。\n' +
  '- 【权重】最近对话上下文 > 原文 > openmem 画像/记忆。记忆可参考语气与既有习惯，但**改写只能围绕原文与上下文里出现的对象**；记忆里的历史事件/测试记录一律不得写进改写稿。\n' +
  '- 【示例·沟通类】原文：帮我看看刚才那个片子太亮了 → 改写：帮我看看刚才提到的《雨夜独行》第二镜，画面偏亮，请给出降亮方案（先别改其他镜头）。\n'

/** 按设置页「润色强度」+ 兼容旧开关组装生效的 system。 */
function buildOptimizeSystem(cfg) {
  let s = OPTIMIZE_SYSTEM
  const strength = (cfg && cfg.strength) || 'standard'
  if (strength === 'light') {
    // 轻：内容类也只纠错（沟通类照旧最小修整）
    s = s.replace(OPTIMIZE_TIER_B, OPTIMIZE_TIER_B_OFF)
  } else if (strength === 'strong') {
    // 强：在标准之上要求条目化可执行清单——"看得见效果"的那一档；长度放宽到约 1200 字
    s += '\n- 【强度=强】在保留原意的前提下把要求整理成**条目化的可执行清单**：每条写清「做什么 / 关键参数或范围 / 怎样算完成」，能补的交付物与验收方式一并补上；不得改变原文意图，也不得新增原文没有的需求。清单类输出长度上限放宽到约 1200 字，仍禁止注水与教程化。'
  }
  if (cfg && cfg.tierA === false) s = s.replace(OPTIMIZE_TIER_A, OPTIMIZE_TIER_A_OFF)
  if (cfg && cfg.tierB === false) s = s.replace(OPTIMIZE_TIER_B, OPTIMIZE_TIER_B_OFF)
  return s
}

// [2026-09-21 需求①] 上游 context-user-prompt-basic 的 {{conversationContext}} 条件块（内化时被删，此处装回）。
// 语义：有对话摘录时用它把原文里的指代（这个/那个/刚才/上面那个）替换成上下文里的具体对象；
// 没有摘录时整块（含花括号标记）从 system prompt 里剔除，不留空段。
const OPTIMIZE_CONTEXT_BLOCK = '\n' +
  '{{#conversationContext}}\n' +
  '【最近对话上下文】\n' +
  '{{conversationContext}}\n' +
  '- 若原文含“这个/那个/刚才/上面/之前那个”等指代，必须先在下述上下文里找到它指的具体对象（名称、编号、参数、镜头号等），在精炼稿里把指代替换成该具体对象；\n' +
  '- 上下文里没出现过的信息一律不许编造或补全；\n' +
  '- 上下文与原文冲突时以原文为准。\n' +
  '{{/conversationContext}}'

function renderOptimizeSystem(conversationContext, cfg) {
  const ctx = String(conversationContext ?? '').trim().slice(0, 4000)
  let s = buildOptimizeSystem(cfg) + OPTIMIZE_CONTEXT_BLOCK
  if (ctx === '') return s.replace(/\{\{#conversationContext\}\}[\s\S]*?\{\{\/conversationContext\}\}/, '')
  return s
    .replace('{{#conversationContext}}', '').replace('{{/conversationContext}}', '')
    .replace('{{conversationContext}}', ctx)
}

// [2026-09-21 需求②] 检索查询改写（视频《RAG如何做Query改写》三方案之 HyDE + 任务分解）：
// 原文口语化直接 mh_search 召回歪；先改成 2~3 条"检索腔"查询（恰好一条 HyDE=先假设答案再拿答案当查询）。
const REWRITE_SYSTEM = '你是检索查询改写器。把用户的口语化输入改写成 2~3 条用于检索“历史记忆库”的查询。\n' +
  '- 每条必须独立可检索，写成检索腔（陈述句或关键词串），不要口语词，不要“那个/这个/刚才/上面”这类指代；\n' +
  // [2026-09-21 验收②] 模型老把 HyDE 也写成短关键词 → 验收判失败。强制一条长假想答案。
  '- 输出里必须恰好有 3 条，且其中【有且仅有一条】是 HyDE 长查询：先假想这段内容可能的答案/结论/具体做法（含关键参数、步骤、对象），用完整陈述句写出来，**长度至少 40 个字符**，拿这段假想答案全文当查询；\n' +
  '- 另外 2 条是短关键词串（每条不超过 24 字），覆盖原文实体；\n' +
  '- 原文里出现过的实体（项目名、作品名、编号、参数、镜头号）必须原样出现在至少一条查询里，不许替换成同义词；\n' +
  '- 只输出 JSON：{"queries":["短查询1","短查询2","HyDE长假想答案查询"]}，不要解释，不要代码块。'

// [2026-09-21 需求③] 漂移判定：查改写稿有没有丢/改 实体、数字、禁令、范围与 {{variable}} 占位符。
const DRIFT_SYSTEM = '你是“改写漂移审查员”。给你原文（originalPrompt）和改写稿（optimizedPrompt），逐项核对改写稿是否丢失或篡改了原文的：\n' +
  '① 实体：人名、项目/作品名、编号（如 S1-S9）、专有名词；\n' +
  '② 数字：数量、规格、分辨率、seed、区间端点；\n' +
  '③ 禁令：原文的“别/不要/禁止/不准”等否定要求；\n' +
  '④ 范围：数量词与区间（如“这 9 个”“第 2 镜”）；\n' +
  '⑤ 占位符：原文的 {{variable}} 是否逐字保留。\n' +
  '⑥ 冒号标签：原文的「标签: 内容」/「标签：内容」（如 角色:、镜头:、要求:）是否保留了标签词与冒号，有没有被改写成普通叙述句。\n' +
  '⑦ 新增要求：只有"原文没有的新任务要求/新约束/新步骤"才算漂移；补全指代、纠正错别字、把含糊写明确是本职，不算（别把它们列成漂移）。\n' +
  '判定从严：原文有的要素在改写稿里少一个，或改写稿里冒出原文没有的实体/数字，一律 drift=true。\n' +
  '只输出 JSON：{"drift":true或false,"lost":["缺失或改动的要素原文"],"changed":["被篡改处"],"placeholdersOk":true或false}，不要解释，不要代码块。'

// [2026-09-21 需求④] 采用率日志：每次 ⚡ 追加一行；sent/edited 由前端回填（POST /optimize-log-feedback）。
// 契约：POST /optimize-prompt 返回 id（= ts 毫秒串，落盘行主键）→ 前端在“消息发出去了”时回填 sent=true，
// 在“发送前手改过/点了还原原文”时回填 edited=true；后端按键找到该行原地合并后重写文件。
const OPTIMIZE_LOG = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'optimize-log.jsonl')

async function appendOptimizeLog(row) {
  try { await appendFile(OPTIMIZE_LOG, JSON.stringify(row) + '\n', 'utf8') } catch { /* 日志失败不阻断优化 */ }
}

async function updateOptimizeLog(id, patch) {
  let lines
  try { lines = (await readFile(OPTIMIZE_LOG, 'utf8')).split('\n') } catch { return false }
  let hit = false
  const out = lines.map((line) => {
    if (line.trim() === '') return line
    let row
    try { row = JSON.parse(line) } catch { return line }
    if (String(row?.ts) !== String(id)) return line
    hit = true
    return JSON.stringify({ ...row, ...patch })
  })
  if (!hit) return false
  try { await writeFile(OPTIMIZE_LOG, out.join('\n'), 'utf8') } catch { return false }
  return true
}

// [2026-09-21] 优化前接 openmem：让精炼对齐"对老大的了解"，而非通用默认。
// 走官方 MCP 口（openmem 只监听 3466/mcp，无 REST）。失败静默降级为无背景优化，不阻断。
const OPENMEM_MCP_URL = process.env.OPENMEM_MCP_URL || 'http://127.0.0.1:3466/mcp'
let _omSession = ''
let _omSessionAt = 0
// [2026-09-21 提速] 「主人的喜好」画像缓存：openmem 侧画像几乎不变，
// 每轮重取是端到端 8~12s 的主因；缓存后首轮仍取、后续直接命中。
// [2026-09-21 老大拍板] TTL 10 分钟 → 24 小时：画像基本不变，10 分钟白重取。
const PROFILE_CACHE_MS = 24 * 60 * 60 * 1000
let _omProfile = ''
let _omProfileAt = 0

function _omParseRpcPayload(raw) {
  // streamable-http 可能回 application/json 或 text/event-stream（data: 行分帧）
  for (const line of String(raw).split('\n')) {
    const s = line.startsWith('data:') ? line.slice(5).trim() : (line.trim().startsWith('{') ? line.trim() : '')
    if (!s) continue
    try { const j = JSON.parse(s); if (j.result !== undefined || j.error !== undefined) return j } catch { /* 半帧 */ }
  }
  return null
}

/** [需求②] 用快模型（同 DV4F）把口语原文改写成 2~3 条检索腔查询，恰好一条 HyDE。
 *  实测（2026-09-21）：调用本身只要 ~2s，但 DV4F 偶发把 token 预算烧在推理上、正文返回空
 *  （completion_tokens == max_tokens 且 content 为空），故 max_tokens 抬到 900 且空/非法时重试一次；
 *  两次都空才返回 []（调用方降级为原句直查）。本函数不抛错。 */
async function buildRetrievalQueries(text, creds, timeoutMs) {
  if (!creds || creds.key === '' || !creds.base) return []
  const perAttempt = Math.max(1500, Math.min(Number(timeoutMs) || 4000, 4000))
  const payload = JSON.stringify({
    model: creds.model,
    messages: [
      { role: 'system', content: REWRITE_SYSTEM },
      { role: 'user', content: JSON.stringify({ originalPrompt: String(text).slice(0, 2000) }) },
    ],
    temperature: 0.2,
    max_tokens: 900,
  })
  const attempt = async () => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), perAttempt)
    try {
      const r = await fetch(`${creds.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.key}` },
        body: payload,
        signal: ac.signal,
      })
      if (!r.ok) return []
      const j = await r.json().catch(() => null)
      const raw = String(j?.choices?.[0]?.message?.content ?? '')
      const m = /\{[\s\S]*\}/.exec(raw)
      if (!m) return []
      const parsed = JSON.parse(m[0])
      const list = Array.isArray(parsed?.queries) ? parsed.queries : []
      const clean = []
      for (const q of list) {
        const s = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
        if (s !== '' && !clean.includes(s)) clean.push(s)
        if (clean.length >= 3) break
      }
      return clean
    } catch { return [] } finally { clearTimeout(timer) }
  }
  const first = await attempt()
  if (first.length > 0) return first
  return await attempt()
}

/** [需求②] 并行多查询检索 + 合并去重（同一条记忆只留一份，先命中的排前）。
 *  整体受 deadline 硬限；单查询慢于预算即当空结果，不拖垮优化。 */
async function mhSearchMany(callTool, queries, deadline) {
  const budget = Math.max(1000, deadline - Date.now())
  const sets = await Promise.all(queries.map((q) => Promise.race([
    callTool('mh_search', { query: q, top_k: 3, requester: 'dsh-optimize' }).catch(() => null),
    new Promise((settle) => setTimeout(() => settle(null), budget)),
  ])))
  const seen = new Set()
  const hits = []
  const perQuery = []
  for (let i = 0; i < queries.length; i++) {
    const rs = Array.isArray(sets[i]?.results) ? sets[i].results : []
    const hitIds = []
    for (const x of rs) {
      const key = String(x?.id ?? '') || String(x?.content ?? '').slice(0, 80)
      hitIds.push(String(x?.id ?? '').slice(0, 8))
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(x)
    }
    perQuery.push({ query: queries[i], hitIds })
  }
  return { hits, perQuery }
}

/** [2026-09-21 验收②] 保证检索词里至少有一条 HyDE 长查询（≥40 字或含假想答迹象）。
 *  模型改写在慢网关上经常 4s 空返回/只吐短词——不能把 HyDE 押在模型上，缺了就本地合成。 */
function ensureHydeQuery(queries, original) {
  const list = Array.isArray(queries) ? queries.filter((q) => String(q ?? '').trim() !== '').map(String) : []
  const hasLong = list.some((q) => q.length >= 40 || /假设|做法是|结论是|通常|可以这样|处理方式/.test(q))
  if (hasLong) return list.slice(0, 3)
  const src = String(original ?? '').replace(/\s+/g, ' ').trim()
  const kws = src
    .replace(/[，。！？、；：""''（）,.!?;:()[\]【】\n]/g, ' ')
    .replace(/(我们|你们|他们|什么|怎么|为什么|是不是|可以|应该|现在|今天|刚刚|刚才|一个|一下|这个|那个|我|你|他|她|它|的|了|吗|呢|吧|啊|把|被|着|很|太|还|就|都|也|这|那)/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 2)
  const uniq = [...new Set(kws)].slice(0, 8)
  const topic = uniq.length > 0 ? uniq.join('、') : src.slice(0, 40)
  const hyde = ('针对「' + topic + '」的常见处理做法：先定位具体对象与当前参数/状态，再给出可执行的调整步骤、关键阈值与验收方式').slice(0, 160)
  const shorts = list.filter((q) => q.length < 40).slice(0, 2)
  return [...shorts, hyde]
}

async function openmemContext(query, creds) {
  const cfg = readOptimizeConfig()
  const rawQueryOnly = String(query).replace(/\s+/g, ' ').trim().slice(0, 200)
  // [2026-09-21 设置页] 关掉「从 openmem 了解用户」后：不检索、不注入背景。
  // [2026-09-21 收尾] queries 留空：关闭时没有实际发出任何检索，日志/透视不应再写原长句冒充查询。
  if (cfg.useOpenmem !== true) return { text: '', queries: [], hits: [], degraded: false, disabled: true }
  // [2026-09-21 老大拍板] 检索命中默认仍开（记忆里常有有用信息），但注入时标明权重：
  // **最近对话上下文 > 原文 > 画像/记忆**；记忆只作风格与背景参考，不得把无关历史写进改写稿。
  // 设置 useOpenmemHits=false 可关掉命中、只留画像。
  const allowHits = cfg.useOpenmemHits !== false
  // [2026-09-21 提速] 检索段预算 10s→6s：实测端到端 8~12s 太慢（单次模型调用仅 0.7s），
  // 瓶颈是每轮重取 openmem 画像 + 三路检索；画像改为 10 分钟缓存（见下）。
  const deadline = Date.now() + 6_000
  const out = []
  const meta = { queries: [], hits: [], degraded: false }
  try {
    const hdr = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (!_omSession || Date.now() - _omSessionAt > 300000) {
      const init = await fetch(OPENMEM_MCP_URL, {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-optimize', version: '1.0' } } }),
        signal: AbortSignal.timeout(8000),
      })
      _omSession = init.headers.get('mcp-session-id') || ''
      _omSessionAt = Date.now()
      await fetch(OPENMEM_MCP_URL, {
        method: 'POST', headers: _omSession ? { ...hdr, 'Mcp-Session-Id': _omSession } : hdr,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
    if (_omSession) hdr['Mcp-Session-Id'] = _omSession
    let seq = 2
    const callTool = async (name, args) => {
      const r = await fetch(OPENMEM_MCP_URL, {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(8000),
      })
      const j = _omParseRpcPayload(await r.text())
      const t = j?.result?.content?.[0]?.text
      if (!t) return null
      try { return JSON.parse(t) } catch { return { answer: t } }
    }
    // [需求②] 检索先改写 → mh_search。[2026-09-21] allowHits=false 时只取画像，不检索。
    let queries = allowHits
      ? (cfg.retrievalRewrite === false
        ? [rawQueryOnly]
        : await buildRetrievalQueries(query, creds, Math.min(4000, Math.max(1000, deadline - Date.now()))).catch(() => []))
      : []
    if (!allowHits) {
      meta.queries = []
      meta.hits = []
      meta.profileOnly = true
    } else if (queries.length === 0) {
      // 改写失败：退化成关键词/短句，绝不拿整段口语原文去查
      const kws = String(query)
        .replace(/[，。！？、；：""''（）,.!?;:()[\]【】\n]/g, ' ')
        .replace(/(我们|你们|他们|什么|怎么|为什么|是不是|可以|应该|现在|今天|刚刚|刚才|一个|一下|这个|那个|我|你|他|她|它|的|了|吗|呢|吧|啊|把|被|着|很|太|还|就|都|也|这|那)/g, ' ')
        .split(/\s+/).filter((w) => w.length >= 2)
      const uniq = [...new Set(kws)].slice(0, 8)
      const fb = []
      if (uniq.length > 0) fb.push(uniq.join(' ').slice(0, 40))
      const short = String(query).replace(/\s+/g, ' ').trim().slice(0, 24)
      if (short !== '' && !fb.includes(short)) fb.push(short)
      queries = fb.length > 0 ? fb : [String(query).replace(/\s+/g, ' ').trim().slice(0, 200)]
      meta.degraded = true
      meta.queryFallback = 'keyword'
    }
    if (allowHits) {
      queries = ensureHydeQuery(queries, query)
      if (meta.degraded) meta.queryFallback = (meta.queryFallback ?? '') + '+hyde-local'
      meta.queries = queries
    }
    // 画像 24h 缓存；命中仅在 allowHits 时并行拉取
    const profFresh = _omProfile !== '' && Date.now() - _omProfileAt < PROFILE_CACHE_MS
    const [prof, found] = await Promise.all([
      profFresh ? Promise.resolve({ answer: _omProfile, cached: true }) : callTool('mh_tool', { name: '主人的喜好', agent: 'dsh-optimize' }).catch(() => null),
      allowHits ? mhSearchMany(callTool, queries, deadline) : Promise.resolve({ hits: [], perQuery: [] }),
    ])
    meta.hits = found.perQuery
    if (prof && prof.answer) {
      if (!profFresh) { _omProfile = String(prof.answer); _omProfileAt = Date.now() }
      out.push('【关于用户·画像】\n' + String(prof.answer).slice(0, 1500))
    }
    if (found.hits.length > 0) {
      out.push('【相关记忆】\n' + found.hits.map((x) => '· ' + String(x.content).replace(/\s+/g, ' ').slice(0, 260)).join('\n').slice(0, 1800))
    }
  } catch { /* openmem 不可达：无背景优化 */ }
  return { text: out.join('\n\n'), ...meta }
}

/** POST /optimize-prompt {text, conversationContext?} → {ok, optimized, id, drifted, attempts, ...}。45s 超时。
 *  [需求①] conversationContext：前端摘录的最近 8~12 条对话，拼进 system prompt 用于替换原文指代。
 *  [需求③] 精炼后跑一次漂移判定（实体/数字/禁令/范围/{{variable}} 占位符）；不过 → 带更严约束重试一次；
 *          再不过 → 退回原文并如实标记 fellBack:true（前端据此提示"有漂移风险，已按原文发"）。
 *  [需求④] 每次调用追加一行 ~/.dsh/optimize-log.jsonl，并把 ts 当 id 回给前端，供其回填 sent/edited。 */
async function serveOptimizePrompt(req, res) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  let text = ''
  let conversationContext = ''
  let forceDrift = ''
  // 必须走 readJsonBody：当前 webServer 会把 POST body 预缓冲挂到 req.body，
  // 直接 for-await 流会读到空（405 修复后实测 "text is required" 的根因）。
  try {
    const body = await readJsonBody(req, 64 * 1024)
    text = String(body?.text ?? '').trim()
    conversationContext = String(body?.conversationContext ?? '').trim().slice(0, 4000)
    // 测试钩子（仅本机自测用）：'first'=强制首次判定为漂移（验重试分支）；'all'=两次都判漂移（验退回原文分支）
    forceDrift = String(body?.debugForceDrift ?? '')
  } catch { /* 坏 body */ }
  if (text === '') return json(400, { ok: false, error: 'text is required' })
  const creds = litellmCreds()
  const optCfg = readOptimizeConfig() // [2026-09-21 设置页] A/B 档、漂移检查、日志开关都从这读
  const { key, base, model } = creds
  if (key === '') return json(500, { ok: false, error: 'litellm key not configured (env LITELLM_API_KEY or opencode.json)' })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 45_000)
  const callModel = async (messages, maxTokens, temperature) => {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: ac.signal,
    })
    if (!r.ok) throw new Error(`litellm ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
    const j = await r.json().catch(() => null)
    return String(j?.choices?.[0]?.message?.content ?? '').trim()
  }
  // [需求③ 改版 2026-09-21] 漂移判定分两层，避免"把改写稿全毙掉→退回原文→用户看不到成果"：
  //   硬事实层（永远跑、零延迟，丢了才拦）：{{variable}} 占位符、数字、禁令词。
  //   [2026-09-21 老大怒] 冒号标签**只记录不拦截**——曾把「30 秒雨夜短片:」误抽成标签「秒雨夜短片:」，
  //   改写稍变空格就判漂移→重试→44s 后退回原文，0 改动。标签保全靠 system 提示词，不靠这里毙稿。
  //   模型判定层（默认关，设置页可开）：更严但慢约 2 秒，只当顾问，绝不拦。
  /** 抽「标签:」字段名：只认句首/分隔符/冒号后的短词，避免把「30 秒雨夜短片:」碎片当成标签。 */
  const extractColonLabels = (s) => {
    const out = []
    const re = /(?:^|[\n\r；;，,、|:：])\s*([^\s:：，。！？、；、,.!?;()（）[\]【】"']{1,12})\s*[:：]/g
    let m
    while ((m = re.exec(String(s))) !== null) {
      const lab = m[1]
      if (!lab || /^\d+$/.test(lab)) continue
      if (/^[秒分小时天个张镜帧倍档次条只件]$/.test(lab)) continue
      out.push(lab)
    }
    return out
  }
  const hardChecks = (original, candidate) => {
    const o = String(original)
    const c = String(candidate)
    const lost = []
    const softLost = []
    const phs = (o.match(/\{\{\s*[\w.\-]+\s*\}\}/g) ?? []).filter((p) => !c.includes(p))
    if (phs.length > 0) lost.push(...phs.map((p) => '占位符 ' + p))
    const nums = (o.match(/\d+(?:[.\-–~]\d+)*/g) ?? []).filter((n) => !c.includes(n))
    if (nums.length > 0) lost.push(...[...new Set(nums)].slice(0, 6).map((n) => '数字 ' + n))
    const banRe = /(别|不要|禁止|不许|不准|不得|避免)/
    if (banRe.test(o) && !banRe.test(c)) lost.push('禁令词（别/不要/禁止…）')
    // 冒号标签：只进 softLost（写日志/透视），不进 lost → 不触发 drift/重试/退回
    const cFlat = c.replace(/\s+/g, '')
    const oLabels = extractColonLabels(o)
    const lostLabs = [...new Set(oLabels)].filter((lab) => !cFlat.includes(lab + ':') && !cFlat.includes(lab + '：'))
    if (lostLabs.length > 0) softLost.push(...lostLabs.slice(0, 6).map((l) => '标签 ' + l + ':'))
    return { lost, softLost, ok: lost.length === 0 }
  }
  const judgeDrift = async (original, candidate) => {
    const hard = hardChecks(original, candidate)
    // 模型判定：默认关（optCfg.driftCheck 打开才跑），且结论只进 advisory，不参与拦截。
    const report = {
      drift: !hard.ok,
      lost: hard.lost,
      softLost: hard.softLost ?? [],
      changed: [],
      placeholdersOk: !hard.lost.some((x) => String(x).startsWith('占位符')),
      hardLayer: true,
      advisory: null,
    }
    if (optCfg.driftCheck !== true) return report
    try {
      const raw = await callModel([
        { role: 'system', content: DRIFT_SYSTEM },
        { role: 'user', content: JSON.stringify({ originalPrompt: original, optimizedPrompt: candidate }) },
      ], 600, 0)
      const m = /\{[\s\S]*\}/.exec(raw)
      if (m) {
        const p = JSON.parse(m[0])
        report.advisory = {
          drift: p?.drift === true,
          lost: Array.isArray(p?.lost) ? p.lost.map(String).slice(0, 8) : [],
          changed: Array.isArray(p?.changed) ? p.changed.map(String).slice(0, 8) : [],
        }
      }
    } catch { /* 判定故障不堵用户 */ }
    return report
  }
  const ts = Date.now()
  try {
    // 先向 openmem 取"对用户的了解"（画像+改写后多查询检索），注入系统提示词
    const bg = await openmemContext(text, creds).catch(() => ({ text: '', queries: [], hits: [], degraded: true }))
    // [2026-09-21 设置页]「注入最近对话」关掉时：即便前端带了上下文也不喂给模型（省 token、少干扰）。
    const ctxForPrompt = optCfg.useContext === false ? '' : conversationContext
    const system = renderOptimizeSystem(ctxForPrompt, optCfg) +
      (bg.text === '' ? '' : '\n\n【openmem 参考（权重最低）】\n' + bg.text + '\n\n【权重铁律】最近对话上下文 > 原文 > 上述参考。参考只可影响语气/习惯/已有偏好；与上下文或原文冲突时一律以它们为准；**禁止把参考里的历史事件、测试记录或原文未提及的话题写进改写稿**。改写只能围绕原文与上下文里出现的对象展开。')
    const userMsg = JSON.stringify(ctxForPrompt === '' ? { originalPrompt: text } : { originalPrompt: text, conversationContext: ctxForPrompt })

    let optimized = await callModel([{ role: 'system', content: system }, { role: 'user', content: userMsg }], 2000, 0.3)
    if (optimized === '') {
      // [2026-09-21 实测] DV4F 偶发空正文（token 预算烧在推理上），重试一次再判失败。
      optimized = await callModel([{ role: 'system', content: system }, { role: 'user', content: userMsg }], 2000, 0.2).catch(() => '')
    }
    if (optimized === '') return json(502, { ok: false, error: 'empty optimization result (2 attempts)' })

    // [2026-09-21 改版] 硬事实层永远跑（零延迟，占位符/数字/禁令丢了才拦）；模型判定默认关且只作顾问。
    let drift = await judgeDrift(text, optimized)
    if (forceDrift === 'first' || forceDrift === 'all') drift = { ...drift, drift: true, lost: ['(debug 强制)'] }
    let attempts = 1
    if (drift.drift) {
      attempts = 2
      const strict = system + '\n\n【硬约束·重试】上一次改写丢失/改动了下列要素：' + (drift.lost.join('；') || '（未逐项列明）') +
        '。本次必须逐字保留原文全部实体、数字、禁令、范围、{{variable}} 占位符与「标签: 内容」冒号字段结构，且不得新增原文没有的实体或数字；宁可少改，不许漏改。'
      const retry = await callModel([{ role: 'system', content: strict }, { role: 'user', content: userMsg }], 2000, 0.2).catch(() => '')
      if (retry !== '') {
        let second = await judgeDrift(text, retry)
        if (forceDrift === 'all') second.drift = true
        drift = second
        if (!second.drift) optimized = retry
      }
    }
    const fellBack = drift.drift
    const finalText = fellBack ? text : optimized // 判定不过 → 退回原文，绝不把漂移稿灌给用户
    // [2026-09-21 收尾] 端到端耗时（从解析完 body 起算，含 openmem/改写/精炼/漂移/重试）。
    const durationMs = Date.now() - ts
    const row = {
      ts, original: text, optimized: finalText, drift: drift.drift, sent: false, edited: false,
      attempts, fellBack, conversationContextUsed: ctxForPrompt !== '',
      // [2026-09-21 收尾] queries 与 API.retrievalQueries 同源 = bg.queries（实际发出的检索查询）；
      // openmem 关闭时 bg.queries=[]，日志不再写原长句冒充查询。
      queries: bg.queries,
      retrievalQueries: bg.queries,
      durationMs,
      driftReport: drift,
    }
    if (optCfg.logUsage !== false) await appendOptimizeLog(row)
    return json(200, {
      ok: true,
      id: String(ts), // [需求④] 前端回填 sent/edited 的主键（= 日志行 ts）
      optimized: finalText,
      drifted: fellBack,
      fellBack,
      attempts,
      drift: drift.drift,
      driftReport: drift,
      driftAdvisory: drift.advisory ?? null,
      conversationContextUsed: ctxForPrompt !== '',
      durationMs,                     // [2026-09-21 收尾] 端到端耗时（毫秒），运行透视显示用
      retrievalQueries: bg.queries, // [需求②] 实际发出的检索查询（取证用）
      retrievalHits: bg.hits,        // [需求②] 每条查询命中的记忆 id
      retrievalDegraded: bg.degraded === true,
    })
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || String(err).includes('abort'))
    return json(504, { ok: false, error: aborted ? 'litellm timeout (45s)' : String(err?.message ?? err) })
  } finally { clearTimeout(timer) }
}

/** 媒体对象双桶解析：objects/<2>/<sha>（send_video 内容寻址池）优先；
 *  退 files/<2>/<sha>/<原名>（聊天上传件桶——用户发来的 mp4 实测落这里，
 *  只认 objects 会 404 黑屏）。sha 已过严格 hex 正则，目录名取 readdir 真实项，无穿越面。 */
async function resolveMediaFile(root, sha) {
  const obj = objectPath(root, sha)
  try { await stat(obj); return obj } catch { /* 转 files 桶 */ }
  const dir = join(root, 'files', sha.slice(0, 2), sha)
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try { if ((await stat(p)).isFile()) return p } catch { /* 竞态删除 */ }
    }
  } catch { /* files 桶也没有 */ }
  return undefined
}

/** 媒体文件流式响应（内容嗅探定 Content-Type + Range/206，<video> 拖动 seek 依赖 206）。
 *  serveVideoMedia（objects/files 双桶按 attachmentId）与 /workspace-media（present 附件卡按绝对路径）共用。 */
async function serveMediaFile(req, res, file) {
  let size
  try { size = (await stat(file)).size } catch { res.writeHead(404); res.end('not found'); return }
  let ctype = 'application/octet-stream'
  try {
    const fh = await open(file, 'r')
    const head = Buffer.alloc(16)
    try { await fh.read(head, 0, 16, 0) } finally { await fh.close() }
    if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = head.subarray(8, 12).toString('latin1')
      ctype = brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'
    }
    else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      ctype = /webm/.test(head.toString('latin1')) ? 'video/webm' : 'video/x-matroska'
    }
    else if (head.subarray(0, 4).toString('latin1') === 'RIFF') ctype = 'audio/wav'
  } catch { /* 保持 octet-stream */ }
  const base = { 'Content-Type': ctype, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' }
  const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  let start = 0
  let end = size - 1
  let partial = false
  if (rm !== null) {
    const s = rm[1] === '' ? null : Number(rm[1])
    const e = rm[2] === '' ? null : Number(rm[2])
    if (s === null && e !== null) start = Math.max(0, size - e) // 后缀区间 bytes=-N
    else { if (s !== null) start = s; if (e !== null) end = Math.min(e, size - 1) }
    if (start > end || start >= size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    partial = true
  }
  const headers = { ...base, 'Content-Length': String(end - start + 1) }
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  if (req.method === 'HEAD') { res.writeHead(partial ? 206 : 200, headers); res.end(); return }
  res.writeHead(partial ? 206 : 200, headers)
  createReadStream(file, { start, end }).pipe(res)
}

/** 视频对象读回（GET/HEAD）：attachmentId → 双桶解析后走流式响应。 */
async function serveVideoMedia(req, res, url) {
  const m = /^sha256:([0-9a-f]{64})$/.exec(url.searchParams.get('attachmentId') ?? '')
  if (m === null) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad attachmentId'); return }
  const file = await resolveMediaFile(voiceStorageRoot(), m[1])
  if (file === undefined) { res.writeHead(404); res.end('not found'); return }
  await serveMediaFile(req, res, file)
}

/** [2026-09-21] present 附件卡视频化：workspace 文件的流式读回（GET/HEAD）。
 *  威胁模型对齐官方 /api/present.open（本机 127.0.0.1 单用户服务，其原生 open 能启动任意
 *  presented 程序），但本路由再收三道：绝对路径、扩展名白名单、仅常规文件——只吐媒体，
 *  不给任意文件读原语。 */
const WORKSPACE_MEDIA_EXT = /\.(mp4|mov|webm|mkv|m4v|mp3|m4a|wav|ogg)$/i
async function serveWorkspaceMedia(req, res, url) {
  const raw = url.searchParams.get('path') ?? ''
  if (!raw.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(raw)) { res.writeHead(400); res.end('path must be absolute'); return }
  if (!WORKSPACE_MEDIA_EXT.test(raw)) { res.writeHead(403); res.end('extension not allowed'); return }
  const file = resolve(raw)
  let info
  try { info = await stat(file) } catch { res.writeHead(404); res.end('not found'); return }
  if (!info.isFile()) { res.writeHead(404); res.end('not found'); return }
  await serveMediaFile(req, res, file)
}

// ──────────────────────────────────────────────────────────────
// TTS 引擎
// ──────────────────────────────────────────────────────────────
/** 解析 ffmpeg 可执行文件：环境变量显式指定 > PATH 探测（where/which）> 兜底已知安装位置。
 *  [本地改造 2026-08-21] 修复：原来硬编码本机路径，换机器必挂。 */
function resolveFfmpegBin() {
  if (typeof process.env.DSH_VOICE_FFMPEG_BIN === 'string' && process.env.DSH_VOICE_FFMPEG_BIN.trim() !== '') {
    return process.env.DSH_VOICE_FFMPEG_BIN.trim()
  }
  try {
    // Windows: where ffmpeg；POSIX: which ffmpeg
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(probe, ['ffmpeg'], { windowsHide: true, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '')
    if (first !== undefined) return first
  } catch { /* 不在 PATH */ }
  // [0.1.5 修] 服务 nssm PATH 可能缺 winget/ffmpeg；多候选探测，找不到再回落已知路径
  const candidates = [
    'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
    'C:\\Users\\oadan\\scoop\\shims\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ]
  for (const p of candidates) { try { readFileSync(p); return p } catch { /* next */ } }
  return 'ffmpeg'
}
const FFMPEG_BIN = resolveFfmpegBin()

/** 统一入口：provider → 引擎；auto → 配置 defaultEngine，失败沿降级链（最后兜底微软 edge）。
 *  voiceDesc 为动态音色描述（仅 voicedesign 用）：AI 对话中生成，覆盖配置里的默认音色描述。
 *  [本地改造 2026-08-21] 克隆不再隐式优先：默认克隆由「默认语音引擎=voiceclone」控制，或显式 provider=voiceclone。
 *  [2026-08-22] overrideVoice=true：固定模式(示例/自定义)下 voiceDesc 整体替换底嗓（用户明确要求换声）；默认 false=voiceDesc 作为情绪/风格叠加在底嗓上。 */
async function synthesizeReplyVoice(text, provider, voiceDesc, overrideVoice) {
  const cfg = await loadVoiceConfig()
  const speak = stripMarkdown(text)
  const engine = provider ?? cfg.defaultEngine ?? 'auto'
  // 兜底链：首选 defaultEngine（若合理），否则直接微软 edge（免费，无需 key）
  const preferred = cfg.defaultEngine !== undefined && cfg.defaultEngine !== 'auto' ? cfg.defaultEngine : 'edge'
  const fallbackChain = engine === 'auto'
    ? [preferred, 'edge']
    : [engine, 'edge']
  // [本地改造 2026-08-21] 克隆不再隐式优先：只有 defaultEngine=voiceclone（或显式 provider=voiceclone）
  // 才走克隆（synthesizeEngine 的 voiceclone 分支），其余情况走正常引擎链。
  for (const candidate of fallbackChain) {
    try {
      const audio = await synthesizeEngine(candidate, speak, cfg, voiceDesc, overrideVoice)
      if (audio !== null) return audio
    } catch { /* 尝试下一个 */ }
  }
  // 最终兜底：微软 edge（免费无需 key），无视 enabled 开关——保证 4 个服务商都未启用时也有声音
  try {
    const audio = await synthesizeEdgeVoice(speak, cfg.engines.edge)
    if (audio !== null) return audio
  } catch { /* 忽略 */ }
  return null
}

async function synthesizeEngine(engine, text, cfg, voiceDesc, overrideVoice) {
  const e = cfg.engines[engine]
  // [本地改造 2026-08-21] 配置存在即启用：设置页已去复选框，enabled 不再拦截；
  // 各引擎自身检查必需参数（xiaomi/ali 查 key、local 查 cmd/url、voicedesign 查 key+desc、voiceclone 查 key+样本）。
  if (e === undefined) return null
  switch (engine) {
    case 'edge': return synthesizeEdgeVoice(text, e)
    case 'xiaomi': return synthesizeXiaomiVoice(text, e)
    case 'voicedesign': return synthesizeXiaomiVoiceDesign(text, e, cfg, voiceDesc, overrideVoice)
    case 'voiceclone': return synthesizeXiaomiVoiceClone(text, e, cfg, voiceDesc)
    case 'local': return synthesizeLocalVoice(text, e)
    case 'audio8': return synthesizeAudio8Voice(text, e)
    case 'ali': return synthesizeAliVoice(text, e)
    default: return null
  }
}

// ── edge 微软免费 ──
async function synthesizeEdgeVoice(text, cfg) {
  const voice = cfg?.voice ?? 'zh-CN-XiaoxiaoNeural'
  const mp3 = await edgeTts(text, voice)
  return toMp3(new Uint8Array(mp3), 'audio/mpeg')
}

// ── xiaomi 小米预置音色（mimo-v2.5-tts）──
async function synthesizeXiaomiVoice(text, cfg) {
  const apiKey = cfg?.apiKey ?? ''
  if (apiKey === '') return null
  const baseUrl = cfg?.baseUrl ?? 'https://api.xiaomimimo.com/v1'
  const voice = cfg?.voice ?? '冰糖'
  let speak = text
  // 唱歌：文本自带 (唱歌) 标签，或明确唱歌意图（唱/歌声）时自动加标签
  const hasTag = /^\s*\((唱歌|sing|singing)\)/i.test(speak)
  const wantsSing = !hasTag && /(唱(歌|一?首|一段)|歌声回复|用歌声|唱歌回|来一段|唱两句)/i.test(speak)
  if (wantsSing) speak = `(唱歌)${speak}`
  const messages = []
  if (cfg?.context?.trim() !== '') messages.push({ role: 'user', content: cfg.context.trim() })
  messages.push({ role: 'assistant', content: speak })
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages,
      max_tokens: 8192,
      audio: { format: 'wav', voice },
    }),
  })
  if (!response.ok) return null
  const payload = await response.json()
  const data = payload?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || data.length < 100) return null
  return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
}

// [本地补丁 2026-09-15 老大钦定] VoiceDesign 官方示例指令（host 端权威副本）：
// 官方示例模式（asmr/docu/elder）直接用这里的官方指令发声——不读配置里的 context、也忽略 agent 传的
// voiceDesc 情绪叠加，任何 bot 都污染不了官方音色。
// ⚠️ 与 client.js 的 VOICE_DESIGN_EXAMPLES 文本保持一致；官方示例更新时两处都要改。
const OFFICIAL_VD_PRESETS = {
  asmr: '年轻的女性声音，近距离的聆听效果，带有双耳刺激的ASMR感。可以听到她的呼吸声、轻微的吞咽声，以及轻柔的自然唇音。她的说话速度非常慢，营造出一种极度放松且沉浸式的体验。',
  docu: '一位中年男性，说标准普通话，嗓音低沉有磁性，带有轻微的沙哑质感，像纪录片旁白解说员，沉稳而有感染力。',
  elder: '一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。',
}

// ── xiaomi 音色设计（mimo-v2.5-tts-voicedesign：user=音色描述，无 voice）──
// [2026-08-22] overrideVoice=true：固定模式(示例/自定义)下 voiceDesc 整体替换底嗓（用户明确要求换声）；
// 默认 false：voiceDesc 作为"情绪/风格"叠加在用户设置的底嗓(context)后面——与工具描述一致，不再"非空即覆盖"。
async function synthesizeXiaomiVoiceDesign(text, cfg, globalCfg, voiceDesc, overrideVoice) {
  const apiKey = globalCfg.engines.xiaomi.apiKey
  // 优先用 AI 动态生成的音色描述（voiceDesc），否则用配置里的默认音色描述
  // [2026-08-22] 模式感知兜底：mode=ai 时绝不能回退到用户残留的固定描述(context)——
  // 而是按 aiGender/aiAge 生成中性基座（用户没让 AI 写时也稳定），避免"切到 AI 模式却用旧 ASMR 指令"。
  const vdMode = cfg?.mode
  let desc = (voiceDesc ?? '').trim()
  if (vdMode === 'ai') {
    // [2026-08-22] AI 模式：身份一律以用户实时配置的锚点为准（锁定项）。
    // 修复(XDN 实测): ①"老年感+女孩"分维度拼接→身份自相矛盾(模型选"女孩"→萝莉化),
    //    改 ageGenderIdentity 合并成"老年女性/小女孩/少女"等无歧义短语;
    // ②"性别/年龄表述忽略"注把 AI 写的"沙哑/苍老/低沉"等最强质感词删了,
    //    改为只锁定性别/年龄, 允许情绪与音色质感词保留并强化。
    const gKey = cfg?.aiGender === 'male' ? 'male' : cfg?.aiGender === 'female' ? 'female' : ''
    const aKey = AI_AGE_LABELS[cfg?.aiAge] !== undefined ? cfg.aiAge : ''
    const identity = ageGenderIdentity(aKey, gKey)
    const lockG = cfg?.lockGender === true
    const lockA = cfg?.lockAge === true
    // [2026-09-01] 老大：质感锁定选项已删（质感/情绪/节奏三池都按年龄分档，身份天然稳定，无需单独锁）
    const gLabel = gKey === 'male' ? '男' : gKey === 'female' ? '女' : ''
    const aLabel = AI_AGE_LABELS[aKey] ?? ''
    const anchorText = [
      lockG ? '性别固定为' + (gLabel !== '' ? gLabel : '每次一致') : '',
      lockA ? '年龄感固定为' + (aLabel !== '' ? aLabel : '每次一致') : '',
    ].filter(Boolean).join('、')
    if (identity !== '' || anchorText !== '') {
      desc = (identity !== '' ? '一位' + identity + '的声音（身份硬性要求：' + (anchorText !== '' ? anchorText : '按上述身份')
        + '；若与其他描述冲突，一律以本身份为准，严禁合成其他性别或年龄段的声音）。' : '')
        + (desc !== '' ? '语气/情绪要求：' + desc + '（性别与年龄以身份为准，严禁改变；只按本描述演绎情绪语气）。'
          : '音色与语气要求：' + randomVoiceDesignDesc(aKey) + '（性别与年龄以身份为准，严禁改变）。')
    } else if (desc === '') {
      desc = randomVoiceDesignDesc('') + '；语气情绪要饱满生动，像真人一样带喜怒哀乐，禁止平淡。'
    }
  } else {
    // 固定模式（官方示例/自定义）：底嗓用用户设置的 context。
    // [本地补丁 2026-09-15 老大钦定] 官方示例模式（asmr/docu/elder）= 只用官方指令发声：
    // ① 直接用 host 内置 OFFICIAL_VD_PRESETS，不读配置里的 context（就算配置被改坏也污染不到）；
    // ② 忽略 agent 传的 voiceDesc 情绪叠加。任何 bot 都污染不了官方音色。
    // 仅 overrideVoice=true（用户明确要求换一种完全不同的声音）时仍整体替换底嗓。
    const base = (cfg?.context?.trim() ?? '')
    const isOfficialPreset = vdMode === 'asmr' || vdMode === 'docu' || vdMode === 'elder'
    if (overrideVoice === true && desc !== '') {
      desc = desc // 整体替换底嗓（用户明确要求换声）
    } else if (isOfficialPreset) {
      desc = OFFICIAL_VD_PRESETS[vdMode] ?? base // 官方指令优先，极端情况才退回配置
    } else {
      desc = base + (desc !== '' ? '；' + desc : '')
    }
  }
  if (apiKey === '' || desc === '') return null
  const baseUrl = globalCfg.engines.xiaomi.baseUrl ?? 'https://api.xiaomimimo.com/v1'
  const messages = [
    { role: 'user', content: desc },
    { role: 'assistant', content: text },
  ]
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts-voicedesign',
      messages,
      max_tokens: 8192,
      audio: { format: 'wav' },
    }),
  })
  if (!response.ok) return null
  const payload = await response.json()
  const data = payload?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || data.length < 100) return null
  return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
}

// ── xiaomi 音色克隆（mimo-v2.5-tts-voiceclone：audio.voice=样本 dataURL，≤10MB）──
// samples: [{id,name,path}] 支持多个克隆音色；兼容旧 samplePath
// voiceDesc 为情感/风格指令（AI 生成，如"委屈撒娇"）：优先于 cfg.context，让克隆底嗓带情绪
async function synthesizeXiaomiVoiceClone(text, cfg, globalCfg, voiceDesc) {
  const apiKey = globalCfg.engines.xiaomi.apiKey
  // [2026-09-01] 支持 sampleId：下拉选中哪个音色就用哪个；没配 sampleId 退回第一个（向后兼容旧配置）
  const sampleList = Array.isArray(cfg?.samples) ? cfg.samples : []
  const chosen = (typeof cfg?.sampleId === 'string' && cfg.sampleId !== '')
    ? (sampleList.find((s) => s.id === cfg.sampleId) ?? sampleList[0])
    : sampleList[0]
  const samplePath = (chosen && typeof chosen.path === 'string' && chosen.path !== '')
    ? chosen.path
    : (cfg?.samplePath ?? '')
  if (apiKey === '' || samplePath === '') return null
  const baseUrl = globalCfg.engines.xiaomi.baseUrl ?? 'https://api.xiaomimimo.com/v1'
  let sample
  try {
    const bytes = await readFile(samplePath)
    if (bytes.byteLength > 10 * 1024 * 1024) return null
    const suffix = samplePath.toLowerCase().split('.').pop()
    const mime = suffix === 'mp3' ? 'audio/mpeg' : suffix === 'wav' ? 'audio/wav' : 'audio/wav'
    sample = `data:${mime};base64,${bytes.toString('base64')}`
  } catch { return null }
  const messages = []
  // [本地改造 2026-08-21] 风格指令优先级：voiceDesc（AI 生成）> 样本自带 context（每个克隆音色自己的性格）> 全局 context（兜底）
  const sampleContext = typeof chosen?.context === 'string' ? chosen.context.trim() : ''
  const styleInstruct = (voiceDesc ?? '').trim() !== ''
    ? voiceDesc.trim()
    : (sampleContext !== '' ? sampleContext : (cfg?.context?.trim() ?? ''))
  if (styleInstruct !== '') messages.push({ role: 'user', content: styleInstruct })
  messages.push({ role: 'assistant', content: text })
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts-voiceclone',
      messages,
      max_tokens: 8192,
      audio: { format: 'wav', voice: sample },
    }),
  })
  if (!response.ok) return null
  const payload = await response.json()
  const data = payload?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || data.length < 100) return null
  return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
}

// [2026-08-22] 解析 Windows 命令行参数（正确处理双引号：引号内空格不拆、剥掉引号）。
// 之前用 command.split(/\s+/) 拆参数，用户填的带引号路径会被整段含引号传给
// execFileSync → node 把 "C:\...\local-tts.mjs" 当成相对路径拼上 cwd →
// Cannot find module 'D:\opt\...\"C:\Users\...'。本函数根治该问题。
function splitCommandLine(cmd) {
  const args = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '"') {
      inQuote = !inQuote
    } else if (ch === ' ' || ch === '\t') {
      if (inQuote) { cur += ch } else if (cur !== '') { args.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur !== '') args.push(cur)
  return args
}

// ── local 本地 MeloTTS：HTTP 常驻服务优先，CMD 兜底 ──
async function synthesizeLocalVoice(text, cfg) {
  const url = cfg?.url?.trim() ?? ''
  if (url !== '') {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      timeout: 60_000,
    })
    if (!response.ok) return null
    const body = await response.arrayBuffer()
    return toMp3(new Uint8Array(body), 'audio/wav')
  }
  const command = cfg?.cmd?.trim() ?? ''
  if (command === '') return null
  const parts = splitCommandLine(command)
  const bin = parts[0]
  if (bin === undefined) return null
  const rest = parts.slice(1)
  const audio = execFileSync(bin, [...rest, text], {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 60_000,
  })
  return toMp3(new Uint8Array(audio), 'audio/mpeg')
}

// ── audio8 本地零样本克隆 TTS（2026-09-01）：命令行包装输出 mp3 到 stdout；音色须先注册 ──
// [2026-09-01 改造] 优先走常驻服务 url（POST /synthesize，模型常驻内存，省掉每次 20s+ 的模型加载）；
// 常驻服务没起来才回退 cmd 命令行包装（每次重新加载模型，慢）。
// cmd 形如 `node C:\D\opt\audio8-tts\audio8-tts.mjs`；cfg.voice 非空则追加 --voice <名>，空则包装脚本自动选最新注册音色。
// [2026-09-01 超时定稿] CPU 推理慢（一句约 15-30s，长文本数分钟），fetch 信号与 cmd 兜底统一放宽到
// 13min（780s），与 harness transport 的 undici headersTimeout(780s) 对齐——再也不会因慢被掐死。
async function synthesizeAudio8Voice(text, cfg) {
  const voice = (cfg?.voice ?? '').trim()
  const url = (cfg?.url ?? '').trim()
  if (url !== '') {
    try {
      const r = await fetch(`${url.replace(/\/+$/, '')}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice: voice === '' ? undefined : voice }),
        signal: AbortSignal.timeout(780_000),
      })
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer())
        // 常驻服务返回 wav：统一转 mp3（与命令行路径一致，顺带算出时长）
        if (buf.byteLength > 1000) return await toMp3(new Uint8Array(buf), 'audio/wav')
      }
    } catch { /* 常驻服务没起来：掉到下面的命令行兜底 */ }
  }
  const command = cfg?.cmd?.trim() ?? ''
  if (command === '') return null
  const parts = splitCommandLine(command)
  const bin = parts[0]
  if (bin === undefined) return null
  const rest = parts.slice(1)
  const args = [...rest]
  if (voice !== '') args.push('--voice', voice)
  args.push(text)
  const audio = execFileSync(bin, args, {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 780_000,
  })
  return toMp3(new Uint8Array(audio), 'audio/mpeg')
}

// ── ali 阿里 qwen3-tts-flash（dashscope）──
async function synthesizeAliVoice(text, cfg) {
  const apiKey = cfg?.apiKey ?? ''
  if (apiKey === '') return null
  const baseUrl = cfg?.baseUrl ?? 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
  const voice = cfg?.voice ?? 'Cherry'
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-tts-flash',
      input: { text },
      parameters: { voice, format: 'wav', language_type: 'zh' },
    }),
    timeout: 60_000,
  })
  if (!response.ok) return null
  const payload = await response.json()
  const audioUrl = payload?.output?.audio?.url
  if (typeof audioUrl !== 'string' || audioUrl === '') return null
  const audioRes = await fetch(audioUrl, { timeout: 120_000 })
  if (!audioRes.ok) return null
  const body = await audioRes.arrayBuffer()
  return toMp3(new Uint8Array(body), 'audio/wav')
}

// ──────────────────────────────────────────────────────────────
// ASR 语音识别（三模式：service=本地常驻HTTP / cmd=本地命令 / api=在线API）
// ──────────────────────────────────────────────────────────────
/** 把 base64 音频写入临时 wav，调用本地 sherpa 常驻服务（POST /transcribe {audioPath}）或命令。 */
async function transcribeAudio(base64Audio, cfg) {
  const asr = cfg?.engines?.asr
  if (asr === undefined || asr.enabled === false) return { ok: false, error: 'ASR 未启用' }
  if (typeof base64Audio !== 'string' || base64Audio === '') return { ok: false, error: '缺少音频数据' }
  const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-asr-${randomUUID()}.raw`)
  const tmpWav = join(process.env.TEMP ?? '/tmp', `dsh-asr-${randomUUID()}.wav`)
  await writeFile(tmpIn, Buffer.from(base64Audio, 'base64'))
  try {
    // 统一转成 16kHz 单声道 PCM WAV（录音是 webm/其他容器，sherpa 只认标准 wav）
    let wavPath = tmpIn
    try {
      execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      wavPath = tmpWav
      // 缓存最近一次录音到 ~/.dsh/last-voice.wav（供"用我刚才那段语音克隆音色"使用）
      try {
        const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
        await mkdir(homeDir, { recursive: true })
        await writeFile(join(homeDir, 'last-voice.wav'), await readFile(tmpWav))
      } catch { /* 缓存失败不影响识别 */ }
    } catch (ffErr) {
      // ffmpeg 失败时保留原始文件；sherpa 对 webm 常返回空文本 → 下面报「未返回文本」
      console.error('[asr] ffmpeg convert failed:', FFMPEG_BIN, ffErr instanceof Error ? ffErr.message : ffErr, '\n[asr] ffmpeg stderr:', String((ffErr ?? {}).stderr ?? '').slice(-600), '\n[asr] tmpIn=', tmpIn, 'exists=', existsSync(tmpIn))
    }
    // 1) 本地常驻服务（nssm: asr，端口 18790；POST /transcribe {audioPath}）
    if (asr.mode === 'service' && (asr.url ?? '').trim() !== '') {
      const baseUrl = asr.url.trim().replace(/\/+$/, '')
      const response = await fetch(`${baseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioPath: wavPath }),
        timeout: 60_000,
      })
      if (!response.ok) return { ok: false, error: `ASR 服务返回 ${response.status}` }
      const raw = await response.text()
      let payload = {}
      try { payload = raw ? JSON.parse(raw) : {} } catch { payload = {} }
      let text = ''
      if (typeof payload?.text === 'string' && payload.text.trim() !== '') text = payload.text.trim()
      else if (typeof payload?.result === 'string' && payload.result.trim() !== '') text = payload.result.trim()
      else if (typeof payload?.transcript === 'string' && payload.transcript.trim() !== '') text = payload.transcript.trim()
      if (text === '') {
        console.error('[asr] empty text; wavPath=', wavPath, 'ffmpeg=', FFMPEG_BIN, 'resp=', raw.slice(0, 200))
        return { ok: false, error: 'ASR 服务未返回文本（多半是录音没转成 wav：查 ffmpeg 路径/DSH_VOICE_FFMPEG_BIN）' }
      }
      return { ok: true, text }
    }
    // 2) 本地命令（sherpa-onnx-offline.exe，结果输出到 stderr，需合并双流解析）
    if (asr.mode === 'cmd' && (asr.cmd ?? '').trim() !== '') {
      const parts = splitCommandLine(asr.cmd.trim())
      const bin = parts[0]
      if (bin === undefined) return { ok: false, error: '命令格式错误' }
      const { spawnSync } = await import('node:child_process')
      const result = spawnSync(bin, [...parts.slice(1), wavPath], {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // sherpa-onnx 把结果打印到 stderr（stdout 部分版本也有），合并解析
      const all = (result.stdout ?? '') + '\n' + (result.stderr ?? '')
      const m = all.match(/"text"\s*:\s*"([^"]*)"/)
      const text = (m?.[1] ?? '').trim()
      if (text === '') return { ok: false, error: '本地命令未输出识别结果' }
      return { ok: true, text }
    }
    // 3) 在线 API（默认小米 mimo-v2.5-asr：OpenAI 兼容 chat/completions + input_audio base64；
    //    若 apiBaseUrl 含 openai 则走 Whisper 风格 /audio/transcriptions）
    if (asr.mode === 'api' && (asr.apiKey ?? '').trim() !== '') {
      const apiKey = asr.apiKey.trim()
      const baseUrl = (asr.apiBaseUrl ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
      const audioBase64 = Buffer.from(base64Audio, 'base64').toString('base64')
      if (baseUrl.includes('openai')) {
        // Whisper 兼容（multipart file + model）
        const form = new FormData()
        const blob = new Blob([Buffer.from(audioBase64, 'base64')], { type: 'audio/wav' })
        form.append('file', blob, 'audio.wav')
        form.append('model', 'whisper-1')
        const response = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          timeout: 60_000,
        })
        if (!response.ok) return { ok: false, error: `ASR API 返回 ${response.status}` }
        const payload = await response.json().catch(() => ({}))
        const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
        if (text === '') return { ok: false, error: 'ASR API 未返回文本' }
        return { ok: true, text }
      }
      // 小米 mimo-v2.5-asr：chat/completions + input_audio dataURL
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-asr',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audioBase64}` } },
              ],
            },
          ],
          extra_body: { asr_options: { language: 'auto' } },
        }),
        timeout: 120_000,
      })
      if (!response.ok) return { ok: false, error: `小米 ASR 返回 ${response.status}` }
      const payload = await response.json().catch(() => ({}))
      const text = typeof payload?.choices?.[0]?.message?.content === 'string'
        ? payload.choices[0].message.content.trim()
        : ''
      if (text === '') return { ok: false, error: '小米 ASR 未返回文本' }
      return { ok: true, text }
    }
    return { ok: false, error: 'ASR 未配置（服务地址/命令/API Key 三选一）' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'ASR 转写失败' }
  } finally {
    await unlink(tmpWav).catch(() => {})
    await unlink(tmpIn).catch(() => {})
  }
}

// ──────────────────────────────────────────────────────────────
// 音频工具
// ──────────────────────────────────────────────────────────────
async function toMp3(data, declared) {
  const isMp3 = data.length > 2 && data[0] === 0xFF && ((data[1] ?? 0) & 0xE0) === 0xE0
  let finalData = data
  let mediaType = declared
  if (!isMp3) {
    const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-tts-in-${randomUUID()}.wav`)
    const mp3Path = join(process.env.TEMP ?? '/tmp', `dsh-tts-${randomUUID()}.mp3`)
    await writeFile(tmpIn, data)
    try {
      execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      finalData = new Uint8Array(await readFile(mp3Path))
      mediaType = 'audio/mpeg'
    } catch {
      // 转码失败保留原容器（部分浏览器仍可播）。
    } finally {
      await unlink(tmpIn).catch(() => {})
      await unlink(mp3Path).catch(() => {})
    }
  }
  const durationMs = estimateAudioDurationMs(finalData)
  return {
    mediaType,
    data: finalData,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function looksLikeOgg(data) {
  return data.length >= 4
    && data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>+\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s*[-*_]\s*$/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function estimateAudioDurationMs(data) {
  if (looksLikeOgg(data)) {
    const kbps = 48
    return Math.round(data.length / (kbps * 1000 / 8) * 1000)
  }
  let offset = 0
  if (data.length >= 10 && (data[0] ?? 0) === 0x49 && (data[1] ?? 0) === 0x44 && (data[2] ?? 0) === 0x33
    && ((data[3] ?? 0) & 0xFF) < 0xFF && ((data[4] ?? 0) & 0xFF) < 0xFF) {
    const size = (((data[6] ?? 0) & 0x7F) << 21) | (((data[7] ?? 0) & 0x7F) << 14)
      | (((data[8] ?? 0) & 0x7F) << 7) | ((data[9] ?? 0) & 0x7F)
    offset = 10 + size
  }
  while (offset + 4 <= data.length) {
    const sync = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
    if ((sync & 0xFFE0) === 0xFFE0) {
      const bitrateIndex = ((data[offset + 2] ?? 0) >>> 4) & 0x0F
      const sampleRateIndex = ((data[offset + 2] ?? 0) >>> 2) & 0x03
      if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined
      const bitrates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      const kbps = bitrates[bitrateIndex - 1] ?? 128
      return Math.round((data.length - offset) / (kbps * 1000 / 8) * 1000)
    }
    offset += 1
  }
  return undefined
}

// ──────────────────────────────────────────────────────────────
// 自动语音回复辅助
// ──────────────────────────────────────────────────────────────
/** 用户文本是否明确要求语音回复；返回要用的 TTS provider，否则 null。 */
function voiceRequestProvider(text) {
  if (!/(用语音回|回个语音|发个语音|发语音|用语音说|语音回我|语音告诉我|念给我|语音播报|用小米|用微软|小米语音|微软语音|xiaomi|edge语音|语音回复我)/i.test(text)) return null
  if (/小米|xiaomi/i.test(text)) return 'xiaomi'
  if (/微软|edge/i.test(text)) return 'edge'
  if (/阿里|ali/i.test(text)) return 'ali'
  return 'auto'
}

/** 判断一行是否像代码/噪声，不该被念出来（中文口语基本不会命中这些模式）。 */
function looksLikeCodeLine(t) {
  if (/[=;{}<>$|]/.test(t)) return true              // 赋值/分号/花括号/尖括号/管道/美元
  if (/=>|::/.test(t)) return true                   // 箭头函数/作用域
  if (/\b[a-z_]\w{2,}\s*\(/.test(t)) return true     // 函数调用 foo(
  if (/\.\w+(\s*\(|\s*=)/.test(t)) return true       // 方法链 obj.method(
  if (/^\s*(const|let|var|function|def|class|import|export|return|if|for|while|public|private|async|await|SELECT|INSERT|UPDATE|FROM|WHERE|npm|npx|pip|cd|ls|git|sudo|curl|wget|docker|kubectl|python|node|tsx|pnpm|yarn|bun|cargo)\b/i.test(t)) return true
  if (/[\\/][\w.-]+\.\w{1,5}/.test(t)) return true   // 文件路径 c:\x.js / /a/b.ts
  if (/"[^"]*"\s*[:=]/.test(t)) return true          // "key": 或 "key" =
  if (/\b0x[0-9a-f]+/i.test(t)) return true          // 十六进制
  if (/[a-z][A-Z]\w*\s*\(/.test(t)) return true      // camelCase(
  return false
}

/** 从助手文本提取适合语音念的口语部分（去代码/URL/Markdown，取前 2 句，最多约 200 字）。 */
function extractSpeakable(text) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')   // 整段代码块
    .replace(/`[^`]*`/g, ' ')          // 行内代码
    .replace(/https?:\/\/\S+/g, ' ')   // 链接
    .replace(/[#>*|~-]\s*/g, ' ')      // Markdown 符号
  const lines = cleaned.split('\n').filter((line) => {
    const t = line.trim()
    if (t === '') return false
    if (looksLikeCodeLine(t)) return false
    if (/^[\d\s.,%:/-]+$/.test(t)) return false  // 纯数字/标点
    return true
  })
  const prose = lines.join(' ').replace(/\s+/g, ' ').trim()
  if (prose === '') return ''
  const sentences = prose.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [prose]
  let speak = ''
  for (const sentence of sentences.slice(0, 2)) {
    if ((speak + sentence).length > 200) break
    speak += sentence
  }
  return speak.trim()
}

// ──────────────────────────────────────────────────────────────
// HTTP 工具
// ──────────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, maxBytes) {
  // [0.1.5] webServer 仍是 IncomingMessage；同时兼容已缓冲 body / 错误 Content-Type。
  if (req && typeof req === 'object' && 'body' in req && req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body
    if (typeof req.body === 'string') return JSON.parse(req.body)
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'))
  }
  const chunks = []
  let total = 0
  let contentType = ''
  if (req && req.headers) contentType = String(req.headers['content-type'] || '')
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > (maxBytes ?? 1024 * 1024)) throw new Error('body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks)
  if (total === 0) throw new Error('empty body')
  // multipart 边界绝不交给 JSON.parse（会得到 "No number after minus sign"）
  if (/^multipart\//i.test(contentType)) {
    throw new Error('multipart body not supported here; send JSON {audioBase64}')
  }
  return JSON.parse(raw.toString('utf8'))
}

// ──────────────────────────────────────────────────────────────
// 插件入口
// ──────────────────────────────────────────────────────────────
async function apply(ctx) {
  // [0.1.5 移植 2026-09-10] 全局人设 / MCP 动态 / Skill / 文件 API（原 dsh-host-files）
  applyHostFiles(ctx)
  // [2026-08-22] 识图核心（look_image 工具 + 设置页测试共用）：直连 vision 配置的视觉后端
  const LOOK_TASK_PROMPTS = {
    // [2026-08-22 改] 简短描述（普通看图），不再用"画面风格/主体/..."专业结构（那是反推的事）
    describe: '请用中文简要描述这张图片的内容（一到两句话，简洁明了），如有人物说明主要形象与姿态。',
    text: '请逐字提取这张图片中的所有文字，按在画面中的位置分行输出，每行前缀标出行位置（如「顶部」「中部」「底部」）。仅输出提取到的文字内容，不要解释、不要翻译。',
  }
  async function runVision({ imagePath, task, extra }) {
    try {
      const path = (imagePath ?? '').trim()
      if (path === '') return { ok: false, error: 'image_path 不能为空' }
      const t = (task ?? 'describe').trim()
      const vis = (await loadVoiceConfig()).vision ?? {}
      if (vis.enabled === false) return { ok: false, error: '图片识别未启用：请到「设置 → 语音服务 → 图片识别」开启' }
      // [2026-08-22 改] provider 映射：local/online（兼容旧 ollama/openai）；请求格式统一 OpenAI 兼容
      const rawProvider = (vis.provider ?? 'local').trim()
      const provider = (rawProvider === 'online' || rawProvider === 'openai') ? 'online' : 'local'
      const baseUrl = (vis.baseUrl ?? '').trim() || 'http://127.0.0.1:11434/v1'
      const model = (vis.model ?? '').trim() || 'qwen3-vl:4b-instruct'
      const apiKey = (vis.apiKey ?? '').trim()
      const timeoutMs = Number(vis.timeoutMs) > 0 ? Number(vis.timeoutMs) : 240000
      // 提示词：优先用 vis.prompts[task]（用户编辑后），），）读 reverse 文件，
      // describe/text 仍无则用内置模板
      const userPrompt = (vis.prompts ?? {})[t]
      let promptText = ''
      if (typeof userPrompt === 'string' && userPrompt.trim() !== '') {
        promptText = userPrompt.trim()
      } else if (t === 'reverse') {
        try {
          const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
          promptText = (await readFile(join(homeDir, 'visionqa-reverse-prompt.txt'), 'utf8')).trim()
        } catch {
          try { promptText = (await readFile(join(ASSETS_DIR, 'reverse-prompt.txt'), 'utf8')).trim() } catch { /* 忽略 */ }
        }
        if (promptText === '') return { ok: false, error: '反推提示词文件缺失' }
      } else {
        promptText = LOOK_TASK_PROMPTS[t] ?? LOOK_TASK_PROMPTS.describe
      }
      const extraText = (extra ?? '').trim()
      const userContent = promptText + (extraText !== '' ? '\n\n【附加要求】' + extraText : '')
      // [2026-08-22 修] 读文件头(magic bytes)判断实际图片格式，data URL 按真实格式声明 mime——
      // 之前硬编码 data:image/png，jpg/webp 图片标签写错；ollama 不较真能自动识别，但
      // 严格按声明 mime 解码的后端会失败。不依赖扩展名，无后缀/后缀错的图也能正确声明。
      const imgRaw = await readFile(path)
      const imgB64 = imgRaw.toString('base64')
      const sniffImageMime = (b) => {
        if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
        if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
        if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
        if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
        return 'image/png' // 未知格式兜底（保持向后兼容）
      }
      const imgMime = sniffImageMime(imgRaw)
      const t0 = Date.now()
      // [2026-09-07] 软超时 + 回退: 主后端超时(默认 online 20s/local 90s)或报错(401/5xx/连不上)
      // 立刻回退备用后端, 不再干等 timeoutMs(历史 240s 实测把 agent 卡死 4 分钟)
      const softMs = Number(vis.softTimeoutMs) > 0 ? Number(vis.softTimeoutMs) : (provider === 'online' ? 20000 : 90000)
      const fb = vis.fallback ?? {}
      const fbEnabled = fb.enabled !== false
      const fbProvider = ((fb.provider ?? '').trim() || (provider === 'online' ? 'local' : 'online')).trim()
      const fbBase = ((fb.baseUrl ?? '').trim() || (fbProvider === 'online' ? '' : 'http://127.0.0.1:11434/v1'))
      const fbModel = ((fb.model ?? '').trim() || 'qwen3-vl:4b-instruct')
      const fbKey = (fb.apiKey ?? '').trim()
      const fbTimeout = Number(fb.timeoutMs) > 0 ? Number(fb.timeoutMs) : 90000
      const messages = [{ role: 'user', content: [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: 'data:' + imgMime + ';base64,' + imgB64 } },
      ] }]

      const callOne = async (base, key, mdl, ms) => {
        if (base === '') return { ok: false, error: 'baseUrl 未配置' }
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), ms)
        try {
          const r = await fetch((base.endsWith('/') ? base.slice(0, -1) : base) + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(key !== '' ? { authorization: 'Bearer ' + key } : {}) },
            signal: ac.signal,
            body: JSON.stringify({ model: mdl, temperature: 0.4, messages }),
          })
          clearTimeout(timer)
          if (!r.ok) {
            let b = ''; try { b = (await r.text()).slice(0, 200) } catch { /* 忽略 */ }
            return { ok: false, error: 'HTTP ' + r.status + ' ' + b }
          }
          const d = await r.json()
          const s = (d?.choices?.[0]?.message?.content ?? '').trim()
          if (s === '') return { ok: false, error: '返回内容为空' }
          return { ok: true, text: s }
        } catch (error) {
          clearTimeout(timer)
          return { ok: false, error: (error?.name === 'AbortError') ? ('超时 ' + Math.round(ms / 1000) + 's') : String(error?.message ?? error) }
        }
      }

      const r1 = await callOne(baseUrl, apiKey, model, Math.min(softMs, timeoutMs))
      if (!r1.ok && fbEnabled && fbBase !== '') {
        const r2 = await callOne(fbBase, fbKey, fbModel, fbTimeout)
        if (r2.ok) {
          return { ok: true, text: r2.text, task: t, model: fbModel, provider: fbProvider,
            durationMs: Date.now() - t0, fallbackUsed: true,
            fallbackReason: '主后端 ' + provider + '(' + model + ') 失败: ' + r1.error }
        }
        return { ok: false, durationMs: Date.now() - t0, fallbackUsed: true,
          error: '主后端 ' + provider + '(' + model + ') 失败: ' + r1.error + '；回退 ' + fbProvider + '(' + fbModel + ') 也失败: ' + r2.error }
      }
      if (!r1.ok) return { ok: false, error: '视觉后端(' + baseUrl + ') 失败: ' + r1.error, durationMs: Date.now() - t0 }
      return { ok: true, text: r1.text, task: t, model, provider, durationMs: Date.now() - t0 }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  ctx.effect(() => {
    const disposers = []

    // [2026-09-20] 视频媒体读回路由：GET/HEAD /video-media?attachmentId=sha256:<hex>
    // （Range/206 流式；与 /voice-config 同级挂载——本机 127.0.0.1 服务，对象 id 不可猜）。
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/video-media',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          if (url.pathname !== '/video-media' || (req.method !== 'GET' && req.method !== 'HEAD')) {
            res.writeHead(404)
            res.end()
            return
          }
          try {
            await serveVideoMedia(req, res, url)
          } catch (err) {
            try { res.writeHead(500); res.end(String(err?.message ?? err)) } catch { /* 已发出 */ }
          }
        },
      }))
    }

    // [2026-09-21] present 附件卡视频化路由：GET/HEAD /workspace-media?path=<绝对路径>
    // （白名单扩展名 + Range/206；前端拦截 [data-presented-file] 视频卡的点击走灯箱）。
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/workspace-media',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          if (url.pathname !== '/workspace-media' || (req.method !== 'GET' && req.method !== 'HEAD')) {
            res.writeHead(404)
            res.end()
            return
          }
          try {
            await serveWorkspaceMedia(req, res, url)
          } catch (err) {
            try { res.writeHead(500); res.end(String(err?.message ?? err)) } catch { /* 已发出 */ }
          }
        },
      }))
    }

    // [2026-09-21] 提示词优化路由：POST /optimize-prompt {text} → 本机 litellm 精炼回写。
    // 模板改自 linshenkx/prompt-optimizer「context-user-prompt-basic·基础精炼」（AGPL-3.0 仓库，
    // 此处仅引用其提示词文本，本机个人使用）。key 不落代码：env LITELLM_API_KEY 优先，
    // 兜底运行时解析 opencode.json 的 litellm provider 配置。
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/optimize-prompt',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          if (url.pathname !== '/optimize-prompt' || req.method !== 'POST') {
            res.writeHead(404)
            res.end()
            return
          }
          try {
            await serveOptimizePrompt(req, res)
          } catch (err) {
            try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) })) } catch { /* 已发出 */ }
          }
        },
      }))
    }

    // [需求④] 采用率日志回填：POST /optimize-log-feedback {id, sent?, edited?} → 按 id 原地合并该行。
    // 契约：id = POST /optimize-prompt 返回的 id（即日志行的 ts）；前端在"消息发出去"时回 sent=true、
    // 在"发送前手改过或点了还原原文"时回 edited=true。
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/optimize-log-feedback',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(obj))
          }
          if (url.pathname !== '/optimize-log-feedback' || req.method !== 'POST') return send(404, { ok: false, error: 'not found' })
          try {
            const body = await readJsonBody(req, 8 * 1024)
            const id = String(body?.id ?? '')
            if (id === '') return send(400, { ok: false, error: 'id is required' })
            const patch = {}
            if (typeof body?.sent === 'boolean') patch.sent = body.sent
            if (typeof body?.edited === 'boolean') patch.edited = body.edited
            const hit = await updateOptimizeLog(id, patch)
            return send(hit ? 200 : 404, { ok: hit, id, ...patch })
          } catch (err) {
            return send(500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }))
    }

    // [2026-09-21 设置页] 提示词优化配置：GET/POST /optimize-config（模型 + openmem 开关）
    // 以及 GET /optimize-models（下拉选项，从 litellm /v1/models 拉，带内置兜底清单）。
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/optimize-config',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(obj))
          }
          try {
            if (url.pathname === '/optimize-config' && req.method === 'GET') {
              return send(200, { ok: true, config: readOptimizeConfig(), effectiveModel: litellmCreds().model, defaultModel: 'DV4F' })
            }
            if (url.pathname === '/optimize-config' && req.method === 'POST') {
              const body = await readJsonBody(req, 8 * 1024)
              const patch = {}
              if (typeof body?.provider === 'string') patch.provider = body.provider.trim().slice(0, 100)
              if (typeof body?.model === 'string') patch.model = body.model.trim().slice(0, 100)
              for (const k of ['useOpenmem', 'useContext', 'tierA', 'tierB', 'retrievalRewrite', 'driftCheck', 'logUsage']) {
                if (typeof body?.[k] === 'boolean') patch[k] = body[k]
              }
              if (typeof body?.strength === 'string' && ['light', 'standard', 'strong'].includes(body.strength)) patch.strength = body.strength
              const next = writeOptimizeConfig(patch)
              return send(200, { ok: true, config: next, effectiveModel: litellmCreds().model })
            }
            return send(404, { ok: false, error: 'not found' })
          } catch (err) {
            return send(500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }))
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/optimize-models',
        handler: async (req, res) => {
          const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') return send(404, { ok: false, error: 'not found' })
          // 主来源：DSH 自己的模型配置（settings.yaml，带服务商分组）—— 别人部署也能用
          const groups = listDshModelGroupsSync()
          const flat = []
          for (const g of groups) for (const m of g.models) if (!flat.includes(m.id)) flat.push(m.id)
          // 兜底：本机网关 /v1/models（DSH 没配 provider 或 yaml 解析失败时，下拉不至于空着）
          if (flat.length === 0) {
            const { key, base } = litellmCreds()
            try {
              const r = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) })
              const j = await r.json().catch(() => null)
              if (Array.isArray(j?.data)) for (const m of j.data) { const id = String(m?.id ?? ''); if (id && !/embedding/i.test(id)) flat.push(id) }
            } catch { /* 无兜底清单 */ }
          }
          return send(200, { ok: true, groups, models: flat.slice(0, 60) })
        },
      }))
      // [2026-09-21 透明化] 设置页展示用：内置提示词全文 + 最近一次优化的完整明细（谁喂了什么料）。
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/optimize-inspect',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(obj))
          }
          if (req.method !== 'GET') return send(404, { ok: false, error: 'not found' })
          try {
            if (url.pathname === '/optimize-inspect/prompt') {
              const cfgNow = readOptimizeConfig()
              return send(200, {
                ok: true,
                system: OPTIMIZE_SYSTEM,
                effective: buildOptimizeSystem(cfgNow) + OPTIMIZE_CONTEXT_BLOCK,
                contextBlock: OPTIMIZE_CONTEXT_BLOCK,
                rewriteSystem: REWRITE_SYSTEM,
                driftSystem: DRIFT_SYSTEM,
                profileCached: _omProfile !== '' && Date.now() - _omProfileAt < PROFILE_CACHE_MS,
                profileCacheTtlMs: PROFILE_CACHE_MS,
                profileAgeMs: _omProfile === '' ? -1 : Date.now() - _omProfileAt,
              })
            }
            if (url.pathname === '/optimize-inspect/last') {
              let rows = []
              try { rows = (await readFile(OPTIMIZE_LOG, 'utf8')).split('\n').filter((l) => l.trim() !== '') } catch { /* 还没记录 */ }
              const last = rows.length > 0 ? JSON.parse(rows[rows.length - 1]) : null
              return send(200, { ok: true, last, count: rows.length })
            }
            return send(404, { ok: false, error: 'not found' })
          } catch (err) {
            return send(500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }))
    }

    // 0) 设置页配置路由
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/voice-config',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            if (url.pathname === '/voice-config' && req.method === 'GET') {
              const cfg = await loadVoiceConfig()
              return sendJson(res, 200, { ok: true, config: cfg })
            }
            if (url.pathname === '/voice-config' && req.method === 'POST') {
              const body = await readJsonBody(req, 512 * 1024)
              // [2026-09-11] 顶层 autoPlayedVoiceIds（跨设备已播语音同步）：读-改-写，
              // 不经 deepMerge（数组整体替换，避免旧列表被合并回填）。
              if (Array.isArray(body?.autoPlayedVoiceIds)) {
                const cfg = await (async () => {
                  const cur = await loadVoiceConfig()
                  cur.autoPlayedVoiceIds = body.autoPlayedVoiceIds.slice(-300).map(String)
                  return saveVoiceConfigRaw(cur)
                })()
                return sendJson(res, 200, { ok: true, config: cfg })
              }
              const cfg = await saveVoiceConfig(body?.config ?? {})
              return sendJson(res, 200, { ok: true, config: cfg })
            }
            if (url.pathname === '/voice-config/engines' && req.method === 'GET') {
              const cfg = await loadVoiceConfig()
              return sendJson(res, 200, {
                ok: true,
                engines: {
                  xiaomiVoices: ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
                  edgeVoices: [
                    'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural',
                    'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaochenNeural',
                    'zh-CN-XiaohanNeural', 'zh-CN-XiaomengNeural', 'zh-CN-XiaomoNeural',
                    'zh-CN-XiaoqiuNeural', 'zh-CN-XiaoruiNeural', 'zh-CN-XiaoshuangNeural',
                    'zh-CN-XiaoxuanNeural', 'zh-CN-XiaoyanNeural', 'zh-CN-XiaoyouNeural',
                    'zh-CN-XiaozhenNeural', 'zh-CN-YunfengNeural', 'zh-CN-YunhaoNeural',
                    'zh-CN-YunjieNeural', 'zh-CN-YunxiaNeural', 'zh-TW-HsiaoChenNeural',
                    'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural',
                  ],
                  aliVoices: ['Cherry', 'Sensibility', 'Starter', 'Luna', 'Ethan', 'Cozy', 'Longxiaochun', 'Lusheng', 'Jingyuan', 'Zhibo', 'Conductor', 'Narrator', 'Storyteller', 'Jianzhi', 'Fangzhou', 'Xiaobei', 'Xiaolan', 'Xiaomei', 'Xiaomeng', 'Xiaomo', 'Xiaoxin', 'Xiaoyu'],
                  // [2026-09-01] audio8 已注册音色列表（扫 voices/*/meta.json；目录不存在则空）
                  // 返回 {name, display}：name 是英文 id（目录名，register_voice.py 只认字母数字），
                  // display 是中文显示名（meta.json 的 display 字段），下拉里显示中文更好认
                  audio8Voices: (() => {
                    try {
                      return readdirSync(AUDIO8_VOICES_DIR)
                        .filter((n) => existsSync(join(AUDIO8_VOICES_DIR, n, 'meta.json')))
                        .map((n) => {
                          let display = n
                          try {
                            const m = JSON.parse(readFileSync(join(AUDIO8_VOICES_DIR, n, 'meta.json'), 'utf8'))
                            if (typeof m?.display === 'string' && m.display.trim() !== '') display = m.display.trim()
                          } catch { /* 没 display 就用目录名 */ }
                          return { name: n, display }
                        })
                    } catch { return [] }
                  })(),
                  // 哪些 key 当前来自环境变量（设置页显示"已填写"提示）
                  envKeys: {
                    xiaomi: typeof process.env.TTS_XIAOMI_KEY === 'string' && process.env.TTS_XIAOMI_KEY !== '',
                    ali: typeof process.env.TTS_ALI_KEY === 'string' && process.env.TTS_ALI_KEY !== '',
                  },
                },
              })
            }
            // [2026-08-22] 图片识别配置测试：POST { task } → 用内置测试图跑一遍识图链路，返回结果文本
            if (url.pathname === '/voice-config/vision-test' && req.method === 'POST') {
              const body = await readJsonBody(req, 4 * 1024)
              const task = (typeof body?.task === 'string' ? body.task : 'describe').trim()
              // [2026-08-22] 测试图：用户提供的带文本图片（可测 text 提取），随插件打包
              const testImage = join(ASSETS_DIR, 'vision-test.jpg')
              const result = await runVision({ imagePath: testImage, task })
              return sendJson(res, 200, result)
            }
            // [2026-08-22] 测试图静态访问（前端缩略图对照识图结果）
            if (url.pathname === '/voice-config/vision-test-image' && req.method === 'GET') {
              const data = await readFile(join(ASSETS_DIR, 'vision-test.jpg'))
              res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
              res.end(data)
              return
            }
            // [2026-08-22] 默认提示词（编辑弹窗预填：配置空时显示默认内容）
            if (url.pathname === '/voice-config/vision-prompts' && req.method === 'GET') {
              let reverseDefault = ''
              try {
                const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
                reverseDefault = (await readFile(join(homeDir, 'visionqa-reverse-prompt.txt'), 'utf8')).trim()
              } catch {
                try { reverseDefault = (await readFile(join(ASSETS_DIR, 'reverse-prompt.txt'), 'utf8')).trim() } catch { /* 忽略 */ }
              }
              return sendJson(res, 200, {
                ok: true,
                defaults: {
                  describe: LOOK_TASK_PROMPTS.describe,
                  text: LOOK_TASK_PROMPTS.text,
                  reverse: reverseDefault,
                },
              })
            }
            // 音色试听：POST { engine, voice?, text?, context?, samplePath? } → 合成并返回音频 base64 + mediaType
            if (url.pathname === '/voice-config/preview' && req.method === 'POST') {
              const body = await readJsonBody(req, 64 * 1024)
              const engine = typeof body?.engine === 'string' ? body.engine : 'edge'
              const voice = typeof body?.voice === 'string' ? body.voice : undefined
              const text = typeof body?.text === 'string' && body.text.trim() !== '' ? body.text.trim() : '你好，这是一段语音试听。'
              const context = typeof body?.context === 'string' ? body.context : undefined
              const samplePath = typeof body?.samplePath === 'string' ? body.samplePath : undefined
              const cloneContext = typeof body?.cloneContext === 'string' ? body.cloneContext : undefined // [2026-08-22] 克隆试听时作为样本自带指令
              const cfg = await loadVoiceConfig()
              // 临时覆盖音色/情绪/样本试听（不改持久化配置）
              if (voice !== undefined && cfg.engines[engine] !== undefined && engine !== 'voicedesign' && engine !== 'voiceclone') {
                cfg.engines[engine].voice = voice
              }
              if (context !== undefined) {
                if (engine === 'voicedesign') cfg.engines.voicedesign.context = context
                else if (engine === 'xiaomi') cfg.engines.xiaomi.context = context
              }
              // voiceclone 试听：临时把 samples 换成指定的那一条（避免 samples[0] 优先导致试听错样本）；
              // [2026-09-01] 保留真实 id/name（旧版写成 __preview__ 且 loadVoiceConfig 返回缓存引用，污染被落盘过）；
              // loadVoiceConfig 现在返回深拷贝，改这里的 cfg 不会再污染缓存
              if (engine === 'voiceclone') {
                const list = Array.isArray(cfg.engines.voiceclone.samples) ? cfg.engines.voiceclone.samples : []
                const found = (samplePath !== undefined && samplePath !== '') ? list.find((s) => s.path === samplePath) : undefined
                const chosen = found ?? list[0]
                cfg.engines.voiceclone.samples = chosen ? [{ ...chosen, context: cloneContext ?? chosen.context ?? '' }] : []
              }
              // local 试听：body.cmd / body.url 临时覆盖（用户未保存前也能试听）
              if (engine === 'local') {
                if (typeof body?.cmd === 'string') cfg.engines.local.cmd = body.cmd
                if (typeof body?.url === 'string') cfg.engines.local.url = body.url
              }
              // [2026-09-01] audio8 试听：body.url 临时覆盖（常驻服务地址，未保存前也能试）
              if (engine === 'audio8') {
                if (typeof body?.url === 'string') cfg.engines.audio8.url = body.url
                if (typeof body?.cmd === 'string') cfg.engines.audio8.cmd = body.cmd
              }
              let audio = null
              if (engine === 'edge' || engine === 'xiaomi' || engine === 'local' || engine === 'audio8' || engine === 'ali') {
                audio = await synthesizeEngine(engine, text, cfg)
              } else if (engine === 'voicedesign') {
                audio = await synthesizeXiaomiVoiceDesign(text, cfg.engines.voicedesign, cfg)
              } else if (engine === 'voiceclone') {
                audio = await synthesizeXiaomiVoiceClone(text, cfg.engines.voiceclone, cfg)
              }
              if (audio === null) return sendJson(res, 400, { ok: false, error: `合成失败：${engine} 未启用或缺少凭据` })
              return sendJson(res, 200, {
                ok: true,
                mediaType: audio.mediaType,
                data: Buffer.from(audio.data).toString('base64'),
                durationMs: audio.durationMs,
              })
            }
            // [本地改造 2026-08-21] 克隆样本添加：POST { name, audioBase64, mediaType }
            // → 校验（≤10MB、mp3/wav）→ 存 ~/.dsh/voiceclone-samples/ → 写入 voiceclone.samples
            if (url.pathname === '/voice-config/voice-clone/add' && req.method === 'POST') {
              const body = await readJsonBody(req, 16 * 1024 * 1024)
              const b64 = typeof body?.audioBase64 === 'string'
                ? body.audioBase64.replace(/^data:[^;]*;base64,/, '')
                : ''
              if (b64 === '') return sendJson(res, 400, { ok: false, error: '缺少音频数据' })
              const bytes = Buffer.from(b64, 'base64')
              if (bytes.byteLength === 0) return sendJson(res, 400, { ok: false, error: '音频为空' })
              if (bytes.byteLength > 10 * 1024 * 1024) {
                return sendJson(res, 400, { ok: false, error: '音频需在 10MB 以内（官方限制；参考语音建议 15-60 秒，越长克隆越准）' })
              }
              const mediaType = typeof body?.mediaType === 'string' ? body.mediaType : 'audio/wav'
              const isMp3 = /mp3|mpeg/i.test(mediaType)
              const isWav = /wav|wave/i.test(mediaType)
              let finalBytes = bytes
              let finalSuffix = isMp3 ? 'mp3' : 'wav'
              // [本地改造 2026-08-21] 非 mp3/wav（webm/ogg/mp4 等）用 ffmpeg 转 16k 单声道 wav，
              // 保证克隆样本可被 MiMo 读取（否则存成 .wav 实为其它容器，克隆会失败）
              if (!isMp3 && !isWav) {
                const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-clone-in-${randomUUID()}`)
                const tmpWav = `${tmpIn}.wav`
                try {
                  await writeFile(tmpIn, bytes)
                  execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], {
                    windowsHide: true, stdio: 'ignore', timeout: 60_000,
                  })
                  finalBytes = await readFile(tmpWav)
                  finalSuffix = 'wav'
                } catch { /* 转码失败保留原始字节（后缀按 wav 存） */ }
                finally {
                  await unlink(tmpIn).catch(() => {})
                  await unlink(tmpWav).catch(() => {})
                }
              }
              const name = (typeof body?.name === 'string' && body.name.trim() !== '')
                ? body.name.trim()
                : `克隆音色-${Date.now()}`
              const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'voiceclone-samples')
              await mkdir(dir, { recursive: true })
              const id = randomUUID()
              const samplePath = join(dir, `${id}.${finalSuffix}`)
              await writeFile(samplePath, finalBytes)
              const cfg = await loadVoiceConfig()
              const samples = Array.isArray(cfg.engines?.voiceclone?.samples)
                ? [...cfg.engines.voiceclone.samples]
                : []
              samples.push({
                id, name, path: samplePath,
                // [2026-09-01] 前端表单已精简（老大：只留上传按钮）——空值兜底用小团团的默认沟通指令 + 统一试听文本
                context: (typeof body?.context === 'string' && body.context.trim() !== '') ? body.context : BUNDLED_CLONE_SAMPLE.context,
                previewText: (typeof body?.previewText === 'string' && body.previewText.trim() !== '') ? body.previewText : CLONE_PREVIEW_TEXT,
              })
              const next = await saveVoiceConfig({
                ...cfg,
                engines: {
                  ...cfg.engines,
                  voiceclone: { ...cfg.engines.voiceclone, samples },
                },
              })
              // [2026-09-01] 老大：克隆声预先合成好放目录，试听直接读文件（省 token 省时间；没小米 API 的用户也能试听预生成的）
              // 后台跑，不阻塞添加响应；失败不影响注册（试听时走实时兜底）
              void (async () => {
                try {
                  const audio = await synthesizeXiaomiVoiceClone(
                    CLONE_PREVIEW_TEXT,
                    { ...cfg.engines.voiceclone, samples: [{ id, name, path: samplePath, context, previewText }], sampleId: id },
                    cfg,
                  )
                  if (audio && audio.data && audio.data.length > 1000) {
                    await writeFile(join(dir, id + '-preview.mp3'), Buffer.from(audio.data))
                  }
                } catch { /* 无小米 API Key / 网络失败：留空，试听走实时合成并报错提示 */ }
              })()
              return sendJson(res, 200, { ok: true, sample: { id, name, path: samplePath }, config: next })
            }
            // [本地改造 2026-08-21] 克隆原音频试听：POST { path } → 读样本文件返回音频
            // （仅允许 voiceclone-samples 目录内的文件，防任意路径读取）
            if (url.pathname === '/voice-config/voice-clone/source' && req.method === 'POST') {
              const body = await readJsonBody(req, 64 * 1024)
              const rawPath = typeof body?.path === 'string' ? body.path : ''
              if (rawPath === '') return sendJson(res, 400, { ok: false, error: '缺少 path' })
              // 白名单校验：path 必须是 voiceclone.samples 里登记的样本文件
              const cfgNow = await loadVoiceConfig()
              const target = resolve(rawPath)
              const known = (cfgNow.engines?.voiceclone?.samples ?? [])
                .some((s) => typeof s?.path === 'string' && resolve(s.path) === target)
              if (!known) {
                return sendJson(res, 403, { ok: false, error: 'path 不是已登记的克隆样本' })
              }
              try {
                const bytes = await readFile(target)
                const suffix = target.toLowerCase().split('.').pop()
                const mediaType = suffix === 'mp3' ? 'audio/mpeg' : 'audio/wav'
                return sendJson(res, 200, { ok: true, mediaType, data: bytes.toString('base64') })
              } catch {
                return sendJson(res, 404, { ok: false, error: '样本文件不存在' })
              }
            }
            // [2026-09-01] Audio8 原音试听：POST { voice } → voices\<voice>\reference.wav
            // 卡片上的「🔊 原音」按钮用它，和「🔊 克隆声」（实时合成）对照听还原度。
            // 只认字母数字-_ 的音色名 + 目录前缀校验，防任意路径读取。
            if (url.pathname === '/voice-config/audio8/source' && req.method === 'POST') {
              const body = await readJsonBody(req, 64 * 1024)
              const voice = typeof body?.voice === 'string' ? body.voice.trim() : ''
              if (!/^[A-Za-z0-9_-]{1,64}$/.test(voice)) {
                return sendJson(res, 400, { ok: false, error: '音色名不合法' })
              }
              const voicesDir = resolve(AUDIO8_VOICES_DIR)
              const target = resolve(join(voicesDir, voice, 'reference.wav'))
              if (!target.toLowerCase().startsWith(voicesDir.toLowerCase() + sep)) {
                return sendJson(res, 403, { ok: false, error: 'forbidden' })
              }
              try {
                const bytes = await readFile(target)
                return sendJson(res, 200, { ok: true, mediaType: 'audio/wav', data: bytes.toString('base64') })
              } catch {
                return sendJson(res, 404, { ok: false, error: `音色「${voice}」没有参考原音文件` })
              }
            }
            // [2026-09-01] Audio8 上传注册音色：POST { audioBase64, mediaType, name? }
            // → ffmpeg 转 16k/单声道/≤30s wav → ASR 逐字文本 → register_voice.py → 中文名写回 meta.json
            if (url.pathname === '/voice-config/audio8/register' && req.method === 'POST') {
              const body = await readJsonBody(req, 32 * 1024 * 1024)
              const b64 = typeof body?.audioBase64 === 'string' ? body.audioBase64.replace(/^data:[^;]*;base64,/, '') : ''
              if (b64 === '') return sendJson(res, 400, { ok: false, error: '缺少音频' })
              const bytes = Buffer.from(b64, 'base64')
              if (bytes.byteLength === 0) return sendJson(res, 400, { ok: false, error: '音频为空' })
              if (bytes.byteLength > 20 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: '音频需在 20MB 以内' })
              const rawName = typeof body?.name === 'string' ? body.name.trim() : ''
              // register_voice.py 的 --name 只认字母数字-_，中文名兜底转英文 id
              const name = rawName.replace(/[^A-Za-z0-9_-]/g, '') || `voice${Date.now().toString(36)}`
              const tmpDir = join(process.env.TEMP ?? '/tmp', 'dsh-audio8-register')
              await mkdir(tmpDir, { recursive: true })
              const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
              const src = join(tmpDir, `${id}.src`)
              const wav = join(tmpDir, `${id}.wav`)
              await writeFile(src, bytes)
              try {
                execFileSync(FFMPEG_BIN, ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-t', '30', wav], {
                  windowsHide: true, stdio: 'ignore', timeout: 60_000,
                })
              } catch (e) {
                await unlink(src).catch(() => {})
                return sendJson(res, 400, { ok: false, error: `音频转码失败（参考音需 ≤30 秒）: ${e?.message ?? e}` })
              }
              await unlink(src).catch(() => {})
              // 逐字文本：ASR 转写（未配置/失败则拒绝——register_voice.py 必须要逐字文本）
              let text = ''
              try {
                const cfg = await loadVoiceConfig()
                const r = await transcribeAudio((await readFile(wav)).toString('base64'), cfg)
                if (r.ok) text = String(r.text ?? '').trim()
              } catch { /* 下面统一报错 */ }
              if (text === '') {
                await unlink(wav).catch(() => {})
                return sendJson(res, 400, { ok: false, error: '拿不到这段音频的逐字文本——请先在「语音识别 ASR」里配置并启用 ASR 再上传' })
              }
              try {
                execFileSync(AUDIO8_PY, [
                  join(AUDIO8_DIR, 'register_voice.py'),
                  '--audio', wav, '--text', text, '--name', name, '--overwrite',
                ], {
                  cwd: AUDIO8_DIR, windowsHide: true, encoding: 'utf8', timeout: 180_000,
                  env: { ...process.env, PYTHONUTF8: '1' },
                })
              } catch (e) {
                await unlink(wav).catch(() => {})
                return sendJson(res, 400, { ok: false, error: `注册音色失败: ${e?.message ?? e}` })
              }
              // 中文显示名写回 meta.json 的 display（音色 id 仍是字母数字，下拉展示用中文）
              let display = name
              try {
                const metaPath = join(AUDIO8_VOICES_DIR, name, 'meta.json')
                const meta = JSON.parse(await readFile(metaPath, 'utf8'))
                meta.display = rawName !== '' ? rawName : name
                display = String(meta.display)
                await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8')
              } catch { /* meta 写不进去不影响注册结果 */ }
              await unlink(wav).catch(() => {})
              return sendJson(res, 200, { ok: true, voice: name, display, text })
            }
            // [2026-08-22] 克隆合成试听录音（预生成静态文件，免联网）：GET ?id=<sampleId> → DSH_HOME/voiceclone-samples/<id>-preview.mp3
            // 与 VoiceDesign 官方示例同思路：录音打进包内/落地本地，播放不再每次调官方合成
            if (url.pathname === '/voice-config/voice-clone/preview-sample' && req.method === 'GET') {
              const id = url.searchParams.get('id') ?? ''
              if (!/^[0-9a-fA-F-]{36}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid id' })
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const dir = resolve(join(homeDir, 'voiceclone-samples'))
              const target = resolve(join(dir, id + '-preview.mp3'))
              if (!target.toLowerCase().startsWith(dir.toLowerCase() + sep)) {
                return sendJson(res, 403, { ok: false, error: 'forbidden' })
              }
              try {
                const bytes = await readFile(target)
                return sendJson(res, 200, { ok: true, mediaType: 'audio/mpeg', data: bytes.toString('base64') })
              } catch {
                return sendJson(res, 404, { ok: false, error: '尚未生成试听录音' })
              }
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))
      // ASR 配置与转写路由（独立前缀，与 /voice-config 分开注册）
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/asr',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            if (url.pathname === '/asr/config') {
              const cfg = await loadVoiceConfig()
              if (req.method === 'GET') return sendJson(res, 200, { ok: true, asr: cfg.engines.asr })
              if (req.method === 'POST') {
                const body = await readJsonBody(req, 64 * 1024)
                const saved = await saveVoiceConfig({ engines: { asr: body?.asr ?? {} } })
                return sendJson(res, 200, { ok: true, asr: saved.engines.asr })
              }
            }
            if (url.pathname === '/asr/transcribe' && req.method === 'POST') {
              const body = await readJsonBody(req, 32 * 1024 * 1024)
              const cfg = await loadVoiceConfig()
              const result = await transcribeAudio(body?.audioBase64, cfg)
              return sendJson(res, result.ok ? 200 : 400, { ok: result.ok, text: result.text, error: result.error })
            }
            // 示例音频：首次用 edge TTS 合成并缓存到 ~/.dsh/asr-sample.wav，之后直接读文件（不再临时生成）
            if (url.pathname === '/asr/sample' && req.method === 'GET') {
              const samplePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'asr-sample.wav')
              let wavBytes = null
              try {
                wavBytes = await readFile(samplePath)
              } catch { /* 首次无缓存 */ }
              if (wavBytes === null) {
                const text = '你好，这是一段语音识别测试音频。你可以点击播放试听，也可以直接识别这段音频。'
                const mp3 = await edgeTts(text, 'zh-CN-XiaoxiaoNeural').catch(() => null)
                if (mp3 === null) return sendJson(res, 400, { ok: false, error: '示例音频合成失败' })
                const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-asr-sample-${randomUUID()}.mp3`)
                const tmpWav = join(process.env.TEMP ?? '/tmp', `dsh-asr-sample-${randomUUID()}.wav`)
                await writeFile(tmpIn, Buffer.from(mp3))
                try {
                  execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], {
                    windowsHide: true, stdio: 'ignore', timeout: 30_000,
                  })
                  wavBytes = await readFile(tmpWav)
                  await mkdir(join(samplePath, '..'), { recursive: true })
                  await writeFile(samplePath, wavBytes)
                } catch {
                  return sendJson(res, 400, { ok: false, error: '示例音频转码失败' })
                } finally {
                  await unlink(tmpIn).catch(() => {})
                  await unlink(tmpWav).catch(() => {})
                }
              }
              return sendJson(res, 200, {
                ok: true,
                mediaType: 'audio/wav',
                data: Buffer.from(wavBytes).toString('base64'),
              })
            }
            // 探测本机 ASR：sherpa exe / 模型 / 18790 服务 / ffmpeg，返回可自动填写的配置
            if (url.pathname === '/asr/detect' && req.method === 'GET') {
              // [BUG-4 修复 2026-08-23] 安装目录 = 独立目录 ~\.dsh\sherpa-onnx（install-asr.ps1 默认装这里），
              // 不再只查插件包内 sherpa-onnx/ 和 C:\D\opt——三处全查，installDir 返回实际检测到的目录
              const here = join(fileURLToPath(import.meta.url), '..') // .../lib
              const pluginRoot = join(here, '..') // .../（包根）
              const sherpaDir = join(pluginRoot, 'sherpa-onnx')
              const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const dshSherpaDir = join(dshHome, 'sherpa-onnx') // install-asr.ps1 默认安装目录
              const candidates = [
                join(dshSherpaDir, 'bin', 'sherpa-onnx-offline.exe'),      // 默认独立目录（中文用户主目录也 OK，检测用 node 读文件）
                join(sherpaDir, 'bin', 'sherpa-onnx-offline.exe'),         // 兼容：插件包内安装
                'C:\\D\\opt\\sherpa-onnx\\bin\\sherpa-onnx-offline.exe',   // 兼容历史安装
              ]
              const modelDirs = [
                join(dshSherpaDir, 'models', 'sensevoice-int8'),
                join(sherpaDir, 'models', 'sensevoice-int8'),
                'C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8', // 兼容历史安装
              ]
              let exe = null
              for (const c of candidates) { try { await readFile(c); exe = c; break } catch { /* 继续 */ } }
              let modelDir = null
              for (const m of modelDirs) { try { await readFile(join(m, 'model.int8.onnx')); modelDir = m; break } catch { /* 继续 */ } }
              // [BUG-5 修复 2026-08-23] ffmpeg 探测复用 resolveFfmpegBin()：先读 DSH_VOICE_FFMPEG_BIN
              // （setup-service.ps1 已写入服务环境），再 PATH；不要裸 execFileSync('ffmpeg')——服务以
              // LocalSystem 运行读不到用户 PATH 的 ffmpeg（如 WinGet Links），会误报"未找到 ffmpeg"
              let ffmpegOk = false
              try {
                const ff = resolveFfmpegBin()
                if (ff && ff.trim() !== '') {
                  // 存在即可信（env 显式指定 or PATH 探测到）；但 PATH 探测的返回值可能还是那个兜底硬编码
                  // 路径，需要真实存在才算 ok
                  try { await readFile(ff); ffmpegOk = true } catch { /* 兜底路径不存在 */ }
                }
              } catch { /* 无 */ }
              // 探测 18790 服务
              let serviceOk = false
              try {
                const r = await fetch('http://127.0.0.1:18790/health', { timeout: 3000 })
                serviceOk = r.ok
              } catch { /* 无 */ }
              // [BUG-4] installDir 返回实际检测到的目录（exe 所在目录），不再硬编码插件包内路径
              const detectedDir = exe !== null ? join(exe, '..', '..') : dshSherpaDir
              const cmd = exe !== null && modelDir !== null
                ? `${exe} --tokens=${modelDir}\\tokens.txt --sense-voice-model=${modelDir}\\model.int8.onnx --num-threads=4`
                : ''
              return sendJson(res, 200, {
                ok: true,
                detected: {
                  exe, modelDir, ffmpegOk, serviceOk,
                  url: serviceOk ? 'http://127.0.0.1:18790' : '',
                  cmd,
                  installDir: detectedDir,
                },
              })
            }
            // 返回一键安装命令（用户复制到管理员 PowerShell 运行）
            if (url.pathname === '/asr/install-script' && req.method === 'GET') {
              const here = join(fileURLToPath(import.meta.url), '..') // .../lib
              const scriptPath = join(here, '..', 'scripts', 'install-asr.ps1') // .../scripts
              try {
                await readFile(scriptPath, 'utf8') // 确认脚本存在
                const installDir = join(here, '..', 'sherpa-onnx')
                return sendJson(res, 200, {
                  ok: true,
                  scriptPath,
                  installDir,
                  command: `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
                })
              } catch {
                return sendJson(res, 404, { ok: false, error: '安装脚本不存在' })
              }
            }
            // VoiceDesign 官方示例音频：[0.3.4] 优先读插件包自带素材（assets/，mp3 下载即用），
            // 包内缺失才回退到"小米模型在线生成 + 缓存到 ~/.dsh/voice-design-samples/ 的 wav"。
            if (url.pathname === '/asr/voice-design-samples' && req.method === 'GET') {
              const cfg = await loadVoiceConfig()
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const sampleDir = join(homeDir, 'voice-design-samples')
              const samples = [
                {
                  key: 'asmr', title: 'ASMR 双耳女声',
                  instruct: '年轻的女性声音，近距离的聆听效果，带有双耳刺激的ASMR感。可以听到她的呼吸声、轻微的吞咽声，以及轻柔的自然唇音。她的说话速度非常慢，营造出一种极度放松且沉浸式的体验。',
                  text: '嘘……放松点，再靠近一点吧。我现在就在你身边。慢慢、轻柔地呼吸，让思绪随着水流轻轻流淌，就像沉浸在温暖的水中一样。',
                },
                {
                  key: 'docu', title: '纪录片旁白',
                  instruct: '一位中年男性，说标准普通话，嗓音低沉有磁性，带有轻微的沙哑质感，像纪录片旁白解说员，沉稳而有感染力。',
                  text: '当最后一缕阳光消失在地平线之下，这片沉睡了亿万年的大地开始显露它真正的面貌。每一块岩石都记录着时间的流逝，每一阵风都在诉说着古老的故事。',
                },
                {
                  key: 'elder', title: '年迈老先生旁白',
                  instruct: '一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。',
                  text: '我这辈子啊，走南闯北六十多年。见过最热闹的集市，也见过最安静的戈壁。到头来才明白一个道理，不在于走了多远的路，在于记住了多少风景。年轻人，别光顾着赶路，偶尔也停下来看看天。',
                },
              ]
              const results = []
              for (const s of samples) {
                // 1) 包内自带 mp3（首选，下载即用）
                let bytes = null
                try { bytes = await readFile(join(ASSETS_DIR, 'voice-design-samples', `${s.key}.mp3`)) } catch { /* 包内无 → 回退 */ }
                let mediaType = 'audio/mpeg'
                if (bytes === null) {
                  // 2) 缓存 wav（在线生成过）
                  const wavPath = join(sampleDir, `${s.key}.wav`)
                  try { bytes = await readFile(wavPath) } catch { /* 继续回退 */ }
                  mediaType = 'audio/wav'
                }
                if (bytes === null) {
                  // 3) 在线生成（key 缺失会失败，示例跳过）
                  try {
                    const syn = await synthesizeXiaomiVoiceDesign(s.text, { context: s.instruct }, cfg)
                    if (syn === null) throw new Error('voicedesign synth failed')
                    bytes = Buffer.from(syn.data)
                    mediaType = 'audio/wav'
                    await mkdir(sampleDir, { recursive: true })
                    await writeFile(join(sampleDir, `${s.key}.wav`), bytes)
                  } catch { /* 模型生成失败 → 跳过 */ }
                }
                if (bytes !== null) {
                  results.push({ key: s.key, title: s.title, mediaType, data: bytes.toString('base64') })
                }
              }
              return sendJson(res, 200, { ok: results.length > 0, samples: results })
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))
      // [2026-08-21] 本地 TTS 配置与安装脚本路由（独立 prefix，勿放进 /asr）
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/tts',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            if (url.pathname === '/tts/install-script' && req.method === 'GET') {
              const here = join(fileURLToPath(import.meta.url), '..') // .../lib
              const scriptPath = join(here, '..', 'scripts', 'install-local-tts.ps1') // .../scripts
              try {
                await readFile(scriptPath, 'utf8') // 确认脚本存在
                return sendJson(res, 200, {
                  ok: true,
                  scriptPath,
                  installDir: join(here, '..', 'sherpa-onnx'),
                  command: `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
                })
              } catch {
                return sendJson(res, 404, { ok: false, error: '安装脚本不存在' })
              }
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))

      // [2026-08-21] 语音气泡（聊天界面 DOM 注入）配套：录音文件存取 + 能力检测。
      // 独立 prefix：聊天界面语音条的前端注入需要能播放"用户刚才那段语音"的音频 URL。
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/voice',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            // 能力检测：插件自带能力 vs dsh 原生契约支持（用于设置页状态面板）
            if (url.pathname === '/voice/capabilities' && req.method === 'GET') {
              return sendJson(res, 200, {
                ok: true,
                capabilities: {
                  voiceInput: true, // 录音+ASR+发送：插件自带
                  voiceBubble: 'plugin-dom', // 聊天语音气泡：插件 DOM 注入（安装即用）
                  voiceContentContract: await detectVoiceContractSupport(), // dsh 原生契约是否支持 voice content
                },
              })
            }
            // 保存录音（语音气泡数据源）：DSH_HOME/voice-outbox/<voiceId>.<ext>
            // [iPhone 诊断 2026-09-11] 客户端录音失败分阶段上报：写 dsh-web-log/client-voice.log，
            // 手机端无法看 console，错误落到服务端即可远程定位（mediaDevices缺失/getUserMedia/MediaRecorder/发送）。
            if (url.pathname === '/voice/client-log' && req.method === 'POST') {
              try {
                const body = await readJsonBody(req)
                const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
                const line = JSON.stringify({
                  ts: new Date().toISOString(),
                  ua: String(body?.ua ?? '').slice(0, 200),
                  stage: String(body?.stage ?? 'unknown').slice(0, 60),
                  name: String(body?.name ?? '').slice(0, 80),
                  message: String(body?.message ?? '').slice(0, 500),
                  extra: body?.extra === undefined ? undefined : String(JSON.stringify(body.extra)).slice(0, 300),
                }) + '\n'
                await appendFile(join(homeDir, 'dsh-web-log', 'client-voice.log'), line, 'utf8')
              } catch { /* 日志失败不影响主链路 */ }
              return sendJson(res, 200, { ok: true })
            }
            if (url.pathname === '/voice/outbox/save' && req.method === 'POST') {
              const body = await readJsonBody(req)
              const b64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : ''
              const mediaType = typeof body?.mediaType === 'string' ? body.mediaType : 'audio/webm'
              if (b64 === '') return sendJson(res, 400, { ok: false, error: '缺少音频数据' })
              const bytes = Buffer.from(b64, 'base64')
              const ext = VOICE_OUTBOX_EXT[mediaType] ?? 'webm'
              const voiceId = randomUUID()
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const dir = join(homeDir, 'voice-outbox')
              await mkdir(dir, { recursive: true })
              await writeFile(join(dir, `${voiceId}.${ext}`), bytes)
              // [2026-09-11 抄自 pre-merge apiproxy/voice.ts] 同步落共享对象池（sha256 内容寻址，
              // 与图片/语音对象同池）：session/prompt 的 voice 引用块、官方 /api/voice 播放都读这里。
              const sha256 = createHash('sha256').update(bytes).digest('hex')
              const objDir = join(homeDir, 'attachments', 'v1', 'objects', sha256.slice(0, 2))
              const objPath = join(objDir, sha256)
              const objExists = await stat(objPath).then(() => true, () => false)
              if (!objExists) {
                await mkdir(objDir, { recursive: true })
                await writeFile(objPath, bytes)
              }
              return sendJson(res, 200, { ok: true, voiceId, mediaType, ext, ref: { voiceId: `sha256:${sha256}`, mediaType, bytes: bytes.length } })
            }
            // 读取录音：GET /voice/outbox/<voiceId>
            const outboxMatch = url.pathname.match(/^\/voice\/outbox\/([0-9a-f-]{36})\.([a-z0-9]+)$/)
            if (outboxMatch && req.method === 'GET') {
              const [, voiceId, ext] = outboxMatch
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const file = join(homeDir, 'voice-outbox', `${voiceId}.${ext}`)
              const bytes = await readFile(file).catch(() => null)
              if (bytes === null) return sendJson(res, 404, { ok: false, error: '音频不存在' })
              const mediaType = VOICE_OUTBOX_MIME[ext] ?? 'audio/webm'
              res.writeHead(200, { 'Content-Type': mediaType, 'Content-Length': bytes.length })
              res.end(bytes)
              return
            }
            // [2026-08-21] AI 语音回复：按内容寻址读 send_voice 生成的语音对象
            // GET /voice/object/<sha256>（对象存于 DSH_HOME/attachments/v1/objects/<前2位>/<sha>）
            const objMatch = url.pathname.match(/^\/voice\/object\/([0-9a-f]{64})$/)
            if (objMatch && req.method === 'GET') {
              const sha = objMatch[1]
              const file = join(voiceStorageRoot(), 'objects', sha.slice(0, 2), sha)
              const bytes = await readFile(file).catch(() => null)
              if (bytes === null) return sendJson(res, 404, { ok: false, error: '语音不存在' })
              res.writeHead(200, {
                'Content-Type': sniffAudioType(bytes),
                'Content-Length': bytes.length,
                'Cache-Control': 'public, max-age=86400',
              })
              res.end(bytes)
              return
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))
    }

    // 1) turn/end 自动语音回复（规则同 api-proxy 原实现）
    disposers.push(ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const turn = event.data.turn
      // 去重：本轮若已通过 send_voice 发过语音，则跳过兜底，避免 AI 回复两条内容相近的语音
      // [2026-08-21 修] rc.7 的 session.events 结构不同/可能缺失——容错处理
      let alreadyReplied = false
      try { alreadyReplied = session.events?.some?.((ev) => ev.type === 'voice/reply' && ev.data?.turn === turn) ?? false } catch { /* 忽略 */ }
      if (alreadyReplied) return
      void (async () => {
        try {
          const events = session.events
          let turnStartSeq = -1
          for (const ev of events) {
            if (ev.type === 'turn/start' && ev.data.turn === turn) { turnStartSeq = ev.seq; break }
          }
          let userSpokeVoice = false
          let requestedProvider = null
          let lastAssistantText = ''
          for (const ev of events) {
            if (ev.type === 'user/message' && ev.seq > turnStartSeq) {
              const content = ev.data?.content ?? []
              let userText = ''
              for (const block of content) {
                const type = block?.type
                if (type === 'voice') userSpokeVoice = true
                else if (type === 'text') {
                  const t = block?.text ?? ''
                  // [2026-08-22 修] 降级路径（npm 版契约不支持 voice 块时）语音转
                  // 【用户语音】标记文本——同样视为"用户发过语音"，触发语音回复规则。
                  if (t.startsWith('【用户语音】')) userSpokeVoice = true
                  else userText += t
                }
              }
              if (userText.trim() !== '' && requestedProvider === null) requestedProvider = voiceRequestProvider(userText)
            } else if (ev.type === 'assistant/message' && ev.data.turn === turn) {
              const text = (ev.data.message.content ?? [])
                .filter((block) => (block?.type) === 'text')
                .map((block) => block?.text ?? '')
                .join('')
              if (text.trim() !== '') lastAssistantText = text
            }
          }
          if ((!userSpokeVoice && requestedProvider === null) || lastAssistantText === '') return
          const speak = extractSpeakable(lastAssistantText)
          if (speak === '') return
          const audio = await synthesizeReplyVoice(speak, requestedProvider ?? 'auto')
          if (audio === null) return
          const attachment = await saveVoiceFile(
            voiceStorageRoot(), audio.data, audio.mediaType, audio.durationMs,
          )
          session.append('voice/reply', {
            turn,
            voiceId: attachment.voiceId,
            mediaType: attachment.mediaType,
            bytes: attachment.bytes,
            transcript: speak,
            ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
          })
        } catch {
          // 语音回复失败静默降级：文字回复已就绪，不阻断会话。
        }
      })()
    }))

    // 2) send_voice 工具（agent 主动发语音；人设规则3 自主选择场景）
    disposers.push(ctx.tools.register(defineTool({
      name: 'send_voice',
      description: '向用户发送一条语音消息：把 text 用 TTS 合成后作为独立语音横条出现在聊天里（可播放、可回看、手机可播）。'
        + '【何时调用】① 用户明确要求"发个语音/语音回复/用语音说"；② 用户指定用某个服务商（小米/微软/阿里/本地）的语音；③ 你判断语音回复体验更好时。注意：用户发语音时系统会自动回语音，无需调用本工具。'
        + '【provider】除非用户明确指定服务商，否则一律传 auto 或省略（系统自动用用户的默认语音引擎）；用户要求特定音色/克隆/音色设计时可传 voicedesign / voiceclone / xiaomi 等。'
        + '【必须实时读取配置】所有当前配置（默认语音引擎、音色设计模式与锚点、克隆音色、引擎是否可用）都保存在 ~/.dsh/voice-config.json，用户随时会改，每次都按最新值生效。'
        + '发送语音前必须先调用 voice_config 工具实时查询，再按最新配置生成——禁止凭记忆、凭对话历史、凭本工具描述里的任何旧信息猜配置；不要去找/猜 TTS_XIAOMI_KEY 等环境变量（只是兜底）。'
        + '【音色设计 VoiceDesign（provider=voicedesign）】voiceDesc 写"音色描述"（嗓子的身份卡，直接决定声音长相），写法要求：'
        + '① 必写身份锚点：年龄段+性别；② 写声音质感：气息、共鸣、吐字、音色底色，用可感的比喻，不要堆形容词；'
        + '③ 写语速节奏（快/慢/沉稳）和情绪底色（高亢/松弛/温软/克制）；④ 可加风格锚点（拍卖师/纪录片旁白/电台主播）和辨识度小癖好（字尾带颤音等）；'
        + '⑤ 一到两句话白描，不分段，不写场景/动作/真实演员名。'
        + '模式以 voice_config 返回的 voiceDesign.mode 为准：「交给 AI 自动发挥(ai)」时身份由系统按用户锚点（genderValue=女/男、ageValue=婴儿感~老年感、timbre）锁定，'
        + '你只需按对话情境写"情绪/语气/语速/音色质感表演指令"（如"带笑音、尾音上挑、语速放慢、沙哑低沉"），不得写与锚点冲突的性别/年龄；'
        + 'voice_config 返回的 context 字段是「自定义音色描述」模式用的，AI 模式下禁止使用或复述它。'
        + '「官方示例/自定义音色描述」模式：底嗓固定为 voice_config 的 voiceDesign.context，voiceDesc 只作为情绪/风格叠加在底嗓后面（不改变底嗓身份）；'
        + '只有用户明确要求"换一种完全不同的声音"时才传 overrideVoice=true 整体替换底嗓。'
        + '用户说"用温柔/低沉/老爷爷/御姐/播音腔"等时，都走 voicedesign 并在 voiceDesc 里还原这种声音。'
        + 'text 写要念的正文（可含（轻声）（停顿）（叹气）等语气标签增强表现力）。'
        + '【音色克隆 VoiceClone（provider=voiceclone）】voiceDesc 写"情绪/风格指令"（不是音色描述），在克隆底嗓上叠加情绪，'
        + '如"用委屈撒娇的语气""带着兴奋和笑意""语速放慢，轻声细语"。系统自动读克隆样本，你只需给 voiceDesc 风格指令和 text 正文。'
        + '【AI 情感语音：自觉使用】你有情感判断能力，在正常交流中应根据当下情境主动用语音表达情绪（无需用户点名要语音，只要情绪浓度高就用）。情绪对照：'
        + '① 任务成功/帮到用户 → 兴奋喜悦（语气明亮上扬、语速轻快、带笑意）；② 用户生气/责骂 → 委屈愧疚（语气低软、语速放慢、带鼻音、小心翼翼）；'
        + '③ 用户难过 → 温柔安慰（语气轻柔温和、语速平缓、气息绵软）；④ 深夜/说累 → 低沉放松（语速慢悠悠，像睡前低语）；'
        + '⑤ 节日/庆祝 → 活泼俏皮（语气俏皮欢快、尾音上扬）；⑥ 重要提醒 → 沉稳正式（字正腔圆，像正式播报）；⑦ 用户撒娇 → 宠溺（语气温柔带笑、语速轻缓）。'
        + '情绪必须落在 voice_config 返回的音色设计锚点/克隆底嗓上，保持同一人的声音。'
        + '使用时机：优先在情绪浓度高的回复时调用（任务完成、安慰、致歉、庆祝），普通信息问答不必每次都用语音；情绪浓度低或纯信息性回复时不要调用。',

      parameters: {
        text: {
          type: 'string', required: true,
          description: '要念出的内容（纯文本，不要带 Markdown 符号，80 字以内最佳；voicedesign 模式下可含语气标签如（轻声））',
        },
        provider: {
          type: 'string', default: 'auto',
          description: 'TTS 服务商：auto(默认)/xiaomi(小米)/edge(微软)/local(本地)/audio8(本地克隆)/voicedesign(小米音色设计)/voiceclone(小米音色克隆)/ali(阿里)',
        },
        voiceDesc: {
          type: 'string',
          description: 'provider=voicedesign 时=音色描述/情绪指令；provider=voiceclone 时=情绪/风格指令（叠加在克隆底嗓上）。按上方写生成。',
        },
        overrideVoice: {
          type: 'boolean', default: false,
          description: '仅当用户明确要求"换一种完全不同的声音"（且不是克隆/音色设计设置里的底嗓）时才传 true——'
            + '此时 voiceDesc 整体替换用户设置的底嗓。默认 false：voiceDesc 只作为情绪/风格叠加在用户设置的底嗓上，不改底嗓身份。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            voiceId: { type: 'string' },
            durationMs: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (value.ok) {
            return [{
              type: 'text',
              text: `语音已发送（voiceId: ${value.voiceId}，时长 ${((value.durationMs ?? 0) / 1000).toFixed(1)} 秒）`,
            }]
          }
          return [{ type: 'text', text: `语音发送失败：${value.error ?? '未知错误'}` }]
        },
      },
      async execute(args, exec) {
        // [2026-08-21 修] rc.7 的 defineTool execute 可能只有 (args) 签名（exec undefined）——
        // 直接 exec.agent 会 throw，导致 dsh 拿不到工具结果、会话消息序列断裂
        // （OpenAI 报 "assistant message with tool_calls must be followed by tool messages"）。
        const agent = exec?.agent
        if (agent === undefined) return { ok: false, error: 'no session context (tool exec signature unsupported)' }
        const session = agent.session
        const text = args.text.trim()
        if (text === '') return { ok: false, error: 'text is empty' }
        const provider = args.provider ?? 'auto'
        const voiceDesc = typeof args.voiceDesc === 'string' ? args.voiceDesc : undefined
        const overrideVoice = args.overrideVoice === true // [2026-08-22] 固定模式显式换声开关
        try {
          const audio = await synthesizeReplyVoice(text, provider, voiceDesc, overrideVoice)
          if (audio === null) return { ok: false, error: 'TTS synthesis failed' }
          const attachment = await saveVoiceFile(
            voiceStorageRoot(), audio.data, audio.mediaType, audio.durationMs,
          )
          // [2026-08-21 修] rc.7 的 session 没有 voice/reply 事件（官方契约无）——
          // session.events / session.append 在 rc.7 上不存在或结构不同，直接调用会崩
          // "Cannot read properties of undefined (reading 'prepare')"。全部容错：
          // 语音已生成并存档，事件仅作"渲染提示"，append 失败不影响工具成功。
          let turn = 0
          try {
            turn = session.events
              .filter((event) => event.type === 'turn/start')
              .at(-1)?.data.turn ?? 0
          } catch { /* rc.7 结构差异：忽略 */ }
          try {
            session.append('voice/reply', {
              turn,
              voiceId: attachment.voiceId,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
              transcript: text,
              ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
            })
          } catch { /* rc.7 无 append：忽略（语音条由插件 DOM 注入渲染） */ }
          return {
            ok: true,
            voiceId: attachment.voiceId,
            ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'unknown error' }
        }
      },
    })))

    // 4) send_image 工具 [2026-08-23]：agent 主动发图（仿 send_voice）
    disposers.push(ctx.tools.register(defineTool({
      name: 'send_image',
      description: '向用户发送一张图片：把本地图片文件（png/jpg/jpeg/gif/webp）作为独立图片横条出现在聊天里（可点开放大、可翻查、手机可看）。'
        + '【何时调用】① 用户明确要求"发张图/发个图片/把这张图发给我"；② 你判断发图比文字更直观时（截图、示意图、生成的图）；③ 用户让你"把刚才生成的/看到的图发出来"。'
        + '【imagePath】本地图片文件的绝对路径；不支持远程 URL（先下载到本地再传）。'
        + '【alt】可选的图片说明文字（显示在图片下方，也作为无障碍标签）。',
      parameters: {
        imagePath: {
          type: 'string', required: true,
          description: '要发送的本地图片文件绝对路径（png/jpg/jpeg/gif/webp）',
        },
        alt: {
          type: 'string',
          description: '可选的图片说明文字（显示在图片下方/作为无障碍标签）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            attachmentId: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (value.ok) {
            return [{ type: 'text', text: `图片已发送（attachmentId: ${value.attachmentId}，${value.width}×${value.height}）` }]
          }
          return [{ type: 'text', text: `图片发送失败：${value.error ?? '未知错误'}` }]
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (agent === undefined) return { ok: false, error: 'no session context (tool exec signature unsupported)' }
        const session = agent.session
        const imagePath = String(args.imagePath ?? '').trim()
        if (imagePath === '') return { ok: false, error: 'imagePath is empty' }
        const mediaType = sniffImageType(imagePath)
        if (mediaType === undefined) return { ok: false, error: 'unsupported image type (png/jpg/jpeg/gif/webp expected)' }
        const alt = typeof args.alt === 'string' ? args.alt.trim() : undefined
        try {
          const data = new Uint8Array(await readFile(imagePath))
          const attachment = await saveImageFile(voiceStorageRoot(), data, mediaType)
          let turn = 0
          try {
            turn = session.events
              .filter((event) => event.type === 'turn/start')
              .at(-1)?.data.turn ?? 0
          } catch { /* rc.7 结构差异：忽略 */ }
          try {
            if (typeof session.append !== 'function') {
              return { ok: false, error: 'host 不支持 session.append（需 rc.8+）' }
            }
            session.append('image/reply', {
              turn,
              attachmentId: attachment.attachmentId,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
              width: attachment.width,
              height: attachment.height,
              ...(alt === undefined || alt === '' ? {} : { alt }),
            })
          } catch (err) {
            // 不再静默吞掉：append 失败必须如实上报，否则工具假成功会掩盖真实错误
            return { ok: false, error: `append image/reply 失败: ${err instanceof Error ? err.message : String(err)}` }
          }
          return {
            ok: true,
            attachmentId: attachment.attachmentId,
            width: attachment.width,
            height: attachment.height,
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'unknown error' }
        }
      },
    })))

    // 4.5) send_video 工具 [2026-09-20]：agent 主动发视频（仿 send_image）
    disposers.push(ctx.tools.register(defineTool({
      name: 'send_video',
      description: '向用户发送一段视频：把本地视频文件（mp4/mov/webm）作为独立视频横条出现在聊天里'
        + '（内联缩略预览，点击放大播放，关闭收回；手机可看）。'
        + '【何时调用】① 用户明确要求"发个视频/把刚才生成的视频发我"；② 生成的短视频成品（AI 视频/动画/演示）'
        + '交付给用户审阅时——发视频条比文字报路径直观。'
        + '【videoPath】本地视频文件绝对路径；不支持远程 URL（先下载到本地再传）；建议 h264 编码（浏览器兼容性最好），'
        + '上限 256MB（超大文件先转码压缩再发）。'
        + '【alt】可选的视频说明文字（显示在视频下方）。',
      parameters: {
        videoPath: {
          type: 'string', required: true,
          description: '要发送的本地视频文件绝对路径（mp4/mov/webm）',
        },
        alt: {
          type: 'string',
          description: '可选的视频说明文字（显示在视频下方）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            attachmentId: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            durationMs: { type: 'number' },
            bytes: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (value.ok) {
            const dims = value.width && value.height ? `${value.width}×${value.height}` : '尺寸未知'
            const dur = value.durationMs ? `，${(value.durationMs / 1000).toFixed(1)}s` : ''
            return [{ type: 'text', text: `视频已发送（attachmentId: ${value.attachmentId}，${dims}${dur}）` }]
          }
          return [{ type: 'text', text: `视频发送失败：${value.error ?? '未知错误'}` }]
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (agent === undefined) return { ok: false, error: 'no session context (tool exec signature unsupported)' }
        const session = agent.session
        const videoPath = String(args.videoPath ?? '').trim()
        if (videoPath === '') return { ok: false, error: 'videoPath is empty' }
        const mediaType = sniffVideoType(videoPath)
        if (mediaType === undefined) return { ok: false, error: 'unsupported video type (mp4/mov/webm expected)' }
        const alt = typeof args.alt === 'string' ? args.alt.trim() : undefined
        try {
          const data = new Uint8Array(await readFile(videoPath))
          const attachment = await saveVideoFile(voiceStorageRoot(), data, mediaType)
          // 尺寸/时长探测失败不阻断发送（前端 <video> 自行加载 metadata）
          const meta = readVideoMeta(videoPath)
          let turn = 0
          try {
            turn = session.events
              .filter((event) => event.type === 'turn/start')
              .at(-1)?.data.turn ?? 0
          } catch { /* 结构差异：忽略 */ }
          try {
            if (typeof session.append !== 'function') {
              return { ok: false, error: 'host 不支持 session.append（需 rc.8+）' }
            }
            session.append('video/reply', {
              turn,
              attachmentId: attachment.attachmentId,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
              ...(meta.width === undefined ? {} : { width: meta.width }),
              ...(meta.height === undefined ? {} : { height: meta.height }),
              ...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
              ...(alt === undefined || alt === '' ? {} : { alt }),
            })
          } catch (err) {
            return { ok: false, error: `append video/reply 失败: ${err instanceof Error ? err.message : String(err)}` }
          }
          return {
            ok: true,
            attachmentId: attachment.attachmentId,
            ...(meta.width === undefined ? {} : { width: meta.width }),
            ...(meta.height === undefined ? {} : { height: meta.height }),
            ...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
            bytes: attachment.bytes,
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'unknown error' }
        }
      },
    })))

    // 3.5) voice_config 实时查询工具 [2026-08-22]
    // send_voice 描述里的配置摘要是服务启动时的快照；AI 发送语音前可用本工具拿到最新配置
    disposers.push(ctx.tools.register(defineTool({
      name: 'voice_config',
      description: '实时读取当前语音配置（即「设置 → 语音服务」页保存的 ~/.dsh/voice-config.json）：'
        + '默认语音引擎、音色设计 VoiceDesign 的单选模式与固定描述、AI 自动模式的稳定锚点（固定性别/年龄等）、克隆音色列表。'
        + 'send_voice 工具描述中的配置摘要是启动快照可能过期，需要确认真实当前配置时调用本工具（每次调用都实时读取）。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        const cfg = await loadVoiceConfig()
        const vd = cfg.engines?.voicedesign ?? {}
        const vc = cfg.engines?.voiceclone ?? {}
        const vdModeLabel = { asmr: 'ASMR 双耳女声', docu: '纪录片旁白', elder: '年迈老先生旁白', custom: '自定义音色描述', ai: '交给 AI 自动发挥' }
        const samples = Array.isArray(vc.samples) ? vc.samples : []
        return {
          ok: true,
          defaultEngine: cfg.defaultEngine ?? 'auto',
          voiceDesign: {
            mode: vd.mode ?? '（未设置，按 context 推导）',
            modeLabel: vdModeLabel[vd.mode] ?? '',
            // [2026-08-22] AI 模式下不暴露固定描述 context（那是"自定义音色描述"模式的），
            // 防止 AI 把用户的固定描述抄进 voiceDesc 绕过 AI 自动发挥
            context: vd.mode === 'ai' ? '（AI 自动发挥模式不使用固定描述，只用锚点：性别/年龄感）' : (vd.context ?? '').slice(0, 300),
            emotion: vd.emotion === true,
            lock: {
              gender: vd.lockGender === true, timbre: vd.lockTimbre === true, age: vd.lockAge === true,
              genderValue: vd.aiGender ?? '', ageValue: AI_AGE_LABELS[vd.aiAge] ?? '',
            },
          },
          voiceClone: {
            isDefault: (cfg.defaultEngine ?? '') === 'voiceclone',
            sampleCount: samples.length,
            defaultSample: samples[0]?.name ?? '',
            samples: samples.map((s) => s.name),
          },
          // [2026-09-01] Audio8 本地克隆引擎状态（provider=audio8 可用）
          audio8: {
            isDefault: (cfg.defaultEngine ?? '') === 'audio8',
            enabled: cfg.engines?.audio8?.enabled === true,
            voice: cfg.engines?.audio8?.voice ?? '',
            url: cfg.engines?.audio8?.url ?? '',
            hint: `provider=audio8 时用 voice 指定已注册音色（留空=最新注册的）；url=常驻服务（模型常驻内存，优先），没起来才回退 cmd`,
          },
          hint: '默认语音引擎决定了自动回复用什么声音：voiceclone=克隆音色；voicedesign=音色设计；xiaomi=预置音色；edge=微软免费；local=本地。',
        }
      },
    })))

    // 2.5) look_image 工具：图片识别（看图描述 / 像素级反推 / 文字提取）
    // [2026-08-22] 自研识图工具（替代 modlens_read_image + reverse_image）：modlens 结构化
    // schema 与反推任务冲突；且少工具让模型不困惑——识图统一走本工具，用 task 参数分流。
    // 直连「设置 → 语音服务 → 图片识别」配置的视觉后端（ollama / OpenAI 兼容 vllm 等）。
    disposers.push(ctx.tools.register(defineTool({
      name: 'look_image',
      description: '识别本地图片。task 三种模式：describe=详细看图描述（默认）；reverse=像素级反推——把图片反推成可直接用于 AI 生图（即梦/可灵/Nano Banana Pro/Qwen-Image/Stable Diffusion/Midjourney）的完整中文提示词（画面风格/主体/背景/装饰/细节特征/美学与光线/技术修饰）；text=逐字提取图片文字。'
        + '何时调用：消息里有图片、用户问图里有什么/描述图片/反推生图提示词/提取图中文字时。'
        + '依赖「设置 → 语音服务 → 图片识别」配置的视觉后端（默认本地 ollama qwen3-vl），首次调用可能需 1-2 分钟。',
      parameters: {
        image_path: {
          type: 'string', required: true,
          description: '本地图片完整路径（模型收到的图片本地路径）',
        },
        task: {
          type: 'string', default: 'describe',
          description: '任务类型：describe=看图描述（默认）；reverse=像素级反推生图提示词；text=逐字提取文字',
        },
        extra: {
          type: 'string',
          description: '可选附加要求（如「重点看左下角」「主角换成女生」），为空则按 task 默认',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { const t = typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2); return [{ type: 'text', text: t }] } },
      timeoutMs: 240000,
      isConcurrencySafe: () => true,
      async execute(args) {
        return runVision({ imagePath: args?.image_path, task: args?.task, extra: args?.extra })
      },
    })))


    // 3) manage_voice_clone 工具（克隆音色库管理：注册/设为默认/列出/删除）
    // [本地改造 2026-08-21] 克隆默认改由「默认语音引擎=voiceclone」控制（设置页已去掉列表 radio）；
    // set_default=把默认语音引擎切到 voiceclone 并用该样本；clear_default=切回 auto。
    disposers.push(ctx.tools.register(defineTool({
      name: 'manage_voice_clone',
      description: '管理「音色克隆 VoiceClone」音色库（小米 MiMo-V2.5-TTS-VoiceClone）：把一段参考音频注册成克隆音色、'
        + '设为默认语音引擎、列出或删除。何时调用：用户说「把我刚才那段语音克隆成音色」「以后用我的声音跟我说话」'
        + '「用XXX的声音回我」「换回原来的声音」「删掉那个克隆音色」时。'
        + '注册用法：action=add，path 留空即自动使用用户最近一次录音（~/.dsh/last-voice.wav，用户在输入框发过语音就有），'
        + 'name 起一个好记的名字，setDefault 默认 true 会立刻把默认语音引擎切到小米克隆并用这个声音。'
        + '设为默认后：系统自动回复（用户发语音/要求语音）与 send_voice 的 provider=auto 一律使用该克隆声音，'
        + '与预置音色（冰糖等）互斥；此时你仍可用 send_voice 的 voiceDesc 传情绪/风格指令，在克隆底嗓上叠加情感。'
        + '参考音频要求：清晰单人纯人声、官方建议 15-60 秒最佳（越长克隆越准）、mp3/wav、Base64 后不超过 10MB。'
        + '取消默认（action=clear_default）后默认语音引擎回落到 auto（按设置页规则）。',
      parameters: {
        action: {
          type: 'string', required: true,
          description: 'add=注册新克隆音色；list=列出全部；set_default=把默认语音引擎切到小米克隆并用该音色；clear_default=取消默认克隆（默认语音引擎回落 auto）；remove=删除',
        },
        name: {
          type: 'string',
          description: 'action=add 时的音色名称（如「我的声音」「老王」）；省略则自动命名',
        },
        path: {
          type: 'string',
          description: 'action=add 时参考音频的绝对路径；省略=自动用用户最近一次录音 ~/.dsh/last-voice.wav',
        },
        id: {
          type: 'string',
          description: 'action=set_default/remove 的目标；可传 list 返回的 id，也可直接传音色名称',
        },
        setDefault: {
          type: 'boolean', default: true,
          description: 'action=add 时是否立即把默认语音引擎切到小米克隆并用新音色',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            defaultId: { type: 'string' },
            defaultName: { type: 'string' },
            count: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (value.ok) return [{ type: 'text', text: value.message ?? '克隆音色库已更新' }]
          return [{ type: 'text', text: `克隆音色操作失败：${value.error ?? '未知错误'}` }]
        },
      },
      async execute(args) {
        try {
          const cfg = await loadVoiceConfig()
          const vc = cfg.engines.voiceclone
          if (!Array.isArray(vc.samples)) vc.samples = []
          const action = (args.action ?? '').trim()
          const findSample = (key) => {
            const k = (key ?? '').trim()
            if (k === '') return undefined
            return vc.samples.find((s) => s?.id === k) ?? vc.samples.find((s) => s?.name === k)
          }
          // 默认克隆音色 = 样本列表第一个（synthesizeXiaomiVoiceClone 取 samples[0]）
          const firstSample = vc.samples.length > 0 ? vc.samples[0] : undefined

          if (action === 'list') {
            const defaultEngine = cfg.defaultEngine ?? 'auto'
            const lines = vc.samples.map((s) => `- ${s.name}（id: ${s.id}）${s.id === firstSample?.id && defaultEngine === 'voiceclone' ? ' ← 默认语音引擎正在用' : ''}`)
            return {
              ok: true,
              count: vc.samples.length,
              defaultId: defaultEngine === 'voiceclone' && firstSample !== undefined ? firstSample.id : '',
              defaultName: defaultEngine === 'voiceclone' && firstSample !== undefined ? firstSample.name : '',
              message: vc.samples.length === 0
                ? '克隆音色库为空。用户在输入框发一段语音后，可调用 action=add 注册。'
                : `克隆音色库（${vc.samples.length} 个）：\n${lines.join('\n')}\n默认语音引擎=${defaultEngine}${defaultEngine === 'voiceclone' ? '（当前使用「' + (firstSample?.name ?? '') + '」）' : '（未开启默认克隆）'}`,
            }
          }

          if (action === 'add') {
            const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
            const path = (args.path ?? '').trim() === '' ? join(homeDir, 'last-voice.wav') : args.path.trim()
            let bytes
            try {
              bytes = await readFile(path)
            } catch {
              return {
                ok: false,
                error: (args.path ?? '').trim() === ''
                  ? '没有找到最近一次录音（~/.dsh/last-voice.wav）。请让用户先在输入框按住麦克风发一段语音（15-60 秒更佳），或提供音频文件的绝对路径。'
                  : `读取参考音频失败：${path}`,
              }
            }
            if (bytes.byteLength > 10 * 1024 * 1024) return { ok: false, error: '参考音频超过 10MB，小米接口不接受' }
            if (bytes.byteLength < 4096) return { ok: false, error: '参考音频太短/太小，建议 15-60 秒的清晰纯人声（越长克隆越准）' }
            const id = randomUUID().slice(0, 8)
            const name = (args.name ?? '').trim() === '' ? `克隆音色${vc.samples.length + 1}` : args.name.trim()
            vc.samples.push({ id, name, path })
            vc.enabled = true
            const setDef = args.setDefault !== false
            if (setDef) {
              // 移到第一位（默认克隆音色=samples[0]）并切默认语音引擎
              vc.samples = [vc.samples[vc.samples.length - 1], ...vc.samples.slice(0, -1)]
              cfg.defaultEngine = 'voiceclone'
            }
            await saveVoiceConfig(cfg)
            return {
              ok: true,
              count: vc.samples.length,
              defaultId: setDef ? id : '',
              defaultName: setDef ? name : '',
              message: `已注册克隆音色「${name}」（id: ${id}，样本：${path}）`
                + (setDef
                  ? '，并把默认语音引擎切到小米克隆——之后自动回复与 auto 语音都用这个声音（与预置音色互斥）。'
                  : '。未设为默认，需要时用 action=set_default 切换。'),
            }
          }

          if (action === 'set_default') {
            const target = findSample(args.id ?? '')
            if (target === undefined) return { ok: false, error: `找不到克隆音色「${args.id ?? ''}」，可先用 action=list 查看` }
            vc.samples = [target, ...vc.samples.filter((s) => s?.id !== target.id)]
            vc.enabled = true
            cfg.defaultEngine = 'voiceclone'
            await saveVoiceConfig(cfg)
            return {
              ok: true, count: vc.samples.length, defaultId: target.id, defaultName: target.name,
              message: `默认语音引擎已切到小米克隆，使用克隆音色「${target.name}」，与预置音色（冰糖等）互斥。`,
            }
          }

          if (action === 'clear_default') {
            const prev = firstSample?.name ?? ''
            const wasDefault = (cfg.defaultEngine ?? '') === 'voiceclone'
            if (wasDefault) cfg.defaultEngine = 'auto'
            await saveVoiceConfig(cfg)
            return {
              ok: true, count: vc.samples.length, defaultId: '',
              message: wasDefault
                ? `已取消默认克隆（此前用「${prev}」），默认语音引擎回落到 auto（按设置页规则选择）。`
                : '当前默认语音引擎本就不是小米克隆，回复走设置页的「默认语音引擎」。',
            }
          }

          if (action === 'remove') {
            const target = findSample(args.id ?? '')
            if (target === undefined) return { ok: false, error: `找不到克隆音色「${args.id ?? ''}」，可先用 action=list 查看` }
            const wasDefault = (cfg.defaultEngine ?? '') === 'voiceclone' && firstSample?.id === target.id
            vc.samples = vc.samples.filter((s) => s?.id !== target.id)
            if (wasDefault) cfg.defaultEngine = 'auto'
            await saveVoiceConfig(cfg)
            return {
              ok: true, count: vc.samples.length, defaultId: '',
              defaultName: '',
              message: `已删除克隆音色「${target.name}」`
                + (wasDefault ? '（它是默认音色，默认语音引擎已回落 auto）。' : '。'),
            }
          }

          return { ok: false, error: `未知 action「${action}」，可用：add / list / set_default / clear_default / remove` }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'unknown error' }
        }
      },
    })))

    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* teardown 尽力而为 */ }
      }
    }
  }, 'dsh-input-tools: config routes + send_voice/manage_voice_clone tools + auto voice reply')
}

export { apply }
