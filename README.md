# dsh-input-tools —— DSH Web 多功能增强插件

> 一句话定位：**给 DSH 配上眼睛、耳朵和嘴巴——而且全部免费。**

给 DSH Web 加全套实用能力：**眼睛**（文本模型也能发图识图）、**耳朵**（录音输入 / 离线 ASR）、**嘴巴**（多引擎 TTS / 音色克隆 / AI 语音回复）、**余额显示**。

- **host**（服务端）：语音工具 + TTS 六引擎 + ASR + 音色克隆 + 自动语音回复
- **client**（浏览器）：输入框工具条（图片/录音）+ 语音设置页 + 余额显示 + 语音文本复制
- **免费**：本地部署优先（离线 ASR / 本地 TTS / 本地识图），在线引擎也全是免费档，无需付费 Key

## 功能

### 语音
| 能力 | 说明 |
|---|---|
| 录音输入 | 输入框麦克风按钮，录音 → 本地 ASR 识别 → 发送 |
| TTS 六引擎 | auto / 小米 / 音色设计 / 音色克隆 / Edge(免费) / 本地 / 阿里 |
| 离线 ASR | 本地 sherpa-onnx 常驻服务（18790）或命令行模式，不依赖云 |
| 音色克隆 | 参考音频复刻音色，自带示例样本，开箱即用 |
| AI 语音回复 | 用户语音后 AI 自动用语音回（send_voice 工具） |
| 语音气泡 | 用户/AI 语音消息可点击播放，尾部复制转写文本 |

### 图片
- 输入框图片按钮上传 → **文本模型也能发图**：图片转本地附件路径文本，AI 自动调 **look_image 工具**识图（describe 看图描述 / reverse 像素级反推生图提示词 / text 提取文字）
- 识图后端在设置页「图片识别」独立分区配置：**本地部署**（ollama / sglang / vllm 等 OpenAI 兼容 `/v1` 端点，无需 Key）或**在线云端 API**（填地址 + API Key），统一 OpenAI 兼容格式
- 设置页可一键测试配置连通（内置测试图 + 三模式试跑）、查看/编辑每个模式的提示词（支持恢复默认）

## 架构说明：图片/语音为什么需要改 dsh 源码

官方 dsh 对图片只有一个态度：**当前模型支持看图就把图发过去（data-URL），不支持就报错**。
纯文本模型（如 deepseek-v4-flash）在官方 dsh 上**根本没法用图**——不是缺识图工具，而是图片块进不了模型。

两条路线：

**A. 不改源码（modlens 等外置插件的做法）**
图片在"粘贴进输入框"那一刻被拦截：图片字节存临时目录，输入框里放**路径文本**，消息里没有图片块，官方序列化永远不碰图片 → 文本模型也能用工具看图。
代价：① 只覆盖「粘贴」一个入口（普通发图、语音带图、历史消息里的图都管不到）；② 聊天里不是标准图片消息（没有官方缩略图/点击放大/附件管理）。

**B. 改源码（本 fork 的做法）**
- `llm-deepseek/serialize.ts` + `llm-pi-ai/context.ts`：图片块统一转成「本地附件路径文本」，模型拿到路径后用本插件的 `look_image` 识图——**任何入口**的图（发图 / 语音带图 / 历史回放 / 含图会话切换模型）全覆盖；
- `apiproxy/api-proxy.ts`：移除官方「模型不支持图片就拒绝切换」的闸门。

代价：框架源码有改动（约两千行内），升级上游需合并。
收益：**标准图片消息体验保留**（缩略图 / 点击放大 / 附件管理）+ 全链路覆盖。

> 一句话：不改源码 = 只覆盖粘贴入口且失去图片消息体验；本 fork 改源码 = 全链路 + 完整体验。
> 语音同理：官方不认识"语音消息"，本 fork 的语音落盘 / ASR 转文本 / 语音气泡 / AI 语音回复也是一整套框架改动（voice.ts 等）。

### 余额
- 直连模型时输入框右侧实时显示余额（¥xx）

### 界面截图

