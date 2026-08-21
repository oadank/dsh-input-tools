# dsh-input-tools —— 语音能力一体化插件（单包双入口）

一个插件、一个名字 `@oadank/dsh-input-tools`，把 DSH Web 的语音能力全部装进去：
- **host 入口**（`lib/index.js`）：语音工具 + TTS 六引擎 + ASR + 音色克隆 + 自动语音回复
- **client 入口**（`lib/client.js`）：输入框工具条（图片/录音）+ 语音设置页 + 语音复制按钮

不修改任何 DSH 源码，拷包 + 配一行 + 重启即用。

## 功能

### Host（服务端）
- **`send_voice` 工具**：agent 主动向用户发送语音横条（可播放、可回看、手机可播）。
- **自动语音回复**：用户发语音（或明确要求语音）后，turn 结束自动合成口语化语音（不念代码/URL/Markdown，最多前 2 句约 200 字）。
- **TTS 引擎**：
  | 引擎 | 说明 |
  |---|---|
  | `auto` | 按「默认语音引擎」选择，未配置时微软 Edge 免费兜底 |
  | `xiaomi` | 小米 MiMo（支持 `(唱歌)` 标签触发行唱） |
  | `voicedesign` | 小米音色设计（一句自然语言凭空生成音色） |
  | `voiceclone` | 小米音色克隆（参考音频复刻音色，15-60 秒最佳） |
  | `edge` | 微软 Edge（免费无 key） |
  | `local` | 本地 TTS（HTTP 常驻服务优先，命令兜底） |
  | `ali` | 阿里 qwen3-tts |
- **ASR**：service（常驻 HTTP）/ cmd（本地命令行）/ api（在线）三模式，配置见设置页。
- **克隆管理工具 `manage_voice_clone`**：注册/设为默认/列出/删除克隆音色。

### Client（浏览器）
- **输入框工具条**：图片（官方 draft 链路）+ 语音录音（秒数/取消）。
- **语音设置页**（设置 → 语音服务）：引擎折叠卡片、小米三模型分区、克隆样本管理、ASR 模式、试听（合成/原声）。
- **语音消息复制按钮**：用户/AI 语音条尾部复制转写文本。

## 安装（三步）

> `~/.dsh` 指 DSH Web 运行时目录（Windows 为 `C:\Users\<你>\.dsh`）。

1. **拷插件包**：把本仓库 `lib/`、`package.json` 拷到
   `~/.dsh/profiles/node_modules/@oadank/dsh-input-tools/`
   （`@oadank` 目录不存在就创建）

2. **注册插件**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在 insert 列表加：
   ```yaml
   - insert:
       - id: dsh-input-tools
         name: '@oadank/dsh-input-tools'
   ```

3. **重启 dsh-web**：`nssm restart dsh-web`

### 可选：本地 ASR（离线识别）
运行 `scripts/install-asr.ps1`（管理员）：自动下载 sherpa-onnx + SenseVoice 模型、注册
`asr` 常驻服务（端口 18790，开机自启），设置页 ASR 模式选「本地常驻服务」。

## 配置

所有语音设置保存在 `~/.dsh/voice-config.json`（设置页实时读写，AI 的 `send_voice`
描述里会注入当前配置摘要，无需翻源码）。默认语音引擎、各引擎音色/Key、克隆样本、
ASR 模式都在设置页「语音服务」分区配置。

## 依赖

- `@deepseek-ai/dsh-tools`（DSH profiles 自带，用于注册工具）
- `ws`（Edge TTS WebSocket；profiles 自带）

## 来源

由 `dsh-composer-plugin`（client 工具条）与 `dsh-host-voice`（host 语音）合并重写而来，
2026-08-21 统一为单包双入口。原 dsh-host-voice 的 git 历史备份在
`plugins/_archive/dsh-voice-plugin-git-*.bundle`。