**输入框工具条**（图片 + 录音 + 余额）：

![输入框工具条](assets/screenshots/input-toolbar.png)

**语音设置页 —— 小米 TTS**（三模型分区：TTS / 音色设计 / 音色克隆）：

![小米TTS设置页](assets/screenshots/voice-settings-xiaomi.png)

**语音设置页 —— 本地 TTS 与阿里**：

![本地TTS与阿里设置页](assets/screenshots/voice-settings-local-ali.png)

**语音能力状态与 ASR 配置**：

![语音能力与ASR配置](assets/screenshots/voice-capabilities-asr.png)

**聊天语音消息展示**（用户/AI 语音气泡，可点击播放）：

![语音消息展示](assets/screenshots/voice-message-bubbles.png)

## 安装

### 场景一：已有 dsh 运行环境（源码版或 npm 版）

```bash
dsh plugin --profile web add @oadank/dsh-input-tools
```

装进当前 profile（`~/.dsh/profiles/<name>/node_modules/`），重启 dsh 生效。

### 场景二：从零开始（推荐，一键整合版）

整合版 fork 已内置语音改造 + 本插件 + 一键配置脚本：

```bash
git clone https://github.com/oadank/deepseek-harness.git
cd deepseek-harness
# Windows：
powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
# Linux/macOS：
bash scripts/setup-profile.sh
pnpm install
pnpm run build:lib       # ⚠️ 必须！全新 clone 无编译产物，跳过会报 Failed to resolve @deepseek-ai/dsh-client-web
pnpm run build:web
dsh --profile web
```

setup 脚本自动完成：装插件进 profile → 注册 → 检查 ffmpeg → 提示可选 ASR。**无需再执行 dsh plugin add**。

### 可选：本地 ASR（离线识别）

- **Windows**：管理员 PowerShell 运行 `scripts\install-asr.ps1`（插件包内），自动下载 sherpa-onnx + 模型（约 260MB）、注册 `asr` 服务（18790）
- **Linux**：手动部署 18790 识别服务，或用 ASR 的 cmd/api 模式

### 依赖

- **ffmpeg**（语音转码必需）：Windows `winget install ffmpeg`；Linux `sudo apt install ffmpeg`
- **视觉 MCP**（图片识图必需）：在 dsh 设置里配置至少一个视觉 MCP 服务，AI 用它的工具识图：
  - `zai-vision`（推荐，通用）：`npx -y @z_ai/mcp-server`，配 `Z_AI_BASE_URL=http://localhost:11434/v1/`（本地 ollama 跑 qwen3-vl 等视觉模型），按扩展名校验（已由补丁解决）
  - `visionqa`（本机自建服务）

## 配置

语音设置都在设置页「语音服务」分区（引擎、音色、Key、克隆、ASR 模式），存于 `~/.dsh/voice-config.json`。

## 语音源码补丁（完整体验原生语音消息）

dsh 官方版（npm rc.7 / 官方源码）**契约不支持原生语音消息**（voice 消息气泡、AI 语音回复条）。二选一：

### 方案 A：官方源码 + 破解脚本

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout 141eb6fef8        # 官方 dsh-0.1.0-rc.8 基线
# 打补丁（脚本自动探测/输入源码位置）：
powershell -ExecutionPolicy Bypass -File <插件目录>\patches\apply-voice-patch.ps1
pnpm install && pnpm run build:lib && pnpm run build:web && dsh --profile web
```

### 方案 B：直接用整合版 fork（推荐）

```bash
git clone https://github.com/oadank/deepseek-harness.git
cd deepseek-harness
powershell -ExecutionPolicy Bypass -File scripts\setup-profile.ps1
pnpm install && pnpm run build:lib && pnpm run build:web && dsh --profile web
```

> 补丁基线官方 rc.8（141eb6fef8），官方后续更新可能不兼容，请先 checkout 该基线再打。回滚：`git apply -R`。
> npm 版（rc.7）限制：语音输入/合成可用，但语音气泡/AI 语音回复条无法原生显示（完整体验用源码版）。
