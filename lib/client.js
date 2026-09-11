/**
 * dsh-input-tools — 输入框工具条插件 v4.1（2026-08-20 改名自 dsh-client-composer）
 *
 * 功能三合一：图片（官方 draft 链路随文本发）+ 语音（录音/取消）+ 余额。
 *
 * v4 核心设计（对照用户要求逐条）：
 * 1) 图片"必须配文本发送"：走官方 draft 链路——插件注册 conversation.input.attachments 槽
 *    （priority:-1 覆盖官方附件条渲染），该槽 props 自带 onAddImages（=官方 intakeImages）：
 *    图片按钮选文件 → onAddImages → 图片进官方 draft → 官方发送按钮发送时自动带图 ✓
 * 2) 预览 = 插件自己的悬浮缩略图墙（absolute 定位在输入框上方，无背景、无边框），
 *    点击缩略图放大 modal，右上角 × 移除（调 onRemoveImage）——不是官方附件条样式；
 * 3) 没有"发送图片"按钮：发送动作完全由官方发送按钮承担，图片必然配文本发送；
 * 4) 语音：插件自实现（点击录音/秒数/×取消/取消不留垃圾）；
 * 5) 余额：conversation.input.right（独立 balance 插件已停用并删除）；
 * 6) 按钮位置：left 槽（源码 .tools 区，命令按钮之前：[🖼][🎙][+]）；
 * 7) 按钮间距：16px（与源码 .tools gap 一致）。
 *
 * 源码零改动：附件槽 props 由官方 ConversationRoot/InputBar 自动传入，无需桥接代码。
 */

window.__ModuleLoader__.load({
  id: "@oadank/dsh-input-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = react;
    const h = react.createElement;

    const POLL_MS = 30_000;

    // ── 附件槽桥：官方 onAddImages 由 attachments 槽组件挂载时存入，left 按钮调用 ──
    let sharedOnAddImages = null;
    // [2026-08-21] draft 图片共享：attachments 槽挂载时把当前 draft 图（ComposerAttachment[]）
    // 与移除回调存入模块级，语音发送时可一起带上、发完清掉（解决"选了图发语音图被留下"）。
    let sharedDraftImages = [];
    let sharedRemoveImage = null;

        // ── [2026-09-11 重写 v5] 助手语音自动播放 ────
    // 设计目标（修复三 bug）：
    // a) 已播标记跨设备同步：不再用 localStorage（手机/PWA 与电脑各自独立存储，
    //    导致"电脑播过、手机重播"）。改用服务端 voice-config 扩展字段
    //    autoPlayedVoiceIds（GET/POST /voice-config），三端共享同一份状态。
    // b) 串行不竞争：同一时刻只自动播一条；一次页面扫描最多自动播 1 条
    //    （最新的那条），且必须没有任何语音在播。历史积压的旧语音永远不自动播，
    //    只有"刚到达的新语音"才触发自动播放。
    // c) 录音互斥：开始录音前暂停当前自动播放的音频。
    let autoPlayAssistantVoice = (() => { try { return localStorage.getItem("dsh.autoPlayAssistantVoice") !== "0"; } catch { return true; } })();
    let assistantVoiceAutoPlayStarted = false;
    let playedVoiceIds = null;          // Set<string>，服务端同步后填充
    let lastAutoPlayedAudio = null;
    let lastSeenVoiceCount = 0;         // 上次扫描时的未播语音数（判断"新语音到达"）
    function setAutoPlayAssistantVoice(v) {
      autoPlayAssistantVoice = !!v;
      try { localStorage.setItem("dsh.autoPlayAssistantVoice", autoPlayAssistantVoice ? "1" : "0"); } catch { /* 忽略 */ }
    }
    function persistPlayedVoiceIds() {
      if (playedVoiceIds === null) return;
      const arr = Array.from(playedVoiceIds).slice(-300);
      try { localStorage.setItem("dsh.autoPlayedVoiceIds", JSON.stringify(arr)); } catch { /* 忽略 */ }
      fetch("/voice-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoPlayedVoiceIds: arr }),
      }).catch(() => { /* 服务端同步失败不影响本地 */ });
    }
    function stopAutoPlayedAudio() {
      if (lastAutoPlayedAudio !== null) {
        try { lastAutoPlayedAudio.pause(); } catch { /* 忽略 */ }
        lastAutoPlayedAudio = null;
      }
    }
    function startAssistantVoiceAutoPlay() {
      if (assistantVoiceAutoPlayStarted || typeof MutationObserver === "undefined") return;
      assistantVoiceAutoPlayStarted = true;
      // [2026-09-11 全局语音互斥] 三套播放来源（官方 VoiceCard / 插件注入横幅 / 自动播放）
      // 各自为政会齐播。play 事件 capture 到 document：任一 audio 开始播，先停掉其它。
      document.addEventListener("play", (e) => {
        const target = e.target;
        if (!(target instanceof HTMLAudioElement)) return;
        document.querySelectorAll("audio").forEach((a) => {
          if (a !== target && !a.paused) { try { a.pause(); } catch { /* 忽略 */ } }
        });
        lastAutoPlayedAudio = target.closest("[data-voice-reply]") ? target : lastAutoPlayedAudio;
      }, true);
      // 首次：本地缓存立即生效（无闪播），同时拉服务端合并（跨设备去重）
      try {
        const raw = localStorage.getItem("dsh.autoPlayedVoiceIds");
        const arr = raw === null ? [] : JSON.parse(raw);
        playedVoiceIds = new Set(Array.isArray(arr) ? arr : []);
      } catch { playedVoiceIds = new Set(); }
      fetch("/voice-config").then((r) => r.json()).then((d) => {
        const remote = d?.config?.autoPlayedVoiceIds;
        if (Array.isArray(remote)) remote.forEach((id) => playedVoiceIds.add(id));
      }).catch(() => { /* 离线时用本地 */ });
      const scanAndPlay = () => {
        if (!autoPlayAssistantVoice) return;
        if (lastAutoPlayedAudio !== null && !lastAutoPlayedAudio.paused) return; // 正在播：不动
        const cards = Array.from(document.querySelectorAll("[data-voice-reply][data-voice-id]"));
        const unplayed = cards.filter((card) => {
          const vid = card.getAttribute("data-voice-id");
          return vid && !playedVoiceIds.has(vid) && card.querySelector("audio")?.src;
        });
        // [2026-09-11 修·倒序 bug] 每轮只播「最新一条」会让批量到达的语音按
        // 新→旧倒序播放。改为播「最上面未播」的一条：批量按旧→新正序逐条播。
        // playedVoiceIds 跨刷新持久化，历史不会重播，无需积压跳过分支。
        if (unplayed.length === 0) { lastSeenVoiceCount = 0; return; }
        lastSeenVoiceCount = unplayed.length;
        const target = unplayed[0];
        const vid = target.getAttribute("data-voice-id");
        const audio = target.querySelector("audio");
        if (!audio || !vid) return;
        audio.play().then(() => {
          lastAutoPlayedAudio = audio;
          playedVoiceIds.add(vid);
          persistPlayedVoiceIds();
        }).catch(() => { /* 自动播放策略拦截：不标记、等用户点击 */ });
      };
      const obs = new MutationObserver(() => scanAndPlay());
      obs.observe(document.body, { childList: true, subtree: true, attributeFilter: ["src"] });
      window.setInterval(scanAndPlay, 1500);
      tryPlay_compat();
      function tryPlay_compat() { setTimeout(scanAndPlay, 800); }
      // c) 录音互斥：插件录音入口统一先停自动播放（见录音按钮 handler 调 stopAutoPlayedAudio）
      window.__dshStopAutoPlayedAudio = stopAutoPlayedAudio;
    }

    // ── [2026-08-21] 语音气泡（聊天界面 DOM 注入，安装即用，不依赖 dsh 源码支持）────
    // 录音 → 存服务器（/voice/outbox/save）→ ASR 转文本 → 发【用户语音】标记文本；
    // observer 发现带标记的消息 → 注入语音条（可播放）。dsh 原生支持 voice 的版本
    // （rc.8 本地改造）走多模态直发，消息本身没有该标记，不会触发注入（官方渲染语音条）。
    let voiceBubbleStarted = false;
    const pendingVoiceQueue = []; // [{ voiceId, ext }] 待消费的录音（FIFO）
    const injectedVoiceEls = new WeakSet(); // 已注入的元素
    const VOICE_MSG_MARK = "【用户语音】";

    function startVoiceBubbleObserver() {
      if (voiceBubbleStarted || typeof MutationObserver === "undefined") return;
      voiceBubbleStarted = true;
      const tryInject = () => {
        const els = Array.from(document.querySelectorAll("div,span,p,li"));
        for (const el of els) {
          if (injectedVoiceEls.has(el)) continue;
          if (el.querySelector("audio[data-voice-bubble]")) { injectedVoiceEls.add(el); continue; }
          const text = el.textContent ?? "";
          // [2026-08-21] AI 语音回复：**已禁用**。DOM 注入在 React 重渲染下会随 Tool call 展开/折叠
// 重复注入、位置漂移、无限累积（用户实测图1-4），修不干净。AI 语音条走源码版（voice/reply
// 事件原生渲染）；rc.7 上 AI 语音音频已生成但界面不显示，属 rc.7 硬伤，引导用户使用源码版。
          // if (text.includes("语音已发送") && text.includes("voiceId") && text.includes("sha256:")) { ... 注入 ... }
          if (!text.includes(VOICE_MSG_MARK)) continue;
          // [2026-09-11 修·手机实测] 排除非聊天容器：设置弹层（dialog/设置面板）的
          // 说明文字里也有「【用户语音】」字样（语音能力卡片），曾把残留队列音频
          // 注入进设置页。只认聊天主列（chat 容器内）的标记。
          if (el.closest('[role="dialog"], [class*="settings"], [data-slot*="settings"], [data-slot*="system-prompt"]')) continue;
          // 只处理"叶子级"文本块：若子元素已含标记（父容器），跳过避免重复注入
          let childHasMark = false;
          for (const c of el.children) {
            if ((c.textContent ?? "").includes(VOICE_MSG_MARK)) { childHasMark = true; break; }
          }
          if (childHasMark) continue;
          const meta = pendingVoiceQueue.shift();
          if (meta) {
            // [2026-09-11] 新链路带 objectRef（sha256 对象池）→ 走 /api/voice；旧 outbox UUID 走原路径
            const src = meta.objectRef?.voiceId
              ? `/api/voice?voiceId=${encodeURIComponent(meta.objectRef.voiceId)}`
              : `/voice/outbox/${meta.voiceId}.${meta.ext || "webm"}`;
            injectVoiceCard(el, src, 1); /* 用户消息气泡内 */
          }
          injectedVoiceEls.add(el);
        }
      };
      const obs = new MutationObserver(() => tryInject());
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      tryInject();
    }

    function injectVoiceCard(anchorEl, audioSrc, hop = 1) {
      try {
        // [2026-08-21 修] 不再硬编码爬 7 层（之前导致 AI 语音条藏到 Tool call 折叠块里）——
        // 改为可指定爬层数：
        //   1 = 用户消息：爬 1 层到消息气泡内（气泡可能就在文本的父级）
        //   6 = AI 语音回复：爬 6 层穿透 Tool call 折叠卡到主 assistant message 行
        let host = anchorEl;
        for (let i = 0; i < hop && host.parentElement; i++) host = host.parentElement;
        if (!host || host.querySelector("audio[data-voice-bubble]")) return;
        const audio = document.createElement("audio");
        audio.src = audioSrc;
        audio.preload = "metadata";
        audio.dataset.voiceBubble = "1";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:50%;background:rgba(229,72,77,.18);color:#e5484d;cursor:pointer;font-size:14px;flex:none;line-height:1;";
        btn.textContent = "▶";
        btn.onclick = () => { if (audio.paused) { void audio.play(); btn.textContent = "⏸"; } else { audio.pause(); btn.textContent = "▶"; } };
        audio.onended = () => { btn.textContent = "▶"; };
        audio.onerror = () => { btn.textContent = "⚠"; btn.title = "音频加载失败"; };
        const dur = document.createElement("span");
        dur.style.cssText = "font-size:11px;opacity:.75;min-width:26px;";
        audio.onloadedmetadata = () => {
          const s = Math.round(audio.duration || 0);
          dur.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
        };
        const card = document.createElement("div");
        card.style.cssText = "display:inline-flex;align-items:center;gap:8px;background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.28);border-radius:999px;padding:4px 12px;margin-top:6px;width:fit-content;max-width:260px;align-self:flex-start;";
        card.append(btn, dur);
        host.appendChild(card);
      } catch { /* 注入失败不影响消息 */ }
    }

    // ── 源码 SVG 图标 ────────────────────────────────────────────
    const svgProps = { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true };
    const imageIcon = h("svg", svgProps,
      h("rect", { x: "2.5", y: "3.5", width: "11", height: "9", rx: "2", fill: "none", stroke: "currentColor", strokeWidth: "1.4" }),
      h("circle", { cx: "6", cy: "7.5", r: "1.5", fill: "currentColor" }),
      h("path", { d: "M3.5 11.5 L6.5 8.5 L9 10.5 L11.5 8 L13.5 10.5", stroke: "currentColor", strokeWidth: "1.2", fill: "none" }),
    );
    const micIcon = h("svg", svgProps,
      h("path", { d: "M8 1.5C6.895 1.5 6 2.395 6 3.5V8C6 9.105 6.895 10 8 10C9.105 10 10 9.105 10 8V3.5C10 2.395 9.105 1.5 8 1.5Z", fill: "currentColor" }),
      h("path", { d: "M3.5 7.5V8C3.5 10.485 5.515 12.5 8 12.5C10.485 12.5 12.5 10.485 12.5 8V7.5H14V8C14 11.087 11.683 13.615 8.75 13.936V15.5H7.25V13.936C4.317 13.615 2 11.087 2 8V7.5H3.5Z", fill: "currentColor" }),
    );
    const cancelIcon = h("svg", svgProps,
      h("path", { d: "M4 4L12 12M12 4L4 12", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
    );

    // ── 工具行按钮样式：对齐官方 .add（28px 圆形 + selector 底色 + hover 实底）──
    const circleBtn = {
      display: "grid", placeItems: "center", flex: "none",
      width: "28px", height: "28px", padding: "0", border: "none",
      borderRadius: "999px", boxSizing: "border-box", aspectRatio: "1/1",
      background: "var(--dsw-specific-selector, rgba(128,128,128,.16))",
      color: "var(--dsw-alias-label-primary, inherit)", cursor: "pointer",
      transition: "background-color .15s",
    };
    // hover 实底对齐官方 .add:hover（录音中红底由 React style 接管，handler 里跳过）
    const circleBtnHover = (active) => ({
      onMouseEnter: (e) => { if (!active) e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover-solid, rgba(128,128,128,.28))"; },
      onMouseLeave: (e) => { if (!active) e.currentTarget.style.background = "var(--dsw-specific-selector, rgba(128,128,128,.16))"; },
    });

    // ── 左工具行：图片（官方 draft 链路）+ 语音 ─────────────────────
    // [iPhone 实测 2026-09-11] iOS Safari MediaRecorder 不支持 audio/webm，只支持 audio/mp4。
    // 写死 webm 会在构造/停止时抛错（Safari 文案 "undefined is not an object"）。
    // 按 isTypeSupported 依次探测：webm;codecs=opus → webm → mp4 → 浏览器默认（无 mimeType）。
    function pickRecorderMimeType() {
      if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ];
      for (const t of candidates) {
        try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* ignore */ }
      }
      return undefined;
    }
    function defaultAudioMime() {
      const ua = typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "";
      if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) {
        return "audio/mp4";
      }
      return "audio/webm";
    }
    // [iPhone 诊断 2026-09-11] 手机端看不到 console：录音链路每个失败点上报 host，
    // 落盘 ~/.dsh/dsh-web-log/client-voice.log（host 端 /voice/client-log）。尽力而为，不阻塞。
    const reportVoiceStage = (stage, e, extra) => {
      try {
        void fetch("/voice/client-log", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stage,
            name: e && e.name ? e.name : "",
            message: e && e.message ? String(e.message) : String(e ?? ""),
            ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
            ...(extra === undefined ? {} : { extra }),
          }),
          keepalive: true,
        });
      } catch { /* ignore */ }
    };
    function ToolbarLeft({ connection, sessionId }) {
      const [recording, setRecording] = useState(false);
      const [seconds, setSeconds] = useState(0);
      const secondsRef = useRef(0);
      const [voiceError, setVoiceError] = useState(null); // 语音发送失败提示
      const voiceErrorTimerRef = useRef(null);
      const recorderRef = useRef(null);
      const chunksRef = useRef([]);
      const timerRef = useRef(null);
      const fileRef = useRef(null);
      const rootRef = useRef(null);
      const voiceSupported = typeof navigator !== "undefined" && typeof MediaRecorder !== "undefined";
      // 排序由 apply 级 MutationObserver 处理（insertBefore slot 到 modes 前）
      useEffect(() => { startVoiceBubbleObserver(); startAssistantVoiceAutoPlay(); }, []);

      const sendVoiceBlob = useCallback(async (blob, durationMs) => {
        if (connection === undefined) return;
        // [iPhone] blob.type 可能为 audio/mp4 或带 codecs；空则按 UA 回退（iOS→mp4）
        const mediaType = (blob.type && blob.type.split(";")[0]) || defaultAudioMime();
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const fail = (msg) => {
          reportVoiceStage("send-fail", new Error(msg), { mediaType: (blob.type && blob.type.split(";")[0]) || "", bytes: blob.size });
          setVoiceError(msg);
          if (voiceErrorTimerRef.current !== null) window.clearTimeout(voiceErrorTimerRef.current);
          voiceErrorTimerRef.current = window.setTimeout(() => setVoiceError(null), 6000);
        };
        // [2026-08-21] draft 图片转 image content（File→base64），语音可与图片一起发送
        const draftImageContents = async () => {
          const imgs = Array.isArray(sharedDraftImages) ? sharedDraftImages : [];
          const out = [];
          for (const a of imgs) {
            const file = a?.file;
            if (!file) continue;
            const b64 = await new Promise((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
              r.onerror = () => resolve("");
              r.readAsDataURL(file);
            });
            if (b64 !== "") out.push({ type: "image", mediaType: file.type || "image/jpeg", data: b64, name: file.name });
          }
          return out;
        };
        // [2026-08-21] 语音发送成功后清掉 draft 图片（否则图还留在输入框上）
        const clearDraftImages = () => {
          const imgs = Array.isArray(sharedDraftImages) ? sharedDraftImages : [];
          if (typeof sharedRemoveImage === "function") {
            for (const a of imgs) { try { sharedRemoveImage(a.id); } catch { /* ignore */ } }
          }
          sharedDraftImages = [];
        };
        // [iPhone 修 2026-09-11] 0.1.5 已无 connection.api.sessions——prompt 走 Typert Remote wire
        // （session/prompt，named args，需 requestId + clientTimeZone，与 ui-chat 正道一致）。
        const rpcPrompt = async (content) => {
          if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
            const err = new Error("voice content not supported (0.1.5 remote)");
            err.name = "ContractError";
            throw err;
          }
          const requestId = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const clientTimeZone = (typeof Intl !== "undefined" && Intl.DateTimeFormat)
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : undefined;
          const response = await connection.rpc.call("/api", "session/prompt", {
            // [实测修正] gateway descriptor 的 args 顶层字段是 request（SessionPromptRequest）
            args: {
              request: {
                requestId, sessionId, mode: "queue", content,
                ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
              },
            },
          });
          return response && typeof response === "object" && "ok" in response ? response : { ok: false, error: { message: "empty rpc response" } };
        };
        const sendAsText = async (text, images) => {
          // [2026-08-21] 降级路径：不支持 voice content 时 ASR 转文本。带【用户语音】标记让 AI
          // 知道这是语音转的文本，可以按规则(自动 TTS)回复。
          const marked = "【用户语音】" + text;
          const result = await rpcPrompt([{ type: "text", text: marked }, ...images]);
          if (!result.ok) {
            fail((result.error && typeof result.error.message === "string" && result.error.message !== "")
              ? result.error.message : "语音发送失败，请重试");
          }
        };
        const sendAsVoice = async (images, transcript) => {
          // [2026-09-11 抄自 pre-merge 形态] 先把录音落共享对象池（/voice/outbox/save 现同时
          // 写 sha256 对象池并返回 ref），ASR 转写挂 attachment.transcript，再发 voice 引用块
          // ——与 8月21日 旧消息形态完全一致（模型经 serialize 直接读「识别内容」，复制按钮有值）。
          const sv = await (await fetch("/voice/outbox/save", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ audioBase64: data, mediaType, durationMs }),
          })).json().catch(() => ({}));
          if (!sv?.ok || !sv?.ref?.voiceId) {
            const err = new Error("voice save failed");
            err.name = "ContractError";
            throw err;
          }
          // 语音气泡注入器数据源：/api/voice 读对象池。
          // [2026-09-11 修] 直发路径不 push 队列——消息带 voice 块无【用户语音】标记，
          // 注入器永远消费不到，残留的音频会被设置页说明文字里的「【用户语音】」字样
          // 误触发注入（手机实测横幅插进设置页）。队列仅供降级路径（标记文本）使用。
          const attachment = {
            ...sv.ref,
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(transcript === undefined || transcript === "" ? {} : { transcript }),
          };
          return await rpcPrompt([{ type: "voice", attachment }, ...images]);
        };
        const transcribeBlob = async () => {
          try {
            const tr = await fetch("/asr/transcribe", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ audioBase64: data, mediaType }),
            });
            const td = await tr.json().catch(() => ({}));
            if (!td?.ok) {
              reportVoiceStage("asr-fail", new Error(String(td?.error ?? ("HTTP " + tr.status))), { mediaType, bytes: data.length });
              return undefined;
            }
            const text = typeof td?.text === "string" ? td.text.trim() : "";
            if (text === "") { reportVoiceStage("asr-empty", null, { mediaType, bytes: data.length }); return undefined; }
            return text;
          } catch (e) {
            reportVoiceStage("asr-error", e, { mediaType });
            return undefined;
          }
        };
        try {
          const images = await draftImageContents();
          // [2026-09-11 修] save → ASR → 带转写直发（旧 rc.8 行为）：transcript 进块，
          // serialize 直接给「识别内容」，AI 不必自己调 ASR；复制按钮也有值。
          const transcript = await transcribeBlob().catch(() => undefined);
          let result;
          try {
            result = await sendAsVoice(images, transcript);
          } catch (voiceErr) {
            result = null;
          }
          // 直发成功：result.ok true（transcript 为空时 serialize 走本地路径文本降级）
          if (result && result.ok) {
            // [2026-09-11 修] 队列兜底清空：直发不产生标记文本，残留只会误注入
            pendingVoiceQueue.length = 0;
            clearDraftImages();
            return;
          }
          // [2026-09-11] 直发失败降级：补 push 注入队列（sendAsVoice 不再入队）。
          reportVoiceStage("voice-direct-degrade", null, { reason: String(result?.error?.message ?? "throw").slice(0, 120) });
          try {
            const sv2 = await (await fetch("/voice/outbox/save", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ audioBase64: data, mediaType, durationMs }),
            })).json().catch(() => ({}));
            if (sv2?.ok) pendingVoiceQueue.push({ voiceId: sv2.voiceId, ext: sv2.ext ?? "webm", objectRef: sv2.ref });
          } catch { /* 存档失败不阻塞发送 */ }
          if (transcript === undefined) { fail("没听清，请再说一次"); return; }
          await sendAsText(transcript, images);
          clearDraftImages();
        } catch (e) {
          fail(String(e && typeof e.message === "string" && e.message !== "" ? e.message : e));
        }
      }, [connection, sessionId]);

      const stopRecording = useCallback((send) => {
        clearInterval(timerRef.current);
        timerRef.current = null;
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (recorder !== null && recorder.state !== "inactive") {
          if (send) recorder.stop();
          else { recorder.onstop = null; try { recorder.stop(); } catch { /* ignore */ } }
        }
        setRecording(false);
        setSeconds(0);
      }, []);

      const startRecording = useCallback(async () => {
        if (connection === undefined || sessionId === undefined) return;
        // [2026-09-11 录音互斥] 开始录音前停掉正在自动播放的语音
        try { if (typeof window.__dshStopAutoPlayedAudio === "function") window.__dshStopAutoPlayedAudio(); } catch { /* 忽略 */ }
        try { document.querySelectorAll("audio[data-voice-bubble]").forEach((a) => { try { a.pause(); } catch { /* 忽略 */ } }); } catch { /* 忽略 */ }
        try {
          // [iPhone] 非 HTTPS / 旧 WebView 下 mediaDevices 为 undefined，Safari 报 "undefined is not an object"
          if (!navigator || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
            const err = new TypeError("undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')");
            reportVoiceStage("mediaDevices-missing", err, {
              protocol: typeof location !== "undefined" ? location.protocol : "",
              standalone: typeof navigator !== "undefined" && navigator.standalone === true,
            });
            throw err;
          }
          let stream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (ge) {
            reportVoiceStage("getUserMedia", ge, {
              protocol: typeof location !== "undefined" ? location.protocol : "",
              standalone: typeof navigator !== "undefined" && navigator.standalone === true,
            });
            throw ge;
          }
          // [iPhone] 先探测容器再构造；探测失败/构造仍炸则无 options 走浏览器默认（iOS=mp4）
          const preferred = pickRecorderMimeType();
          reportVoiceStage("recorder-probe", null, { preferred: preferred ?? "default", supports: typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function" ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].filter((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) : [] });
          let recorder;
          try {
            recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
          } catch (me) {
            reportVoiceStage("MediaRecorder-construct", me, { preferred: preferred ?? "default" });
            if (!preferred) throw me;
            recorder = new MediaRecorder(stream);
          }
          const blobType = (recorder.mimeType && String(recorder.mimeType).split(";")[0]) || preferred || defaultAudioMime();
          reportVoiceStage("recorder-started", null, { actual: recorder.mimeType ?? "default", blobType });
          chunksRef.current = [];
          recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunksRef.current.push(event.data); };
          recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: blobType });
            chunksRef.current = [];
            stream.getTracks().forEach((t) => t.stop());
            if (blob.size === 0) reportVoiceStage("empty-blob", null, { blobType });
            if (blob.size > 0) void sendVoiceBlob(blob, secondsRef.current * 1000);
          };
          recorder.start();
          recorderRef.current = recorder;
          setRecording(true);
          setSeconds(0);
          timerRef.current = setInterval(() => setSeconds((s) => { secondsRef.current = s + 1; return s + 1; }), 1000);
        } catch (e) {
          // [2026-08-23 修] 原来静默失败：无麦克风的电脑点语音按钮"点了没反应"，用户完全不知道为啥。
          // 分情况给明确提示，不再吞错误。
          const name = e && e.name ? String(e.name) : "";
          let msg = "";
          if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
            msg = "未检测到录音设备，请连接麦克风，或在 Windows 声音设置中启用「立体声混音」作为录音设备。";
          } else if (name === "NotAllowedError" || name === "PermissionDeniedError") {
            msg = "麦克风权限被拒绝。请点击浏览器地址栏左侧的锁/摄像头图标，允许本站使用麦克风后重试。";
          } else if (name === "NotReadableError" || name === "TrackStartError") {
            msg = "麦克风被其他程序占用或不可读。请关闭正在使用麦克风的应用（如会议软件）后重试。";
          } else if (name === "SecurityError") {
            msg = "当前页面环境不允许访问麦克风（需要 HTTPS 或 localhost）。";
          } else {
            msg = "无法访问录音设备：" + (e && e.message ? e.message : String(e)) + "。请检查麦克风连接或浏览器权限。";
          }
          try { alert("无法开始录音\n\n" + msg); } catch { /* alert 被禁时退化为 console */ }
          console.warn("[voice] getUserMedia failed:", e);
        }
      }, [connection, sessionId, sendVoiceBlob]);

      // [2026-08-22] 大图自动缩放：官方限制图片宽高 ≤2000px，超出则 canvas 缩小（最长边对齐 2000px，转 jpeg）再上传
      // [2026-08-22 修] 尺寸无效(0/NaN)或输出异常一律回退原图, 绝不缩成像素
      // [2026-08-27 放宽] 服务端 attachment-local 已放宽到单边 8192px，客户端缩放目标同步 2000→8192（避免按钮选图被压到 2000px 丢细节）
      const scaleImageToFit = (file, maxDim = 8192) => new Promise((resolve) => {
        if (typeof Image === "undefined" || typeof document === "undefined") { resolve(file); return; }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) { resolve(file); return; }
          const scale = Math.min(1, maxDim / Math.max(w, h));
          if (scale >= 1) { resolve(file); return; }
          try {
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(file); return; }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
              if (!blob || blob.size < 1024) { resolve(file); return; }
              resolve(new File([blob], file.name, { type: file.type === "image/gif" ? "image/jpeg" : (file.type || "image/jpeg") }));
            }, "image/jpeg", 0.92);
          } catch { resolve(file); }
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
      });

      // 图片选中 → 自动缩放(防官方 2000px 限制，2026-08-27 已放宽到 8192px) → 官方 onAddImages（intakeImages）→ 官方 draft → 随文本发送
      const onPickImage = useCallback((event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length === 0 || typeof sharedOnAddImages !== "function") return;
        Promise.all(files.map(scaleImageToFit)).then((scaled) => sharedOnAddImages(scaled));
      }, []);

      return h("div", { ref: rootRef, "data-composer-left": "", style: { position: "relative", display: "inline-flex", alignItems: "center", gap: "12px" } },
        h("button", {
          type: "button", "aria-label": "添加图片", title: "添加图片",
          style: circleBtn, ...circleBtnHover(false), onMouseDown: (e) => e.preventDefault(),
          onClick: () => fileRef.current?.click(),
        }, imageIcon),
        h("input", {
          ref: fileRef, type: "file",
          accept: "image/png,image/jpeg,image/webp,image/gif",
          multiple: false, hidden: true, onChange: onPickImage,
        }),
        voiceSupported && h("button", {
          type: "button",
          "aria-label": recording ? "停止并发送" : "录音",
          title: recording ? "停止并发送" : "录音",
          style: { ...circleBtn, ...(recording ? { background: "#e5484d", color: "#fff" } : {}) },
          ...circleBtnHover(recording),
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => { if (recording) stopRecording(true); else void startRecording(); },
        }, recording
          ? h("span", {
              style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px", fontWeight: 600 },
            }, h("span", {
              style: { width: "6px", height: "6px", borderRadius: "50%", background: "#fff", display: "inline-block" },
            }), `${seconds}s`)
          : micIcon),
        recording && h("button", {
          type: "button", "aria-label": "取消录音", title: "取消",
          style: circleBtn, ...circleBtnHover(false), onMouseDown: (e) => e.preventDefault(),
          onClick: () => stopRecording(false),
        }, cancelIcon),
        // [本地改造 2026-08-21] 语音发送失败提示（ASR 未配置/识别失败）：按钮上方气泡
        voiceError !== null && h("div", {
          style: {
            position: "absolute", bottom: "calc(100% + 8px)", left: "0", zIndex: 30,
            maxWidth: "380px", background: "rgba(229,72,77,.12)", color: "#e5484d",
            border: "1px solid rgba(229,72,77,.35)", borderRadius: "8px",
            padding: "6px 10px", fontSize: "12px", lineHeight: 1.45, whiteSpace: "normal",
            pointerEvents: "none", boxShadow: "0 4px 14px rgba(0,0,0,.25)",
          },
        }, voiceError),
      );
    }

    // ── 附件槽（覆盖官方）：悬浮缩略图墙 + 放大 modal，无背景无边框 ─────
    function ComposerAttachmentsOverlay({ attachments, onAddFiles, onAddImages, onRemoveAttachment, onRemoveImage }) {
      const [zoom, setZoom] = useState(null); // { id, url, name } | null
      // [2026-09-11 修·用户报"上传文件无任何显示"] 不再过滤 file：图片走缩略图，
      // 文件/音频走 chip（名称+大小+移除）——此前 file 被滤掉且官方渲染被本层覆盖，
      // 上传任意文件后输入框附近毫无反馈。
      const items = (Array.isArray(attachments) ? attachments : []);
      const hasItems = items.length > 0;
      const fileSizeText = (bytes) => {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) return "";
        if (n < 1024) return `${n}B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
        return `${(n / 1024 / 1024).toFixed(1)}MB`;
      };
      const fileNameOf = (a) => a?.file?.name || a?.attachment?.file?.name || a?.name || "文件";
      const fileBytesOf = (a) => a?.file?.bytes ?? a?.attachment?.file?.bytes;
      const isImageOf = (a) => a?.kind !== "file" && typeof a?.previewUrl === "string";

      // 官方 0.1.5 槽 props 改名：onAddFiles（曾用 onAddImages）。两个都收，保证选图进 draft 并出预览。
      useEffect(() => {
        const add = onAddFiles || onAddImages;
        if (typeof add === "function") sharedOnAddImages = add;
      }, [onAddFiles, onAddImages]);

      // draft 图片同步到模块级（语音发送一起带 + 发完清掉）
      const remove = onRemoveAttachment || onRemoveImage;
      useEffect(() => {
        sharedDraftImages = Array.isArray(attachments) ? attachments.filter((a) => a?.kind !== "file") : [];
        if (typeof remove === "function") sharedRemoveImage = remove;
      }, [attachments, remove]);

      useEffect(() => {
        if (zoom !== null && !items.some((a) => a.id === zoom.id)) setZoom(null);
      }, [items, zoom]);

      if (!hasItems) return null;
      return h("div", {
        style: {
          position: "absolute", bottom: "calc(100% + 8px)", left: "10px", zIndex: 20,
          display: "flex", flexWrap: "wrap", gap: "6px",
          padding: "0", margin: "0", background: "transparent", border: "none",
          pointerEvents: "none",
        },
      }, items.map((a) => isImageOf(a)
        ? h("div", {
          key: a.id,
          style: {
            position: "relative", width: "60px", height: "60px", borderRadius: "6px",
            overflow: "hidden", cursor: "zoom-in", background: "rgba(128,128,128,.1)",
            pointerEvents: "auto",
          },
          onClick: () => setZoom({ id: a.id, url: a.previewUrl, name: a.file?.name ?? "image" }),
        },
          h("img", {
            src: a.previewUrl, alt: a.file?.name ?? "image",
            style: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
          }),
          h("button", {
            type: "button", "aria-label": "移除", title: "移除",
            style: {
              position: "absolute", top: "2px", right: "2px",
              width: "18px", height: "18px", padding: "0", border: "none", borderRadius: "50%",
              background: "rgba(0,0,0,.6)", color: "#fff", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", lineHeight: "1",
            },
            onClick: (e) => { e.stopPropagation(); const rm = onRemoveAttachment || onRemoveImage; if (typeof rm === "function") rm(a.id); },
          }, "×"),
        )
        : h("div", {
          key: a.id,
          style: {
            display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "240px",
            padding: "5px 8px", borderRadius: "8px", background: "rgba(128,128,128,.14)",
            border: "1px solid rgba(128,128,128,.25)", pointerEvents: "auto", fontSize: "12px",
            color: "var(--dsw-alias-label-primary, inherit)",
          },
        },
          h("span", { style: { flex: "none" } }, "📄"),
          h("span", {
            title: fileNameOf(a),
            style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "150px" },
          }, fileNameOf(a)),
          h("span", { style: { opacity: .6, flex: "none", fontSize: "11px" } }, fileSizeText(fileBytesOf(a))),
          h("button", {
            type: "button", "aria-label": "移除", title: "移除",
            style: {
              border: "none", background: "transparent", color: "inherit", cursor: "pointer",
              fontSize: "13px", lineHeight: 1, padding: "0 2px", flex: "none",
            },
            onClick: (e) => { e.stopPropagation(); const rm = onRemoveAttachment || onRemoveImage; if (typeof rm === "function") rm(a.id); },
          }, "×"),
        )),
        // 放大 modal
        zoom !== null ? h("div", {
          role: "dialog", "aria-label": "图片预览",
          style: {
            position: "fixed", inset: "0", zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,.78)", cursor: "zoom-out",
            // modal 是缩略图墙 div 的子节点，外层 pointerEvents:none 会继承；显式 auto 让按钮能点
            pointerEvents: "auto",
          },
          onClick: () => setZoom(null),
        },
          h("img", {
            src: zoom.url, alt: zoom.name,
            style: { maxWidth: "92vw", maxHeight: "92vh", objectFit: "contain", borderRadius: "8px", boxShadow: "0 12px 48px rgba(0,0,0,.5)" },
          }),
          h("button", {
            type: "button", "aria-label": "关闭",
            style: {
              position: "absolute", top: "12px", right: "16px",
              width: "36px", height: "36px", padding: "0", border: "none", borderRadius: "50%",
              background: "rgba(0,0,0,.5)", color: "#fff", cursor: "pointer",
              fontSize: "18px", lineHeight: "1",
            },
            onClick: () => setZoom(null),
          }, "×"),
        ) : null,
      );
    }

    // ── 右工具行：余额 ─────────────────────────────────────────────
    // [本地改造 2026-08-25] 余额触发策略改「懒查询」：去掉 30s setInterval 轮询。
    //  ① 挂载/切会话时查一次
    //  ② 发消息(running false→true 边沿)查一次
    //  ③ 切换模型(mux 流 request/header reason==='change' 或 request/context)查一次
    //  平时不查，避免频繁打网关 /v1/balance。切换模型瞬间 wire 无事件，最近的
    //  语义信号是「换模型后第一次真正请求」的 request/header(change)——此时余额
    //  恰好已按新 provider(balance.get 按 sessionId 判断)生效。
    function BalanceMeter({ connection, sessionId, useSession, getModelStore }) {
      const [balance, setBalance] = useState(null);
      // [本地改造 2026-08-27] gw 网关健康状态：true=正常/绿、false=异常/红、null=非gw不显示。
      const [gatewayHealthy, setGatewayHealthy] = useState(null);
      // [本地改造 2026-08-27] ARK Agent Plan 套餐配额（volc-ark 显示额度，非余额）。
      const [usage, setUsage] = useState(null);
      const [visible, setVisible] = useState(false);
      // API 至少成功过一次才允许「不适用」占位，避免首帧误闪
      const [loaded, setLoaded] = useState(false);
      // [本地改造 2026-08-27] 呼吸灯动画：挂载时注入一次 @keyframes（全局 style 标签，
      // getElementById 防重复注入），圆点通过 animation 引用。闪烁/发光/呼吸灯效果。
      useEffect(() => {
        if (document.getElementById("dsh-gw-breath")) return;
        const s = document.createElement("style");
        s.id = "dsh-gw-breath";
        s.textContent = "@keyframes dshGwBreath{0%,100%{opacity:.55;box-shadow:0 0 2px var(--gwglow,rgba(46,204,113,.5))}50%{opacity:1;box-shadow:0 0 8px 2px var(--gwglow,rgba(46,204,113,.8))}}";
        (document.head || document.documentElement).appendChild(s);
      }, []);
      const refresh = useCallback(async () => {
        try {
          // [本地改造 2026-09-10 / 0.1.5] balance.get RPC 已迁 GET /api/balance
          const url = new URL("/api/balance", window.location.origin);
          if (sessionId) url.searchParams.set("sessionId", String(sessionId));
          const res = await fetch(url, { credentials: "same-origin" });
          if (!res.ok) return;
          const value = await res.json();
          setGatewayHealthy(value.gatewayHealthy ?? null);
          setBalance(value.balance ?? null);
          setUsage(value.usage ?? null);
          setVisible((value.balance ?? null) !== null || (value.usage ?? null) !== null);
          setLoaded(true);
        } catch { /* 静默 */ }
      }, [sessionId]);
      // ① 挂载 / 切会话时查一次
      useEffect(() => { void refresh(); }, [refresh]);
      // ② 发消息查一次：running false→true 边沿（发消息开始处理即触发）
      const running = useSession ? useSession(s => s.running) ?? false : false;
      const wasRunning = useRef(false);
      useEffect(() => {
        if (running && !wasRunning.current) void refresh();
        wasRunning.current = running;
      }, [running, refresh]);
      // ③ 切换模型 / 新一轮请求查一次。
      // [0.1.5] connection.api.events.mux 已移除；余额以 60s 兜底轮询 + 发消息边沿 + 切模型为主。
      useEffect(() => {
        const id = setInterval(() => { void refresh(); }, 60_000);
        return () => clearInterval(id);
      }, [refresh]);

      // ④ 切换模型就强刷一次：订阅本会话模型目录 store，current 变化(=切了模型)即重查余额/用量。
      // [本地改造 2026-08-28] 模型切换瞬间 mux 无事件，之前的语义信号是"换模型后第一次真正请求"，
      // 导致切完模型要等发消息才更新。现在直接监听 ModelDirectory.select() 落库的 current。
      useEffect(() => {
        const store = getModelStore ? getModelStore() : undefined;
        if (!store) return;
        let last = store.getSnapshot().current;
        const stop = store.subscribe(() => {
          const cur = store.getSnapshot().current;
          if (cur !== last) { last = cur; void refresh(); }
        });
        return stop;
      }, [getModelStore, refresh]);


      // null 全空：API 成功但该 provider 无余额语义（litellm 等）→ 显示「不适用」，
      // 不要画 0，也不要静默消失得像坏了。仅在带 sessionId 且已成功拉过一次时展示。
      if (loaded && balance === null && usage === null) {
        if (!sessionId) return null;
        return h("button", {
          type: "button",
          "aria-label": "暂无余额",
          title: "当前模型路由不适用余额显示",
          style: { opacity: 0.55, cursor: "default" },
        }, "不适用");
      }
      if (!loaded || (balance === null && usage === null)) return null;
      // [本地改造 2026-08-25] 余额数字太长(网关返回到 9 位小数)占用位置，统一显示 2 位小数
      const fmt2 = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n.toFixed(2) : String(v ?? "");
      };
      // [本地改造 2026-08-27] ARK Agent Plan 套餐配额：用于算各周期已用百分比。
      const fmtPct = (p) => (p && p.quota > 0 ? Math.min(100, (p.used / p.quota) * 100) : 0);
      const PERIOD_LABEL = { "5h": "5小时", weekly: "本周", monthly: "本月" };
      const PERIOD_SHORT = { "5h": "5h", weekly: "周", monthly: "月" };
      let label;
      let title;
      // [本地改造 2026-08-27] volc-ark 时显示套餐额度百分比（5h/周/月），否则走余额。
      if (usage && usage.periods && usage.periods.length > 0) {
        label = usage.periods
          .map((p) => `${PERIOD_SHORT[p.label] ?? p.label}${Math.round(fmtPct(p))}%`)
          .join(" · ");
        title = `ARK ${usage.planType || ""}套餐 · ` + usage.periods
          .map((p) => `${PERIOD_LABEL[p.label] ?? p.label} 已用 ${Math.round(fmtPct(p))}% (${Math.round(p.used)}/${Math.round(p.quota)})`)
          .join(" · ");
      } else {
        label = `余额: ¥${fmt2(balance.total)}`;
        title = `总额 ¥${fmt2(balance.total)} · 赠送 ¥${fmt2(balance.granted)} · 充值 ¥${fmt2(balance.toppedUp)}`;
      }
      // [本地改造 2026-08-27] 网关健康状态点：green=true正常、red=false异常、null不显示。
      // 探测来自 host 代查 readGwHealth()(浏览器直连 /health 被 CORS 拦)。合并进余额按钮内部。
      const SHOW_DOT = gatewayHealthy === true || gatewayHealthy === false;
      if (SHOW_DOT) title += ` · 网关${gatewayHealthy ? "正常" : "异常"}`;
      return h("button", {
        type: "button", "aria-label": label, title: title,
        style: { display: "inline-flex", alignItems: "center", gap: "5px", border: "none", background: "transparent", color: "inherit", cursor: "default", fontSize: "12px", padding: "0 4px", opacity: 0.85, whiteSpace: "nowrap" },
      },
        SHOW_DOT ? h("span", {
          "aria-label": gatewayHealthy ? "网关正常" : "网关异常",
          title: gatewayHealthy ? "网关正常运行" : "网关服务异常",
          style: {
            display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", flex: "0 0 auto",
            background: gatewayHealthy ? "#2ecc71" : "#e74c3c",
            // [本地改造 2026-08-27] 呼吸灯：透明度+光晕 2.4s 循环；--gwglow 随红/绿变色。
            "--gwglow": gatewayHealthy ? "rgba(46,204,113,.85)" : "rgba(231,76,60,.85)",
            animation: "dshGwBreath 2.4s ease-in-out infinite",
          },
        }) : null,
        h("span", { style: { lineHeight: "1" } }, label),
      );
    }

    // ── 设置页：语音服务分区（settings.section，读写 ~/.dsh/voice-config.json）──
    const VOICE_RULES = [
      "1) 用户本轮发过语音 → 必须语音回复（使用上方选择的默认引擎）",
      "2) 用户文本明确要求发语音 / 指定服务商（小米/微软）→ 自动合成（用指定 provider）",
      "3) 其他情况不自动合成——agent 自主决定，需要时调用 send_voice 工具主动发（仍按默认引擎）",
    ];
    // 自然语言风格预设（xiaomi context，强差异）
    const STYLE_PRESETS = [
      { key: "", label: "自然（默认）", ctx: "" },
      { key: "joyful", label: "欢快活泼", ctx: "用欢快、活泼的语气，语速轻快，带着笑意，声音明亮有活力" },
      { key: "gentle", label: "温柔亲切", ctx: "用温柔、亲切的语气，语速平缓，声音柔和，像在关怀对方" },
      { key: "calm", label: "沉稳严肃", ctx: "用沉稳、严肃的语气，语速适中偏慢，声音厚重，正式播报感" },
      { key: "broadcast", label: "播音腔", ctx: "用标准播音腔，吐字清晰，节奏分明，抑扬顿挫，专业新闻播报" },
      { key: "whisper", label: "低语私密", ctx: "用低沉、私密的低语语气，音量放轻，语速缓慢，像耳语般亲近" },
      { key: "excited", label: "兴奋激动", ctx: "用兴奋、激动的语气，语速快，音调上扬，情绪饱满有感染力" },
    ];
    // 常用情绪（voicedesign 试听：叠加在"音色描述"之上的表演指令，不写性别/年龄——那是音色描述的事）
    // 写法参照 MiMo 官方"自然语言控制"示例：语速、气息、停顿、音调、共鸣都要有可感细节
    const EMOTIONS = [
      { key: "happy", label: "开心", ctx: "用开心、欢快的语气，语速轻快，带着抑制不住的笑意，声音明亮上扬，尾音微微翘起" },
      { key: "sad", label: "难过", ctx: "用难过、低落的语气，语速缓慢，声音轻柔低沉，气息断断续续，带着淡淡的忧伤和哽咽感" },
      { key: "angry", label: "愤怒", ctx: "用愤怒、激动的语气，语速急促，声音强硬有力，气息加重，字字用力，带爆发感" },
      { key: "gentle", label: "温柔", ctx: "用温柔、关切的语气，语速平缓，气息绵软，声音柔和亲切，像在轻声安抚对方" },
      { key: "calm", label: "平静", ctx: "用平静、沉稳的语气，语速适中，气息平稳，声音波澜不惊，字正腔圆" },
      { key: "playful", label: "俏皮", ctx: "用俏皮、活泼的语气，语速轻快，声音带点机灵劲，尾音上扬，像在逗趣" },
      { key: "cold", label: "高冷", ctx: "用高冷、疏离的语气，语速偏慢，声音平淡克制，字字清晰，像隔着一层冰" },
      { key: "magnetic", label: "磁性", ctx: "用磁性、醇厚的语气，语速稍慢，气息低沉共鸣，声音富有魅力，尾音带拖腔" },
      { key: "excited", label: "兴奋", ctx: "用兴奋、高昂的语气，语速快，声音高亢明亮，情绪饱满，气息急促上扬" },
      { key: "grievance", label: "委屈", ctx: "用委屈、哽咽的语气，语速慢，声音发颤带鼻音，像忍着泪说话" },
      { key: "lazy", label: "慵懒", ctx: "用慵懒、松弛的语气，语速慢悠悠，声音松散，气息不紧不慢，漫不经心" },
      { key: "deep", label: "深沉", ctx: "用深沉、厚重的语气，若有所思，语速稳中有顿挫，声音偏低，字字有分量" },
    ];
    const ENGINES_ORDER = ["edge", "xiaomi", "voicedesign", "voiceclone", "audio8", "local", "ali"];
    const ENGINE_LABELS = {
      edge: "微软 edge（免费）", xiaomi: "小米 MiMo", voicedesign: "小米语音设计（VoiceDesign）", voiceclone: "小米克隆（VoiceClone）", audio8: "Audio8 克隆（本地）", local: "本地 TTS", ali: "阿里 qwen3-tts",
    };
    const MIMO_DOC_URL = "https://mimo.mi.com/models/zh-CN/mimo-v2.5-tts";
    // VoiceDesign 官方示例（音色设计：Instruct=音色描述/导演指令，Text=要朗读的文本）
    const VOICE_DESIGN_EXAMPLES = [
      {
        title: "ASMR 双耳女声",
        instruct: "年轻的女性声音，近距离的聆听效果，带有双耳刺激的ASMR感。可以听到她的呼吸声、轻微的吞咽声，以及轻柔的自然唇音。她的说话速度非常慢，营造出一种极度放松且沉浸式的体验。",
        text: "[在你耳边低语] 嘘……放松点，再靠近一点吧。我现在就在你身边。慢慢、轻柔地呼吸，让思绪随着水流轻轻流淌，就像沉浸在温暖的水中一样。",
      },
      {
        title: "纪录片旁白",
        instruct: "一位中年男性，说标准普通话，嗓音低沉有磁性，带有轻微的沙哑质感，像纪录片旁白解说员，沉稳而有感染力。",
        text: "当最后一缕阳光消失在地平线之下，这片沉睡了亿万年的大地开始显露它真正的面貌。在这寂静的荒野中，每一块岩石都记录着时间的流逝，每一阵风都在诉说着古老的故事。",
      },
      {
        title: "年迈老先生旁白",
        instruct: "一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。",
        text: "我这辈子啊，走南闯北六十多年。见过最热闹的集市，也见过最安静的戈壁。到头来才明白一个道理——这人哪，不在走了多远的路，在于记住了多少风景。年轻人，别光顾着赶路，偶尔也停下来看看天。",
      },
    ];
    // VoiceDesign 默认音色描述（用户未填时的兜底，含性别锚点）
    const DEFAULT_VOICE_DESC = "青年女性，声音甜美明亮，普通话标准，语速适中，活泼开朗";
    // [2026-09-01] 「设计音色」模式的内置默认描述（老大：自己编写一个，别用官方示例一样的）
    const CUSTOM_VOICE_DEFAULT = "一位知性温柔的青年女性，说字正腔圆的普通话，声音沉稳放松，像深夜电台主播在耳边娓娓道来，气息平稳，尾音带着若有若无的笑意";
    // [本地改造 2026-08-21] 所有克隆音色的统一试听文本（与每个样本自己的风格指令配合，
    // 试听时能同时听出"音色+个性"；如小团团样本的指令让它念这句时自然带沙雕可爱腔）
    const CLONE_PREVIEW_TEXT = "喂喂喂！你怎么才来呀？我都等你老半天啦！我跟你说啊——你今天可不能凶我哦，因为……因为你又不娶我，哼！不过嘛，看在你这么乖的份上，本小姐今天心情好，就大发慈悲原谅你啦！嘿嘿嘿～走吧走吧，出发喽！";
    // [本地改造 2026-08-22] 自带默认样本 id（小团团）：禁止删除、有预生成合成试听录音
    const BUNDLED_CLONE_ID = "8da38fcc-b041-4f5b-86b9-901956016f89";

    const vInput = {
      background: "var(--dsw-specific-input-major,#ffffff)", color: "var(--dsw-alias-label-primary,#e6e9ef)",
      border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "6px",
      padding: "6px 10px", fontSize: "12.5px", fontFamily: "inherit", width: "100%",
      boxSizing: "border-box",
    };
    const vField = (labelText, node) => h("label", {
      style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "1 1 45%", minWidth: "220px" },
    }, labelText, node);
    // 服务商卡片（[本地改造 2026-08-21] 去复选框改折叠）：标题栏点击展开/收起。
    // 配置填写与启用与否无关——只要填了 AI 就能调用，所以不再用 enabled 开关控制。
    // accent = 该引擎的识别色（左边条 + 图标底 + 收起/展开文字 + 底色轻染），5 张卡一眼能分开
    const vCard = (title, open, onToggle, children, accent) => {
      const c = accent ?? "#8b95a1";
      return h("div", {
        style: {
          border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderLeft: "3px solid " + c,
          borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px",
          background: c + "12",
        },
      },
        h("div", {
          style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" },
          onClick: onToggle,
        },
          h("span", { style: { display: "inline-flex", width: "22px", height: "22px", borderRadius: "6px", background: c + "2e", alignItems: "center", justifyContent: "center", color: c, flex: "none" } }, micIcon),
          h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, title),
          h("span", { style: { marginLeft: "auto", fontSize: "12px", color: c, flex: "none" } }, open ? "收起 ▴" : "展开 ▾"),
        ),
        open ? (typeof children === "function" ? children(true) : children) : null,
      );
    };

    // 提示小问号（hover 浮层显示 / 点击固定）；align=right 右对齐/center 居中/默认左对齐；place=top 上方展开
    const helpTip = (text, pinned, setPinned, hover, setHover, align, place) => h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
      h("button", {
        type: "button", "aria-label": "帮助", title: "帮助",
        style: {
          border: "none", borderRadius: "999px", width: "18px", height: "18px", padding: "0",
          background: pinned ? "var(--vk-accent,#4b6fff)" : "rgba(128,128,128,.15)",
          color: "inherit", cursor: "pointer", fontSize: "10px", fontWeight: 700,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        },
        onMouseDown: (e) => e.preventDefault(),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: () => { setPinned(!pinned); setHover(false); },
      }, "?"),
      (pinned || hover) ? h("div", {
        style: {
          position: "absolute", ...(place === "top" ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }), zIndex: 60,
          ...(align === "right" ? { right: "0", left: "auto" } : align === "center" ? { left: "50%", transform: "translateX(-50%)" } : { left: "0", right: "auto" }),
          background: "var(--dsw-specific-input-major,#ffffff)",
          border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
          padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
          fontSize: "12px", lineHeight: "1.7", color: "var(--dsw-alias-label-secondary,#9aa3ad)",
          minWidth: "320px", maxWidth: "460px",
        },
      }, text) : null,
    );

    // ── [2026-08-22] 设置页「图片识别」独立分区（settings.section，从语音服务拆出）──
    // 自包含：config 加载 / 部署位置 / 测试 / 提示词查看-编辑弹窗 / 测试图放大
    function VisionSettingsSection() {
      const [config, setConfig] = useState(null);
      const saveTimerRef = useRef(null);
      // 密钥显示开关（secretField 用）
      const [showKeys, setShowKeys] = useState({});
      const [visionTestTask, setVisionTestTask] = useState("describe");
      const [visionTestResult, setVisionTestResult] = useState(null); // { ok, text, model, durationMs, busy } | null
      const [visionZoom, setVisionZoom] = useState(null); // 放大查看的文本（null=关闭）
      const [visionDefaults, setVisionDefaults] = useState(null); // 内置默认提示词 {describe,text,reverse}
      const [visionEditKey, setVisionEditKey] = useState(null); // key=describe|text|reverse|null
      const [visionEditMode, setVisionEditMode] = useState("view"); // [2026-08-22] view=只读 / edit=编辑 / saved=已保存
      const [visionCopyState, setVisionCopyState] = useState(null); // [2026-08-22] 复制反馈: copied|fail|null
      const [visionEditDraft, setVisionEditDraft] = useState(""); // 编辑草稿（点保存才写配置）
      const [visionImgZoom, setVisionImgZoom] = useState(false);
      const [visionModeTipPinned, setVisionModeTipPinned] = useState(false);
      const [visionModeTipHover, setVisionModeTipHover] = useState(false);
      const btnSmall = { border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "rgba(128,128,128,.15)", color: "inherit", cursor: "pointer" };
      const VISION_TASK_LABELS = { describe: "describe 看图描述", reverse: "reverse 反推提示词", text: "text 提取文字" };
      // 各模式介绍（测试模式下拉后的「?」显示，随切换变化）
      const VISION_MODE_INTRO = {
        describe: "看图描述：让 AI 用一两句话简要描述图片内容。",
        reverse: "像素级反推：把图反推成可直接用于 AI 生图（即梦/可灵/SD/Midjourney 等）的完整中文提示词，输出较长。",
        text: "提取文字：逐字提取图中所有文字，按画面位置分行。",
      };
      const openPromptEditor = (key) => {
        setVisionEditKey(key);
        setVisionEditMode("view");
        setVisionEditDraft(((config?.vision?.prompts ?? {})[key] ?? "").trim() !== ""
          ? (config?.vision?.prompts ?? {})[key]
          : (visionDefaults ?? {})[key] ?? "");
      };
      // 当前某工具的有效提示词（配置值优先，空=内置默认）
      const effectivePrompt = (key) => {
        const cfg = (config?.vision?.prompts ?? {})[key];
        if (typeof cfg === "string" && cfg.trim() !== "") return cfg;
        return (visionDefaults ?? {})[key] ?? "";
      };
      const savePromptEdit = (key, value) => {
        const prompts = { ...(config?.vision?.prompts ?? {}), [key]: value };
        setVision({ prompts }, true);
      };
      const resetPromptEdit = (key) => {
        const prompts = { ...(config?.vision?.prompts ?? {}), [key]: "" };
        setVision({ prompts }, true);
        setVisionEditDraft((visionDefaults ?? {})[key] ?? "");
      };
      useEffect(() => {
        let dead = false;
        fetch("/voice-config").then((r) => r.json()).then((d) => { if (!dead && d?.ok) setConfig(d.config); }).catch(() => {});
        fetch("/voice-config/vision-prompts").then((r) => r.json()).then((d) => { if (!dead && d?.ok) setVisionDefaults(d.defaults); }).catch(() => {});
        return () => { dead = true; };
      }, []);
      if (config === null) {
        return h("div", { style: { padding: "16px", fontSize: "13px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "图片识别配置加载中…");
      }
      // secretField（本组件副本：依赖 showKeys）
      const secretField = (labelText, keyName, value, onChange, placeholder) => h("label", {
        style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "1 1 45%", minWidth: "220px" },
      }, labelText,
        h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
          h("input", {
            type: showKeys[keyName] ? "text" : "password",
            value: value,
            onChange: onChange,
            placeholder: placeholder,
            style: { ...vInput, flex: 1 },
          }),
          h("button", {
            type: "button", "aria-label": showKeys[keyName] ? "隐藏密钥" : "显示密钥", title: showKeys[keyName] ? "隐藏密钥" : "显示密钥",
            style: {
              border: "none", borderRadius: "6px", width: "32px", height: "32px", flex: "none",
              background: "rgba(128,128,128,.12)", color: "inherit", cursor: "pointer", fontSize: "14px",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            },
            onMouseDown: (e) => e.preventDefault(),
            onClick: () => setShowKeys((s) => ({ ...s, [keyName]: !s[keyName] })),
          }, showKeys[keyName] ? "🙈" : "👁"),
        ),
      );
      // 图片识别配置（顶层 vision 段）：读写同 /voice-config
      const setVision = (patch, autoSave) => {
        setConfig((c) => {
          if (c === null) return c;
          const next = { ...c, vision: { ...(c.vision ?? {}), ...patch } };
          if (autoSave) {
            if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = window.setTimeout(() => {
              fetch("/voice-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) })
                .then((r) => r.json())
                .then((d) => { if (d?.ok && d.config) setConfig(d.config); })
                .catch(() => {});
            }, 400);
          }
          return next;
        });
      };
      // 识图配置测试：调 host /voice-config/vision-test（内置测试图 + 所选模式）
      const testVision = () => {
        setVisionTestResult({ ok: true, text: "识别中…（首次调用可能需要 1-2 分钟）", busy: true });
        fetch("/voice-config/vision-test", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: visionTestTask }),
        }).then((r) => r.json()).then((d) => {
          setVisionTestResult(d?.ok
            ? { ok: true, text: d.text, model: d.model, durationMs: d.durationMs }
            : { ok: false, text: d?.error ?? "识图测试失败" });
        }).catch((e) => setVisionTestResult({ ok: false, text: String(e) }));
      };
      // [2026-08-22] 复制（参考 comfyui）：clipboard 不可用(非安全上下文)时 execCommand 兜底
      const copyText = async (text) => {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
          } else {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
            const ok = document.execCommand("copy"); document.body.removeChild(ta);
            if (!ok) throw new Error("execCommand copy 失败");
          }
          return true;
        } catch { return false; }
      };
      const copyWithFeedback = (text) => {
        copyText(text).then((ok) => {
          setVisionCopyState(ok ? "copied" : "fail");
          window.setTimeout(() => setVisionCopyState(null), 1500);
        });
      };
      // 编辑模式保存：写配置 → "已保存" → 1.2s 后回只读（弹窗不关，复制按钮常驻）
      const doSavePromptEdit = (key) => {
        savePromptEdit(key, visionEditDraft);
        setVisionEditMode("saved");
        window.setTimeout(() => setVisionEditMode("view"), 1200);
      };
      const visionIsOnline = ["online", "openai"].includes(config.vision?.provider ?? "local");
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "16px", width: "100%", boxSizing: "border-box" } },
        // 分区标题（含仓库链接，同语音分区样式）
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary,#e6e9ef)" } },
          "🖼️ 图片识别",
          h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 400, color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
            "让文本模型也能看图的识图工具（look_image）",
            h("span", { style: { color: "var(--dsw-alias-label-tertiary,#6b7384)" } }, "·"),
            h("a", {
              href: "https://github.com/oadank/dsh-input-tools",
              target: "_blank", rel: "noopener",
              title: "语音插件源码仓库（dsh-input-tools）",
              style: { color: "var(--dsw-alias-link,#5b9cff)", textDecoration: "none" },
            }, "插件仓库 ↗"),
            h("span", { style: { color: "var(--dsw-alias-label-tertiary,#6b7384)" } }, "·"),
            h("a", {
              href: "https://github.com/oadank/deepseek-harness",
              target: "_blank", rel: "noopener",
              title: "整合版：插件已内置，一键安装，推荐大多数用户",
              style: { color: "var(--dsw-alias-link,#5b9cff)", textDecoration: "none" },
            }, "整合版（推荐）↗"),
          ),
        ),
        // [2026-08-22] 直接可见的说明（分块条目排版）
        h("div", { style: { fontSize: "12px", lineHeight: 1.9, color: "var(--dsw-alias-label-secondary,#9aa3ad)", background: "rgba(128,128,128,.05)", border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", padding: "10px 12px" } },
          h("div", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "识图工具 look_image —— 三种模式（AI 收到图片后按提问自动选择）："),
          h("div", { style: { paddingLeft: "10px" } }, "· describe：看图描述（默认，一两句简要）"),
          h("div", { style: { paddingLeft: "10px" } }, "· reverse：像素级反推生图提示词"),
          h("div", { style: { paddingLeft: "10px" } }, "· text：逐字提取图中文字"),
          h("div", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)", marginTop: "6px" } }, "配置："),
          h("div", { style: { paddingLeft: "10px" } }, "· 「本地」= 本机起的 OpenAI 兼容 /v1 端点（如 ollama 11434/v1，无需 Key）"),
          h("div", { style: { paddingLeft: "10px" } }, "· 「在线」= 云端 API（填地址 + API Key）"),
          h("div", { style: { paddingLeft: "10px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)", marginTop: "2px" } }, "首次使用？一键装本地识图（ollama + qwen3-vl:4b-instruct）："),
          h("div", { style: { paddingLeft: "10px" } }, "· 要求：显卡驱动最新，显存 ≥ 3GB（N 卡/A 卡核显均可，跑不满会退回 CPU 慢速）"),
          h("div", { style: { paddingLeft: "10px" } },
            h("span", { style: { opacity: .8 } }, "Windows："),
            h("code", { style: { background: "rgba(91,156,255,.12)", padding: "1px 6px", borderRadius: "4px", fontFamily: "monospace", fontSize: "11px" } }, "winget install Ollama.Ollama && ollama pull qwen3-vl:4b-instruct"),
          ),
          h("div", { style: { paddingLeft: "10px" } },
            h("span", { style: { opacity: .8 } }, "macOS："),
            h("code", { style: { background: "rgba(91,156,255,.12)", padding: "1px 6px", borderRadius: "4px", fontFamily: "monospace", fontSize: "11px" } }, "brew install ollama && ollama pull qwen3-vl:4b-instruct"),
          ),
          h("div", { style: { paddingLeft: "10px" } },
            h("span", { style: { opacity: .8 } }, "Linux："),
            h("code", { style: { background: "rgba(91,156,255,.12)", padding: "1px 6px", borderRadius: "4px", fontFamily: "monospace", fontSize: "11px" } }, "curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen3-vl:4b-instruct"),
          ),
          h("div", { style: { paddingLeft: "10px" } }, "· 装完在下方「API 地址」填 http://127.0.0.1:11434/v1，模型填 qwen3-vl:4b-instruct，点「测试配置」即可"),
          h("div", { style: { paddingLeft: "10px" } }, "· 「在线」= 云端 API（填地址 + API Key）"),
          h("div", { style: { paddingLeft: "10px", opacity: .85 } }, "下方可测试配置连通、查看/编辑各模式提示词。"),
        ),
        // 配置卡片
        h("div", { style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px", background: "rgba(128,128,128,.05)" } },
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
            vField("部署位置", h("select", {
              value: visionIsOnline ? "online" : "local",
              onChange: (e) => {
                const p = e.target.value;
                const cur = String(config.vision?.baseUrl ?? "");
                if (p === "online") {
                  setVision({ provider: "online", baseUrl: cur && cur !== "http://127.0.0.1:11434/v1" ? cur : "https://api.siliconflow.cn/v1" }, true);
                } else {
                  setVision({ provider: "local", baseUrl: cur.startsWith("http://127.0.0.1") ? cur : "http://127.0.0.1:11434/v1" }, true);
                }
              },
              style: vInput,
            },
              h("option", { value: "local" }, "本地"),
              h("option", { value: "online" }, "在线"))),
            vField("API 地址（填到 /v1）", h("input", {
              value: config.vision?.baseUrl ?? "",
              onChange: (e) => setVision({ baseUrl: e.target.value }, true),
              placeholder: visionIsOnline ? "https://api.siliconflow.cn/v1" : "http://127.0.0.1:11434/v1",
              style: vInput,
            })),
            vField("模型", h("input", {
              value: config.vision?.model ?? "",
              onChange: (e) => setVision({ model: e.target.value }, true),
              placeholder: "qwen3-vl:4b-instruct",
              style: vInput,
            })),
            visionIsOnline
              ? secretField("API Key（在线服务必填）", "vision", config.vision?.apiKey ?? "", (e) => setVision({ apiKey: e.target.value }, true), "sk-...")
              : null,
            // [2026-09-07] 软超时: 主后端超过它就回退备用后端, 不再干等 timeoutMs
            // (历史默认 240s, 实测在线后端抖动/401 会把调用方卡死 4 分钟)
            vField("软超时（秒）", h("input", {
              type: "number", min: "3",
              value: String(Math.round((Number(config.vision?.softTimeoutMs) > 0 ? Number(config.vision.softTimeoutMs) : (visionIsOnline ? 20000 : 90000)) / 1000)),
              onChange: (e) => setVision({ softTimeoutMs: Math.max(3, Number(e.target.value) || 20) * 1000 }, true),
              title: "主后端超过这个秒数没返回就立刻回退备用后端。实测在线后端抖动会拖到 30s+ 甚至 401",
              style: vInput,
            })),
          ),
          // [2026-09-07] 回退后端配置
          h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--dsw-alias-border-l1,#333a45)", paddingTop: "10px", width: "100%" } },
            h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer", color: "var(--dsw-alias-label-primary,#e6e9ef)" } },
              h("input", {
                type: "checkbox",
                checked: (config.vision?.fallback?.enabled ?? true) !== false,
                onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), enabled: e.target.checked } }, true),
                style: { cursor: "pointer" },
              }),
              "主后端失败/超时时自动回退到备用后端",
            ),
            ((config.vision?.fallback?.enabled ?? true) !== false)
              ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", paddingLeft: "2px" } },
                  vField("回退·部署位置", h("select", {
                    value: ((config.vision?.fallback?.provider ?? "") || (visionIsOnline ? "local" : "online")),
                    onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), provider: e.target.value,
                      baseUrl: e.target.value === "local" ? "http://127.0.0.1:11434/v1" : (config.vision?.fallback?.baseUrl ?? "") } }, true),
                    style: vInput,
                  }, h("option", { value: "local" }, "本地"), h("option", { value: "online" }, "在线"))),
                  vField("回退·API 地址", h("input", {
                    value: config.vision?.fallback?.baseUrl ?? "",
                    onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), baseUrl: e.target.value } }, true),
                    placeholder: "http://127.0.0.1:11434/v1",
                    style: vInput,
                  })),
                  vField("回退·模型", h("input", {
                    value: config.vision?.fallback?.model ?? "",
                    onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), model: e.target.value } }, true),
                    placeholder: "qwen3-vl:4b-instruct",
                    style: vInput,
                  })),
                  (((config.vision?.fallback?.provider ?? "") || (visionIsOnline ? "local" : "online")) === "online")
                    ? vField("回退·API Key", h("input", {
                        type: "password",
                        value: config.vision?.fallback?.apiKey ?? "",
                        onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), apiKey: e.target.value } }, true),
                        placeholder: "sk-...",
                        style: vInput,
                      }))
                    : null,
                )
              : null,
          ),
          // 测试区：缩略图(点击放大) + 模式(带?介绍与✎编辑) + 测试按钮
          h("div", { style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", borderTop: "1px solid var(--dsw-alias-border-l1,#333a45)", paddingTop: "10px" } },
            h("img", {
              src: "/voice-config/vision-test-image",
              alt: "测试图（点击放大）",
              title: "点击放大查看测试图",
              onClick: () => setVisionImgZoom(true),
              style: { width: "64px", height: "64px", objectFit: "cover", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l1,#333a45)", flex: "none", background: "rgba(128,128,128,.1)", cursor: "zoom-in" },
            }),
            h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", flex: "1", minWidth: "260px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "none" } }, "测试模式："),
                h("select", {
                  value: visionTestTask,
                  onChange: (e) => setVisionTestTask(e.target.value),
                  style: { ...vInput, width: "auto", padding: "3px 8px", fontSize: "12px" },
                },
                  h("option", { value: "describe" }, "describe 看图描述"),
                  h("option", { value: "reverse" }, "reverse 反推提示词"),
                  h("option", { value: "text" }, "text 提取文字")),
                helpTip(VISION_MODE_INTRO[visionTestTask] ?? VISION_MODE_INTRO.describe,
                  visionModeTipPinned, setVisionModeTipPinned, visionModeTipHover, setVisionModeTipHover, "center", "top"),
                h("button", {
                  type: "button",
                  title: "查看/编辑「" + (VISION_TASK_LABELS[visionTestTask] ?? visionTestTask) + "」的提示词",
                  "aria-label": "编辑工具提示词",
                  style: {
                    border: "none", background: "none", cursor: "pointer", padding: "2px 6px",
                    color: "var(--dsw-alias-link,#5b9cff)", fontSize: "12px", lineHeight: "1.4",
                    display: "inline-flex", alignItems: "center", gap: "3px", borderRadius: "6px",
                  },
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => openPromptEditor(visionTestTask),
                }, "✎ 编辑工具提示词"),
                h("button", {
                  type: "button",
                  style: {
                    border: "none", borderRadius: "999px", padding: "7px 16px", fontSize: "12.5px", fontWeight: 600,
                    background: visionTestResult?.busy ? "rgba(229,72,77,.85)" : "rgba(128,128,128,.15)",
                    color: "inherit", cursor: "pointer",
                  },
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: testVision,
                }, visionTestResult?.busy ? "测试中…" : "测试识图")),
            ),
          ),
          // 测试结果：状态行在框外，文本框只放识别内容
          visionTestResult !== null ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", borderTop: "1px solid var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", opacity: .8 } },
              h("span", { style: { color: visionTestResult.ok ? "#3ecf8e" : "#e5484d" } }, visionTestResult.ok ? "✅ 识图成功" : "❌ 识别失败"),
              visionTestResult.ok && visionTestResult.durationMs !== undefined
                ? h("span", {}, "耗时 " + (visionTestResult.durationMs / 1000).toFixed(1) + "s" + (visionTestResult.model ? " · " + visionTestResult.model : ""))
                : null,
              // [2026-09-07] 走了回退就明确提示, 否则用户以为主后端是好的
              visionTestResult?.fallbackUsed
                ? h("span", { style: { color: "#f5a524" }, title: visionTestResult.fallbackReason ?? "" },
                    "⚠ 已回退备用后端" + (visionTestResult.fallbackReason ? "（" + visionTestResult.fallbackReason + "）" : ""))
                : null,
              h("span", { style: { marginLeft: "auto", flex: "none" } },
                (visionTestResult.text ?? "").length > 120 ? h("button", {
                  type: "button",
                  style: { border: "none", borderRadius: "6px", padding: "3px 10px", fontSize: "11px", fontWeight: 600, background: "rgba(91,156,255,.18)", color: "var(--dsw-alias-link,#5b9cff)", cursor: "pointer" },
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => setVisionZoom(visionTestResult.text),
                }, "🔍 放大查看") : null)),
            h("div", { style: {
              border: "1px solid " + (visionTestResult.ok ? "rgba(62,207,142,.4)" : "rgba(229,72,77,.4)"),
              borderRadius: "8px", padding: "8px 10px", fontSize: "12px", lineHeight: "1.6",
              background: "rgba(128,128,128,.06)", maxHeight: "140px", overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
            } },
              visionTestResult.busy ? visionTestResult.text : String(visionTestResult.text).slice(0, 120) + (String(visionTestResult.text).length > 120 ? "…" : "")),
          ) : null,
        ),
        // [2026-08-22] 放大查看识图结果（只读，AI 输出不可编辑）
        visionZoom !== null ? h("div", {
          style: {
            position: "fixed", inset: "0", zIndex: 9998, background: "rgba(0,0,0,.6)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: "24px",
          },
          onMouseDown: (e) => { if (e.target === e.currentTarget) setVisionZoom(null); },
        },
          h("div", { style: {
            background: "var(--dsw-alias-bg-primary,#1e222a)", border: "1px solid var(--dsw-alias-border-l1,#333a45)",
            borderRadius: "12px", width: "min(760px, 92vw)", maxHeight: "82vh", display: "flex", flexDirection: "column",
            boxShadow: "0 12px 48px rgba(0,0,0,.5)",
          } },
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "10px 14px", borderBottom: "1px solid var(--dsw-alias-border-l1,#333a45)", fontSize: "13px", fontWeight: 600 } },
              "🔍 识图结果",
              h("span", { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
                h("button", { type: "button", style: btnSmall, onMouseDown: (e) => e.preventDefault(), onClick: () => copyText(visionZoom) }, "一键复制"),
                h("button", {
                  type: "button",
                  style: { ...btnSmall, background: "rgba(229,72,77,.2)", color: "#e5484d" },
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => setVisionZoom(null),
                }, "关闭"))),
            h("pre", {
              spellCheck: false,
              style: {
                flex: "1", minHeight: "320px", margin: "12px 14px", padding: "10px 12px",
                background: "rgba(128,128,128,.06)", color: "inherit", border: "1px solid var(--dsw-alias-border-l1,#333a45)",
                borderRadius: "8px", fontSize: "12.5px", lineHeight: "1.7", fontFamily: "inherit",
                whiteSpace: "pre-wrap", wordBreak: "break-word", overflowY: "auto", userSelect: "text",
              },
            }, visionZoom),
          ),
        ) : null,
        // [2026-08-22] 提示词弹窗（参考 comfyui promptModal）：
        // textarea + readonly 只读(无光标)；复制按钮常驻标题栏(带兜底+反馈)；
        // 编辑/保存 toggle；恢复默认右下角常驻；保存后回只读且弹窗不关
        visionEditKey !== null ? h("div", {
          style: {
            position: "fixed", inset: "0", zIndex: 9998, background: "rgba(0,0,0,.6)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: "24px",
          },
          onMouseDown: (e) => { if (e.target === e.currentTarget) setVisionEditKey(null); },
        },
          h("div", { style: {
            background: "var(--dsw-alias-bg-primary,#1e222a)", border: "1px solid var(--dsw-alias-border-l1,#333a45)",
            borderRadius: "12px", width: "min(760px, 92vw)", maxHeight: "82vh", display: "flex", flexDirection: "column",
            boxShadow: "0 12px 48px rgba(0,0,0,.5)",
          } },
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "10px 14px", borderBottom: "1px solid var(--dsw-alias-border-l1,#333a45)", fontSize: "13px", fontWeight: 600 } },
              (VISION_TASK_LABELS[visionEditKey] ?? visionEditKey) + " 提示词",
              h("span", { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
                h("button", {
                  type: "button",
                  style: { ...btnSmall, ...(visionCopyState === "copied" ? { background: "rgba(62,207,142,.25)", color: "#3ecf8e" } : visionCopyState === "fail" ? { background: "rgba(229,72,77,.2)", color: "#e5484d" } : {}) },
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => copyWithFeedback(visionEditDraft),
                }, visionCopyState === "copied" ? "✅ 已复制" : visionCopyState === "fail" ? "❌ 复制失败" : "✂️ 一键复制"),
                visionEditMode === "view"
                  ? h("button", { type: "button", style: { ...btnSmall, background: "rgba(91,156,255,.2)", color: "var(--dsw-alias-link,#5b9cff)" }, onMouseDown: (e) => e.preventDefault(), onClick: () => setVisionEditMode("edit") }, "✏️ 编辑")
                  : visionEditMode === "saved"
                    ? h("button", { type: "button", style: { ...btnSmall, background: "rgba(62,207,142,.2)", color: "#3ecf8e" }, onMouseDown: (e) => e.preventDefault() }, "✅ 已保存")
                    : h("button", { type: "button", style: { ...btnSmall, background: "rgba(62,207,142,.25)", color: "#3ecf8e" }, onMouseDown: (e) => e.preventDefault(), onClick: () => doSavePromptEdit(visionEditKey) }, "💾 保存"),
                h("button", {
                  type: "button",
                  style: { ...btnSmall, background: "rgba(229,72,77,.2)", color: "#e5484d" },
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => setVisionEditKey(null),
                }, "✕ 关闭"))),
            h("textarea", {
              value: visionEditDraft,
              onChange: (e) => setVisionEditDraft(e.target.value),
              readOnly: visionEditMode !== "edit",
              spellCheck: false,
              style: {
                flex: "1", minHeight: "320px", margin: "12px 14px", padding: "10px 12px",
                background: "rgba(128,128,128,.06)", color: "inherit", border: "1px solid var(--dsw-alias-border-l1,#333a45)",
                borderRadius: "8px", fontSize: "12.5px", lineHeight: "1.7", fontFamily: "inherit", whiteSpace: "pre-wrap", resize: "vertical",
                ...(visionEditMode === "edit" ? { outline: "2px solid var(--vk-accent,#4b6fff)" } : { outline: "none" }),
              },
            }),
            h("div", { style: { padding: "0 14px 10px", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px", fontSize: "11px", opacity: .75 } },
              h("button", {
                type: "button",
                style: { border: "none", background: "none", cursor: "pointer", color: "#e5a53a", fontSize: "11.5px", textDecoration: "underline" },
                onMouseDown: (e) => e.preventDefault(),
                onClick: () => resetPromptEdit(visionEditKey),
              }, "↺ 恢复默认"),
            ),
          ),
        ) : null,
        // [2026-08-22] 测试图点击放大（大图 modal）
        visionImgZoom ? h("div", {
          style: {
            position: "fixed", inset: "0", zIndex: 9998, background: "rgba(0,0,0,.72)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: "24px",
          },
          onMouseDown: (e) => { if (e.target === e.currentTarget) setVisionImgZoom(false); },
        },
          h("div", { style: { position: "relative", maxWidth: "92vw", maxHeight: "88vh" } },
            h("img", {
              src: "/voice-config/vision-test-image",
              alt: "测试图大图",
              title: "点击缩小",
              onClick: () => setVisionImgZoom(false),
              style: { maxWidth: "92vw", maxHeight: "88vh", objectFit: "contain", borderRadius: "10px", boxShadow: "0 12px 48px rgba(0,0,0,.6)", display: "block", background: "rgba(255,255,255,.04)", cursor: "zoom-out" },
            }),
            h("button", {
              type: "button",
              title: "关闭",
              style: {
                position: "absolute", top: "-12px", right: "-12px",
                border: "none", borderRadius: "999px", width: "30px", height: "30px",
                background: "rgba(229,72,77,.9)", color: "#fff", fontSize: "16px", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              },
              onMouseDown: (e) => e.preventDefault(),
              onClick: () => setVisionImgZoom(false),
            }, "✕"),
          ),
        ) : null,
      );
    }

    // ── [2026-09-11] 设置页「全局人设 / MCP / Skill」管理分区 ──────────
    // host 端点（host-files.js）：/vscode-files/persona、/mcp、/skills
    const hostFilesBtn = { border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "var(--dsw-alias-interactive-bg,#4b6fff)", color: "#fff", cursor: "pointer" };
    const hostFilesBtnGhost = { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "6px", padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "transparent", color: "inherit", cursor: "pointer" };
    const hostFilesRow = { display: "flex", alignItems: "center", gap: "10px", padding: "7px 10px", border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", fontSize: "12.5px", color: "var(--dsw-alias-label-primary,#e6e9ef)" };
    const hostFilesHint = { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", lineHeight: 1.6 };

    function PersonaSection() {
      const [content, setContent] = useState("");
      const [loaded, setLoaded] = useState(false);
      const [status, setStatus] = useState(null);
      const statusTimer = useRef(null);
      useEffect(() => {
        fetch("/vscode-files/persona").then((r) => r.json()).then((d) => {
          if (d?.ok) setContent(typeof d.content === "string" ? d.content : "");
        }).catch(() => { /* 加载失败显示空 */ }).finally(() => setLoaded(true));
        return () => { if (statusTimer.current) window.clearTimeout(statusTimer.current); };
      }, []);
      const flash = (msg) => {
        setStatus(msg);
        if (statusTimer.current) window.clearTimeout(statusTimer.current);
        statusTimer.current = window.setTimeout(() => setStatus(null), 3000);
      };
      const save = async () => {
        try {
          const r = await fetch("/vscode-files/persona", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ content }),
          });
          const d = await r.json().catch(() => ({}));
          flash(d?.ok ? "已保存 ✓" : "保存失败: " + (d?.error ?? r.status));
        } catch (e) { flash("保存失败: " + e); }
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: hostFilesHint }, "全局人设：注入每个会话 system prompt 的持久指令（~/.dsh/global-persona.md），改完即存即生效（下一轮对话起效）。"),
        loaded
          ? h("textarea", {
            value: content, rows: 8,
            onChange: (e) => setContent(e.target.value),
            style: { ...vInput, fontFamily: "ui-monospace, monospace", resize: "vertical", lineHeight: 1.6 },
          })
          : h("div", { style: hostFilesHint }, "加载中…"),
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h("button", { type: "button", style: hostFilesBtn, onClick: save }, "保存人设"),
          status !== null && h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, status),
        ),
      );
    }

    // [2026-09-11 UI 二轮·老大反馈] 滑块开关（正规 toggle，替代 ON/OFF 胶囊）
    function ToggleSwitch({ on, onClick }) {
      return h("div", {
        role: "switch", "aria-checked": on ? "true" : "false",
        title: on ? "点击停用" : "点击启用", onClick,
        style: {
          width: "36px", height: "20px", borderRadius: "999px", flex: "none",
          background: on ? "var(--dsw-alias-interactive-active,#2ecc71)" : "rgba(128,128,128,.35)",
          position: "relative", cursor: "pointer", transition: "background .15s",
          boxShadow: "inset 0 1px 2px rgba(0,0,0,.15)",
        },
      },
        h("div", {
          style: {
            position: "absolute", top: "2px", left: on ? "18px" : "2px",
            width: "16px", height: "16px", borderRadius: "50%", background: "#fff",
            transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.35)",
          },
        }),
      );
    }
    // 类型小徽标（stdio/http/目录/文件）
    const KindBadge = (text) => h("span", {
      style: {
        flex: "none", fontSize: "10.5px", fontWeight: 600, lineHeight: "16px",
        padding: "0 7px", borderRadius: "5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)",
        background: "rgba(128,128,128,.14)", border: "1px solid var(--dsw-alias-border-l1,#333a45)",
      },
    }, text);
    const hostFilesRowWrap = { display: "flex", alignItems: "center", gap: "10px", padding: "7px 10px", border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", fontSize: "12.5px", color: "var(--dsw-alias-label-primary,#e6e9ef)" };

    function McpSection() {
      const [servers, setServers] = useState(null);
      // form = 编辑/添加共享；editingId !== null 表示编辑态（名称只读）
      const [form, setForm] = useState(null);
      const [editingId, setEditingId] = useState(null);
      const [status, setStatus] = useState(null);
      const reload = () => {
        fetch("/vscode-files/mcp").then((r) => r.json()).then((d) => setServers(Array.isArray(d?.servers) ? d.servers : [])).catch(() => setServers([]));
      };
      useEffect(() => { reload(); }, []);
      const post = async (path, body) => {
        try {
          const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
          const d = await r.json().catch(() => ({}));
          if (!d?.ok) { setStatus(d?.error ?? ("HTTP " + r.status)); return false; }
          setStatus(null);
          reload();
          return true;
        } catch (e) { setStatus(String(e)); return false; }
      };
      const emptyForm = { serverName: "", transport: "stdio", command: "", url: "", args: "" };
      const closeForm = () => { setForm(null); setEditingId(null); };
      const submit = async () => {
        const args = form.args.split(/\s+/).filter(Boolean);
        const body = { transport: form.transport, command: form.command.trim(), url: form.url.trim(), args };
        const ok = editingId !== null
          ? await post("/vscode-files/mcp/update", { ...body, id: editingId })
          : await post("/vscode-files/mcp/add", { ...body, serverName: form.serverName.trim() });
        if (ok) closeForm();
      };
      const startEdit = (s) => {
        setEditingId(s.id);
        setForm({
          serverName: s.serverName, transport: s.transport ?? "stdio",
          command: s.command ?? "", url: s.url ?? "",
          args: Array.isArray(s.args) ? s.args.join(" ") : "",
        });
      };
      const formOpen = form !== null;
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: hostFilesHint }, "MCP 服务器（~/.dsh/mcp-servers.json）：开关实时挂载/卸载；「编辑」改启动命令后立即重挂。"),
        servers === null
          ? h("div", { style: hostFilesHint }, "加载中…")
          : servers.length === 0
            ? h("div", { style: hostFilesHint }, "还没有 MCP 服务器，点下方「添加」。")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              servers.map((s) => h("div", { key: s.id, style: { ...hostFilesRowWrap, flexDirection: "column", alignItems: "stretch", gap: "4px" } },
                h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
                  h(ToggleSwitch, { on: s.enabled !== false, onClick: () => post("/vscode-files/mcp/toggle", { id: s.id }) }),
                  h("span", { style: { fontWeight: 600 } }, s.serverName),
                  KindBadge(s.transport === "stdio" ? "stdio" : "http"),
                  s.hasEnv === true && KindBadge("env"),
                  h("span", { style: { flex: "1" } }),
                  h("button", { type: "button", style: hostFilesBtnGhost, onClick: () => startEdit(s) }, "编辑"),
                  h("button", { type: "button", style: hostFilesBtnGhost, onClick: () => post("/vscode-files/mcp/delete", { id: s.id }) }, "删除"),
                ),
                h("div", {
                  title: s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url,
                  style: {
                    fontFamily: "ui-monospace, Consolas, monospace", fontSize: "11.5px",
                    color: "var(--dsw-alias-label-secondary,#9aa3ad)", paddingLeft: "46px",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  },
                }, s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url),
              ))),
        status !== null && h("div", { style: { ...hostFilesHint, color: "#e5484d" } }, status),
        formOpen
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", padding: "10px", border: "1px dashed var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px" } },
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, editingId !== null ? `编辑：${editingId}` : "添加 MCP 服务器"),
            h("div", { style: { display: "flex", gap: "8px" } },
              editingId !== null
                ? h("input", { value: form.serverName, disabled: true, title: "名称不可改（如需改名请删除后重建）", style: { ...vInput, flex: "1", opacity: .6 } })
                : h("input", { placeholder: "名称（字母/数字/_-）", value: form.serverName, onChange: (e) => setForm({ ...form, serverName: e.target.value }), style: { ...vInput, flex: "1" } }),
              h("select", { value: form.transport, onChange: (e) => setForm({ ...form, transport: e.target.value }), style: { ...vInput, width: "auto" } },
                h("option", { value: "stdio" }, "stdio"), h("option", { value: "streamable-http" }, "streamable-http")),
            ),
            form.transport === "stdio"
              ? h("div", { style: { display: "flex", gap: "8px" } },
                h("input", { placeholder: "可执行文件，如 node / python.exe", value: form.command, onChange: (e) => setForm({ ...form, command: e.target.value }), style: { ...vInput, flex: "2" } }),
                h("input", { placeholder: "脚本与参数（空格分隔），如 C:\\D\\opt\\xxx\\mcp.js", value: form.args, onChange: (e) => setForm({ ...form, args: e.target.value }), style: { ...vInput, flex: "3" } }),
              )
              : h("input", { placeholder: "URL，如 http://127.0.0.1:3114/mcp", value: form.url, onChange: (e) => setForm({ ...form, url: e.target.value }), style: vInput }),
            h("div", { style: { display: "flex", gap: "8px" } },
              h("button", { type: "button", style: hostFilesBtn, onClick: submit }, editingId !== null ? "保存" : "添加"),
              h("button", { type: "button", style: hostFilesBtnGhost, onClick: closeForm }, "取消"),
            ),
          )
          : h("div", null, h("button", { type: "button", style: hostFilesBtnGhost, onClick: () => { setEditingId(null); setForm({ ...emptyForm }); } }, "＋ 添加 MCP 服务器")),
      );
    }

    function SkillsSection() {
      const [skills, setSkills] = useState(null);
      // 编辑器：{ name, path(要读写的文件), enabled, kind } → 读文件 → textarea → 写回
      const [editing, setEditing] = useState(null);
      const [content, setContent] = useState("");
      const [status, setStatus] = useState(null);
      const reload = () => {
        fetch("/vscode-files/skills").then((r) => r.json()).then((d) => setSkills(Array.isArray(d?.skills) ? d.skills : [])).catch(() => setSkills([]));
      };
      useEffect(() => { reload(); }, []);
      const post = async (path, body) => {
        const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
        const d = await r.json().catch(() => ({}));
        if (d?.ok) reload();
        return d?.ok === true;
      };
      // 目录型：说明文件 SKILL.md（停用态是 SKILL.md.disabled）；单文件型：文件本身
      const openEditor = async (s) => {
        const doc = s.kind === "dir"
          ? (s.enabled !== false ? s.path + "\\SKILL.md" : s.path + "\\SKILL.md.disabled")
          : s.path;
        setEditing({ ...s, doc });
        setStatus("加载中…");
        try {
          const r = await fetch("/vscode-files/read?path=" + encodeURIComponent(doc));
          const d = await r.json();
          if (d?.ok) { setContent(typeof d.content === "string" ? d.content : ""); setStatus(d.kind === "binary" ? "该文件是二进制，无法编辑" : null); }
          else setStatus(d?.error ?? ("HTTP " + r.status));
        } catch (e) { setStatus(String(e)); }
      };
      const saveEditor = async () => {
        const r = await fetch("/vscode-files/write", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: editing.doc, content }),
        });
        const d = await r.json().catch(() => ({}));
        setStatus(d?.ok ? "已保存 ✓" : "保存失败: " + (d?.error ?? r.status));
        if (d?.ok) setTimeout(() => setStatus(null), 2500);
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: hostFilesHint }, "Skill（~/.dsh/skills/）：开关停用即改 .disabled；「编辑」改 SKILL.md（指令正文），保存即生效。"),
        skills === null
          ? h("div", { style: hostFilesHint }, "加载中…")
          : skills.length === 0
            ? h("div", { style: hostFilesHint }, "还没有 Skill。")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              skills.map((s) => h("div", { key: s.path, style: hostFilesRowWrap },
                h(ToggleSwitch, { on: s.enabled !== false, onClick: () => post("/vscode-files/skills/toggle", { path: s.path }) }),
                h("span", { style: { fontWeight: 600 } }, s.name),
                KindBadge(s.kind === "dir" ? "目录" : "单文件"),
                h("span", { style: { flex: "1" } }),
                h("button", { type: "button", style: hostFilesBtnGhost, onClick: () => openEditor(s) }, "编辑"),
                h("button", { type: "button", style: hostFilesBtnGhost, onClick: () => post("/vscode-files/skills/delete", { path: s.path }) }, "删除"),
              ))),
        editing !== null && h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", padding: "10px", border: "1px dashed var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("span", { style: { fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, `编辑：${editing.name}`),
            h("span", { style: { fontSize: "11px", fontFamily: "ui-monospace, monospace", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, editing.doc),
            h("span", { style: { flex: "1" } }),
            h("button", { type: "button", style: hostFilesBtnGhost, onClick: () => { setEditing(null); setStatus(null); } }, "关闭"),
          ),
          h("textarea", {
            value: content, rows: 12,
            onChange: (e) => setContent(e.target.value),
            style: { ...vInput, fontFamily: "ui-monospace, monospace", resize: "vertical", lineHeight: 1.6 },
          }),
          h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
            h("button", { type: "button", style: hostFilesBtn, onClick: saveEditor }, "保存"),
            status !== null && h("span", { style: { fontSize: "12px", color: status.startsWith("已保存") ? "var(--dsw-alias-label-secondary,#9aa3ad)" : "#e5484d" } }, status),
          ),
        ),
      );
    }

    function VoiceSettingsSection() {
      const [config, setConfig] = useState(null);
      const [meta, setMeta] = useState(null);
      // [2026-08-21] 语音能力状态面板（安装即用能力 vs dsh 原生契约支持）
      const [caps, setCaps] = useState(null);
      useEffect(() => {
        fetch("/voice/capabilities").then((r) => r.json()).then((d) => {
          if (d?.ok) setCaps(d.capabilities);
        }).catch(() => { /* 检测失败不阻塞设置页 */ });
      }, []);
      // [本地改造 2026-08-21] 服务商卡片折叠状态（去复选框后由折叠控制显隐，默认展开）
      const [openCards, setOpenCards] = useState({ edge: true, xiaomi: true, local: true, ali: true, audio8: true });
      const toggleCard = (key) => setOpenCards((s) => ({ ...s, [key]: !s[key] }));
      const [previewing, setPreviewing] = useState(null); // 正在试听的标识：engine / emotion:key / style:key
      const [rulesPinned, setRulesPinned] = useState(false);
      const [rulesHover, setRulesHover] = useState(false);
      const [cloneListTipPinned, setCloneListTipPinned] = useState(false);
      const [cloneListTipHover, setCloneListTipHover] = useState(false);
      // [本地改造 2026-08-22] 克隆音色「?」弹层：显示该音色默认沟通指令 + 试听文本（用户想看到，之前是隐藏的）
      const [cloneInfoId, setCloneInfoId] = useState(null);   // 当前展开信息的样本 id（hover 或 pinned）
      const [cloneInfoPinned, setCloneInfoPinned] = useState(false);
      const [designTipPinned, setDesignTipPinned] = useState(false);
      const [designTipHover, setDesignTipHover] = useState(false);
      const [asrTipPinned, setAsrTipPinned] = useState(false);
      const [asrTipHover, setAsrTipHover] = useState(false);
      const [xmTipPinned, setXmTipPinned] = useState(false);
      const [xmTipHover, setXmTipHover] = useState(false);
      // 本地 TTS 卡片标题的 ? 提示 state
      const [localTipPinned, setLocalTipPinned] = useState(false);
      const [localTipHover, setLocalTipHover] = useState(false);
      // 3 个 VoiceDesign 官方示例的 Instruct/Text 悬浮提示 state
      const [vdExamplePins, setVdExamplePins] = useState([false, false, false]);
      // [2026-09-01] Audio8 上传克隆音色（老大：本地克隆缺上传按钮）：选音频 → ASR 转写 → 注册 → 刷新音色列表
      const [a8Adding, setA8Adding] = useState(false);
      const [a8AddMsg, setA8AddMsg] = useState(null); // { ok, text } | null
      const a8FileRef = useRef(null);
      const addAudio8Voice = async (file) => {
        if (file === null || file === undefined) return;
        setA8AddMsg(null);
        if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(file.name) && !/audio\//.test(file.type)) {
          setA8AddMsg({ ok: false, text: "仅支持音频文件（mp3 / wav / ogg / m4a）" });
          return;
        }
        if (file.size > 20 * 1024 * 1024) {
          setA8AddMsg({ ok: false, text: "音频需在 20MB 以内（参考音建议 ≤30 秒、单人纯人声）" });
          return;
        }
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        setA8Adding(true);
        try {
          const r = await fetch("/voice-config/audio8/register", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              // 名字=文件名（去扩展名），中文会转英文 id + display 存中文名
              name: file.name.replace(/\.[a-z0-9]+$/i, ""),
              audioBase64: data,
              mediaType: file.type || "audio/wav",
            }),
          });
          const d = await r.json();
          if (d?.ok) {
            setA8AddMsg({ ok: true, text: `已注册音色「${d.display || d.voice}」（逐字文本：${d.text}）` });
            // 刷新音色列表（audio8Voices 来自 /voice-config/engines）
            fetch("/voice-config/engines").then((r2) => r2.json()).then((d2) => { if (d2?.ok) setMeta(d2.engines); }).catch(() => {});
          } else {
            setA8AddMsg({ ok: false, text: d?.error ?? "注册失败" });
          }
        } catch (e) {
          setA8AddMsg({ ok: false, text: String(e?.message ?? e) });
        }
        setA8Adding(false);
        if (a8FileRef.current !== null) a8FileRef.current.value = "";
      };
      // [2026-09-01] Audio8 克隆声秒表：点「克隆声」那瞬间开始跳秒，音频真正出声才停
      const [a8Dur, setA8Dur] = useState(null); // 毫秒；null=没在计时
      const a8TickerRef = useRef(null);
      const a8T0Ref = useRef(0);
      const startA8Ticker = () => {
        if (a8TickerRef.current !== null) clearInterval(a8TickerRef.current);
        a8T0Ref.current = Date.now();
        setA8Dur(0);
        a8TickerRef.current = setInterval(() => setA8Dur(Date.now() - a8T0Ref.current), 100);
      };
      const stopA8Ticker = () => {
        if (a8TickerRef.current !== null) { clearInterval(a8TickerRef.current); a8TickerRef.current = null; }
        setA8Dur(Date.now() - a8T0Ref.current);
      };
      const fmtA8Dur = (ms) => (ms === null ? "" : (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms"));
      const [vdExampleHovers, setVdExampleHovers] = useState([false, false, false]);
      const previewRef = useRef(null);
      const previewTagRef = useRef(null); // [本地改造 2026-08-21] 当前播放的试听 tag，用于「再点=停止」
      const newCloneNameRef = useRef(null);
      const newClonePathRef = useRef(null);
      // ASR 语音识别测试状态（示例音频 + 识别）
      const [asrResult, setAsrResult] = useState(null); // { ok, text, busy } | null
      // [本地改造 2026-08-21] 克隆样本添加（选择音频 → 上传）
      // [2026-09-01] 老大：名称/试听文本/沟通指令三个输入框全删 —— 名字用文件名，其余后端内置默认
      const [addingClone, setAddingClone] = useState(false);
      const [cloneAddMsg, setCloneAddMsg] = useState(null); // { ok, text } | null
      const cloneFileRef = useRef(null);
      const asrAudioRef = useRef(null);
      const asrSampleBase64Ref = useRef(null);
      const [asrInstalling, setAsrInstalling] = useState(false); // 一键安装进行中
      const [asrCmd, setAsrCmd] = useState(null); // 待手动复制的安装命令
      const [vdSamples, setVdSamples] = useState([]); // VoiceDesign 官方示例音频（预生成）
      // [2026-08-21] 试听失败的错误提示（之前失败静默无反馈）
      const [previewErr, setPreviewErr] = useState(null);
      // [2026-08-22] 试听失败浮动 Toast（fixed 顶部居中，醒目弹窗式，6 秒自动消失）
      useEffect(() => {
        if (previewErr === null) return;
        const t = window.setTimeout(() => setPreviewErr(null), 6000);
        return () => window.clearTimeout(t);
      }, [previewErr]);
      // [2026-08-21] API Key 明文/密文切换（眼睛图标）
      const [showKeys, setShowKeys] = useState({});
      // [2026-08-21] 本地 TTS 一键安装命令
      const [ttsInstalling, setTtsInstalling] = useState(false);
      const [ttsCmd, setTtsCmd] = useState(null);
      // [2026-08-21] 密钥输入框 + 眼睛切换（明文/密文），keyName 作 state map 键
      const secretField = (labelText, keyName, value, onChange, placeholder) => h("label", {
        style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "1 1 45%", minWidth: "220px" },
      }, labelText,
        h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
          h("input", {
            type: showKeys[keyName] ? "text" : "password",
            value: value,
            onChange: onChange,
            placeholder: placeholder,
            style: { ...vInput, flex: 1 },
          }),
          h("button", {
            type: "button", "aria-label": showKeys[keyName] ? "隐藏密钥" : "显示密钥", title: showKeys[keyName] ? "隐藏密钥" : "显示密钥",
            style: {
              border: "none", borderRadius: "6px", width: "32px", height: "32px", flex: "none",
              background: "rgba(128,128,128,.12)", color: "inherit", cursor: "pointer", fontSize: "14px",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            },
            onMouseDown: (e) => e.preventDefault(),
            onClick: () => setShowKeys((s) => ({ ...s, [keyName]: !s[keyName] })),
          }, showKeys[keyName] ? "🙈" : "👁"),
        ),
      );

      useEffect(() => {
        let dead = false;
        fetch("/voice-config").then((r) => r.json()).then((d) => { if (!dead && d?.ok) { setConfig(d.config); setAutoPlayAssistantVoice(d.config?.autoPlayAssistantVoice !== false); } }).catch(() => {});
        fetch("/voice-config/engines").then((r) => r.json()).then((d) => { if (!dead && d?.ok) setMeta(d.engines); }).catch(() => {});
        // [2026-08-22] 识图内置默认提示词（编辑弹窗预填用）
        fetch("/voice-config/vision-prompts").then((r) => r.json()).then((d) => { if (!dead && d?.ok) setVisionDefaults(d.defaults); }).catch(() => {});
        // 自动加载 ASR 示例音频（无需手动点"加载"）
        fetch("/asr/sample").then((r) => r.json()).then((d) => {
          if (!dead && d?.ok) {
            asrSampleBase64Ref.current = d.data;
            if (asrAudioRef.current !== null) asrAudioRef.current.src = "data:" + d.mediaType + ";base64," + d.data;
          }
        }).catch(() => {});
        // 自动加载 VoiceDesign 官方示例音频（预生成）
        fetch("/asr/voice-design-samples").then((r) => r.json()).then((d) => {
          if (!dead && d?.ok && Array.isArray(d.samples)) setVdSamples(d.samples);
        }).catch(() => {});
        // 自动检测本机 ASR 组件（不覆盖用户已保存的配置，只静默记录）
        fetch("/asr/detect").then((r) => r.json()).then((d) => {
          if (!dead && d?.ok && d.detected?.serviceOk) {
            // 服务可达时静默确保 url 已填
          }
        }).catch(() => {});
        return () => { dead = true; if (previewRef.current !== null) previewRef.current.pause(); };
      }, []);

      // 自动保存的 setEngine（勾选/输入变化后立即持久化，防止刷新丢失；无保存按钮）
      // [本地改造 2026-08-21] 保存后以服务端返回的 config 为准刷新本地 state——
      // 避免"前端旧 config 全量覆盖服务端新变更"（如服务端新加的克隆样本被清空）
      const saveTimerRef = useRef(null);
      // topPatch: 顶层字段补丁（如 { defaultEngine: "voicedesign" }），与引擎配置同一次 setConfig/保存，原子生效
      const setEngine = (key, patch, autoSave, topPatch) => {
        setConfig((c) => {
          if (c === null) return c;
          const next = { ...c, ...(topPatch ?? {}), engines: { ...c.engines, [key]: { ...c.engines[key], ...patch } } };
          if (autoSave) {
            if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = window.setTimeout(() => {
              fetch("/voice-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) })
                .then((r) => r.json())
                .then((d) => { if (d?.ok && d.config) setConfig(d.config); })
                .catch(() => {});
            }, 400);
          }
          return next;
        });
      };

      // [2026-09-01] audio8 下拉「选中即默认」：配置里没选 / 选了已被删掉的音色 → 自动落到最后一个已注册音色并持久化。
      // 不做这一步会出「下拉显示 A、bot 实际用自动」的不一致（配置为空时服务端走自动选音色）。
      useEffect(() => {
        if (!config || !meta?.audio8Voices?.length) return;
        const voices = meta.audio8Voices.map((v) => (typeof v === "string" ? v : v.name));
        const cur = config.engines?.audio8?.voice ?? "";
        if (cur !== "" && voices.includes(cur)) return;
        setEngine("audio8", { voice: voices[voices.length - 1] }, true);
      }, [meta, config?.engines?.audio8?.voice]);

      // [本地改造 2026-08-21] 克隆样本添加：选音频文件 → 校验格式/大小 → 上传命名
      const addCloneSample = async (file) => {
        if (file === null || file === undefined) return;
        setCloneAddMsg(null);
        if (!/\.(mp3|wav)$/i.test(file.name) && !/audio\/(mpeg|wav)/.test(file.type)) {
          setCloneAddMsg({ ok: false, text: "仅支持 mp3 / wav 格式" });
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          setCloneAddMsg({ ok: false, text: "音频需在 10MB 以内（官方限制；参考语音建议 15-60 秒，越长克隆越准）" });
          return;
        }
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        setAddingClone(true);
        try {
          const r = await fetch("/voice-config/voice-clone/add", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              // [2026-09-01] 名字=文件名（去扩展名）；context/previewText 不传，后端内置默认
              name: file.name.replace(/\.(mp3|wav)$/i, ""),
              audioBase64: data,
              mediaType: file.type || "audio/wav",
            }),
          });
          const d = await r.json();
          if (d?.ok) {
            setCloneAddMsg({ ok: true, text: "已添加克隆音色「" + d.sample.name + "」，如需默认使用，在「默认语音引擎」选「小米克隆」即可" });
            // [本地改造 2026-08-21] 以服务端返回的 config 为准刷新（含新增样本），避免本地拼装丢字段
            if (d.config) setConfig(d.config);
          } else {
            setCloneAddMsg({ ok: false, text: d?.error ?? "添加失败" });
          }
        } catch (e) {
          setCloneAddMsg({ ok: false, text: String(e?.message ?? e) });
        }
        setAddingClone(false);
        if (cloneFileRef.current !== null) cloneFileRef.current.value = "";
      };

      // 音色试听：POST /voice-config/preview → 播放返回音频；tag 用于区分多个试听按钮状态；text/cmd/url 可临时指定
      // [2026-08-21] 失败时显示错误（之前静默无提示，用户填错 API Key 毫无反馈）
      // onStart = 真正出声的那一刻（秒表用它停）；onFail = 合成/播放失败（也要停表，否则一直跳）
      const previewVoice = (engine, voice, context, samplePath, tag, extra, onStart, onFail) => {
        if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
        const curTag = tag ?? engine;
        previewTagRef.current = curTag;
        setPreviewing(curTag);
        setPreviewErr(null);
        fetch("/voice-config/preview", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            engine, voice: voice ?? undefined, context: context ?? undefined, samplePath: samplePath ?? undefined,
            text: extra?.text ?? undefined, cmd: extra?.cmd ?? undefined, url: extra?.url ?? undefined,
            cloneContext: extra?.cloneContext ?? undefined, // [2026-08-22] 克隆试听可带样本自带指令
          }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d?.ok) { if (previewTagRef.current === curTag) setPreviewing(null); setPreviewErr(d?.error ?? "试听失败"); if (onFail) onFail(); return; }
            if (previewTagRef.current !== curTag) return; // 已被「再点=停止」或切换，丢弃
            const audio = new Audio("data:" + d.mediaType + ";base64," + d.data);
            if (onStart) audio.onplaying = () => { if (previewTagRef.current === curTag) onStart(); };
            previewRef.current = audio;
            audio.onended = () => { if (previewTagRef.current === curTag) setPreviewing(null); };
            audio.onerror = () => {
              if (previewTagRef.current === curTag) {
                setPreviewing(null);
                setPreviewErr("音频加载/播放失败（服务可能返回了无效音频）");
              }
            };
            audio.play().catch(() => {
              if (previewTagRef.current === curTag) {
                setPreviewing(null);
                setPreviewErr("音频加载/播放失败（服务可能返回了无效音频）");
              }
            });
          })
          .catch((e) => { if (previewTagRef.current === curTag) setPreviewing(null); setPreviewErr(String(e?.message ?? e)); if (onFail) onFail(); });
      };

      // [本地改造 2026-08-21] 试听克隆样本的原始音频（用于和克隆合成效果对比还原度）
      const previewSourceVoice = async (path, tag) => {
        if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
        previewTagRef.current = tag;
        setPreviewing(tag);
        try {
          const r = await fetch("/voice-config/voice-clone/source", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const d = await r.json();
          if (!d?.ok) { if (previewTagRef.current === tag) { setPreviewing(null); setPreviewErr(d?.error ?? "读取原音失败"); } return; }
          if (previewTagRef.current !== tag) return; // 已被「再点=停止」或切换，丢弃
          const audio = new Audio("data:" + d.mediaType + ";base64," + d.data);
          previewRef.current = audio;
          audio.onended = () => { if (previewTagRef.current === tag) setPreviewing(null); };
          audio.onerror = () => { if (previewTagRef.current === tag) setPreviewing(null); };
          audio.play().catch(() => { if (previewTagRef.current === tag) setPreviewing(null); });
        } catch { if (previewTagRef.current === tag) setPreviewing(null); }
      };

      // [2026-09-01] Audio8 原音试听：播 voices\<voice>\reference.wav（和「克隆声」对照听还原度）
      const playAudio8Source = async (voice, tag) => {
        if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
        previewTagRef.current = tag;
        setPreviewing(tag);
        setPreviewErr(null);
        try {
          const r = await fetch("/voice-config/audio8/source", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ voice }),
          });
          const d = await r.json();
          if (!d?.ok) { if (previewTagRef.current === tag) { setPreviewing(null); setPreviewErr(d?.error ?? "读取原音失败"); } return; }
          if (previewTagRef.current !== tag) return;
          const audio = new Audio("data:" + d.mediaType + ";base64," + d.data);
          previewRef.current = audio;
          audio.onended = () => { if (previewTagRef.current === tag) setPreviewing(null); };
          audio.onerror = () => { if (previewTagRef.current === tag) { setPreviewing(null); setPreviewErr("原音加载失败"); } };
          audio.play().catch(() => { if (previewTagRef.current === tag) { setPreviewing(null); setPreviewErr("原音播放失败"); } });
        } catch (e) { if (previewTagRef.current === tag) { setPreviewing(null); setPreviewErr(String(e?.message ?? e)); } }
      };

      // [本地改造 2026-08-22] 播放合成试听录音：默认样本=预生成静态文件（免联网，和 VoiceDesign 官方示例同类）；
      // 没有预生成录音（自建样本）→ 回退在线合成，并带上该样本自己的指令/文本
      const playBakedPreview = async (sp, tag) => {
        if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
        previewTagRef.current = tag;
        setPreviewing(tag);
        setPreviewErr(null);
        try {
          const r = await fetch("/voice-config/voice-clone/preview-sample?id=" + encodeURIComponent(sp.id));
          const d = await r.json();
          if (!d?.ok) {
            previewTagRef.current = null;
            setPreviewing(null);
            previewVoice("voiceclone", undefined, undefined, sp.path, tag, {
              text: (sp.previewText && sp.previewText.trim() !== "") ? sp.previewText : CLONE_PREVIEW_TEXT,
              cloneContext: (sp.context && sp.context.trim() !== "") ? sp.context : "",
            });
            return;
          }
          const audio = new Audio("data:" + d.mediaType + ";base64," + d.data);
          previewRef.current = audio;
          audio.onended = () => { if (previewTagRef.current === tag) setPreviewing(null); };
          audio.onerror = () => { if (previewTagRef.current === tag) setPreviewing(null); setPreviewErr("音频加载失败（试听录音可能已损坏）"); };
          audio.play().catch(() => { if (previewTagRef.current === tag) setPreviewing(null); });
        } catch (e) { if (previewTagRef.current === tag) setPreviewing(null); setPreviewErr(String(e?.message ?? e)); }
      };

      // [2026-09-01] 带文字的试听按钮（Audio8 卡片专用）：30x30 图标按钮分不清「原音」和「克隆声」，
      // 老大要的就是两个能一眼认出来的按钮，所以这里带文字，播放中变「⏹ 停止」，再点=停。
      // onStop = 播放中被再点（停止）时的回调（克隆声用它停秒表，否则秒表会一直跳）
      const a8Btn = (tag, text, onClick, onStop) => h("button", {
        type: "button", title: text,
        style: {
          border: "none", borderRadius: "6px", padding: "4px 10px", flex: "none", cursor: "pointer",
          background: previewing === tag ? "rgba(229,72,77,.25)" : "rgba(128,128,128,.15)",
          color: "inherit", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px",
        },
        onMouseDown: (e) => e.preventDefault(),
        onClick: (e) => {
          // [2026-09-01] 按钮可能嵌在可点击行里（如语音设计示例行），点按钮不要冒泡去改选中
          if (e && typeof e.stopPropagation === "function") e.stopPropagation();
          if (previewing === tag) {
            previewTagRef.current = null;
            if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
            setPreviewing(null);
            if (onStop) onStop();
            return;
          }
          onClick();
        },
      }, previewing === tag ? "⏹ 停止" : text);

      // [2026-09-01] 老大：官方示例直接播预生成固定文件（不实时合成、不花额度）；没预生成文件才实时兜底
      const playVdSample = (i) => {
        const tag = "vd-ex:" + VD_KEYS[i];
        if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
        previewTagRef.current = tag;
        setPreviewing(tag);
        setPreviewErr(null);
        const sm = vdSamples[i];
        if (!sm || !sm.data) {
          const ex = VOICE_DESIGN_EXAMPLES[i];
          previewVoice("voicedesign", undefined, ex.instruct, undefined, tag, { text: ex.text });
          return;
        }
        const audio = new Audio("data:" + sm.mediaType + ";base64," + sm.data);
        previewRef.current = audio;
        audio.onended = () => { if (previewTagRef.current === tag) { previewTagRef.current = null; setPreviewing(null); } };
        audio.onerror = () => { if (previewTagRef.current === tag) { previewTagRef.current = null; setPreviewing(null); setPreviewErr("预生成音频加载失败"); } };
        audio.play().catch(() => { if (previewTagRef.current === tag) { previewTagRef.current = null; setPreviewing(null); } });
      };

      const previewBtn = (tag, label, onClick, icon) => h("button", {
        type: "button", "aria-label": label, title: label,
        style: {
          border: "none", borderRadius: "6px", width: "30px", height: "30px", flex: "none",
          background: previewing === tag ? "rgba(229,72,77,.25)" : "rgba(128,128,128,.15)",
          color: "inherit", cursor: "pointer", fontSize: "13px",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        },
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          // [本地改造 2026-08-21] 再点一次正在播放的按钮 = 停止（而不是重播）
          if (previewing === tag) {
            previewTagRef.current = null;
            if (previewRef.current !== null) { previewRef.current.pause(); previewRef.current = null; }
            setPreviewing(null);
            return;
          }
          onClick();
        },
      }, previewing === tag ? "⏹" : (icon ?? "🔊"));

      // 音色下拉 + 试听按钮（showPreview=false 时不显示试听，改由风格处试听）
      const voiceSelect = (engine, current, voices, onChange, showPreview) => h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
        h("select", { value: current, onChange: (e) => onChange(e.target.value), style: vInput },
          (voices ?? [current]).map((v) => h("option", { key: v, value: v }, v))),
        showPreview === false ? null : previewBtn(engine, "试听此音色", () => previewVoice(engine, current)),
      );

      // ASR 示例音频：自动加载 host 提供的测试音频（可播放），识别则把它发给 /asr/transcribe
      const loadAsrSample = () => {
        fetch("/asr/sample").then((r) => r.json()).then((d) => {
          if (!d?.ok) { setAsrResult({ ok: false, text: d?.error ?? "示例音频加载失败" }); return; }
          asrSampleBase64Ref.current = d.data;
          if (asrAudioRef.current !== null) {
            asrAudioRef.current.src = "data:" + d.mediaType + ";base64," + d.data;
          }
        }).catch((e) => setAsrResult({ ok: false, text: String(e) }));
      };
      const recognizeAsrSample = () => {
        const sample = asrSampleBase64Ref.current;
        if (sample === null || sample === undefined) { setAsrResult({ ok: false, text: "示例音频加载中，请稍候" }); return; }
        setAsrResult({ ok: true, text: "识别中…", busy: true });
        fetch("/asr/transcribe", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ audioBase64: sample }),
        }).then((r) => r.json()).then((d) => {
          setAsrResult(d?.ok ? { ok: true, text: d.text } : { ok: false, text: d?.error ?? "识别失败" });
        }).catch((e) => setAsrResult({ ok: false, text: String(e) }));
      };

      // 检测本机 ASR（exe/模型/服务/ffmpeg），自动填入可用的地址或命令
      const detectAsr = () => {
        setAsrResult(null);
        fetch("/asr/detect").then((r) => r.json()).then((d) => {
          if (!d?.ok) { setAsrResult({ ok: false, text: d?.error ?? "检测失败" }); return; }
          const det = d.detected;
          const fills = [];
          if (det.serviceOk) {
            setEngine("asr", { mode: "service", url: "http://127.0.0.1:18790" }, true);
            fills.push("检测到本地常驻服务(18790)，已自动填入地址");
          }
          if (det.cmd !== "") {
            if (!det.serviceOk) setEngine("asr", { mode: "cmd", cmd: det.cmd }, true);
            else setEngine("asr", { cmd: det.cmd }, true);
            fills.push("已填入本地命令路径");
          }
          if (!det.exe) fills.push("未找到 sherpa-onnx，可点「一键安装」");
          if (!det.ffmpegOk) fills.push("未找到 ffmpeg，安装脚本会自动安装");
          setAsrResult({ ok: true, text: fills.length > 0 ? fills.join("；") : "未检测到本地 ASR 组件，请点「一键安装」" });
        }).catch((e) => setAsrResult({ ok: false, text: String(e) }));
      };
      // 一键安装：获取安装命令并显示（不自动写剪贴板，避免 uBlock 误报 ClickFix；用户手动复制更安全）
      const installAsr = () => {
        setAsrInstalling(true);
        setAsrCmd(null);
        fetch("/asr/install-script").then((r) => r.json()).then((d) => {
          setAsrInstalling(false);
          if (!d?.ok) { setAsrResult({ ok: false, text: d?.error ?? "获取安装命令失败" }); return; }
          setAsrCmd(d.command);
          setAsrResult({
            ok: true,
            text: "请打开「以管理员身份运行」的 PowerShell，手动复制下方命令粘贴执行。\n安装位置会自动放到插件目录：" + d.installDir + "\n脚本会自动下载 sherpa-onnx + SenseVoice 模型 + ffmpeg 并注册开机自启服务（端口 18790）",
          });
        }).catch((e) => { setAsrInstalling(false); setAsrResult({ ok: false, text: String(e) }); });
      };
      // [2026-08-21] 本地 TTS 一键安装：获取安装命令并显示（与 ASR 同款交互）
      const installLocalTts = () => {
        setTtsInstalling(true);
        setTtsCmd(null);
        fetch("/tts/install-script").then((r) => r.json()).then((d) => {
          setTtsInstalling(false);
          if (!d?.ok) { setTtsCmd(null); setPreviewErr(d?.error ?? "获取安装命令失败"); return; }
          setTtsCmd(d.command);
          setPreviewErr(null);
        }).catch((e) => { setTtsInstalling(false); setPreviewErr(String(e)); });
      };

      // 提示小问号（hover 浮层显示 / 点击固定）；align="right" 时浮层右对齐（向左展开，适合靠左按钮），默认左对齐（向右展开，适合靠右按钮）
      // [本地改造 2026-08-22] 克隆音色「?」：上方弹出、向右展开，展示“默认沟通指令”与“试听文本”，让用户直观看到该克隆音默认用什么语气沟通、试听念的是哪句
      const cloneInfoTip = (sp) => {
        const active = cloneInfoId === sp.id;
        const instruct = (sp.context && sp.context.trim() !== "") ? sp.context.trim() : "（该样本未单独设置指令，使用全局默认指令）";
        return h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" } },
          h("button", {
            type: "button", "aria-label": "查看语音指令与试听文本", title: "查看语音指令与试听文本",
            style: {
              border: "none", borderRadius: "999px", width: "18px", height: "18px", padding: "0",
              background: (active && cloneInfoPinned) ? "var(--vk-accent,#4b6fff)" : "rgba(128,128,128,.15)",
              color: "inherit", cursor: "pointer", fontSize: "10px", fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            },
            onMouseDown: (e) => e.preventDefault(),
            onMouseEnter: () => setCloneInfoId(sp.id),
            onMouseLeave: () => { if (!cloneInfoPinned) setCloneInfoId(null); },
            onClick: () => { const willPin = !(cloneInfoId === sp.id && cloneInfoPinned); setCloneInfoPinned(willPin); setCloneInfoId(willPin ? sp.id : null); },
          }, "?"),
          active ? h("div", {
            style: {
              position: "absolute", bottom: "calc(100% + 6px)", left: "0", right: "auto", zIndex: 70,
              background: "var(--dsw-specific-input-major,#ffffff)",
              border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
              padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
              fontSize: "12px", lineHeight: "1.7", color: "var(--dsw-alias-label-secondary,#9aa3ad)",
              minWidth: "340px", maxWidth: "460px", textAlign: "left",
            },
          },
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: "var(--dsw-alias-label-primary,#e6e9ef)", marginBottom: "3px" } }, "默认沟通指令（" + (sp.name ?? "样本") + "）"),
            h("div", { style: { marginBottom: "8px" } }, instruct),
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: "var(--dsw-alias-label-primary,#e6e9ef)", marginBottom: "3px" } }, "试听文本"),
            h("div", { style: {} }, (sp.previewText && sp.previewText.trim() !== "") ? sp.previewText : CLONE_PREVIEW_TEXT),
          ) : null,
        );
      };

      if (config === null) {
        return h("div", { style: { padding: "16px", fontSize: "13px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "语音配置加载中…");
      }
      const eng = config.engines;
      const cloneSamples = Array.isArray(eng.voiceclone.samples) ? eng.voiceclone.samples : [];
      const showRules = rulesPinned || rulesHover;
      // [本地改造 2026-08-22] 语音设计单选模型：官方示例(asmr/docu/elder) / 自定义(custom) / 交给 AI(ai)
      const VD_KEYS = ["asmr", "docu", "elder"];
      const vdMode = (eng.voicedesign?.mode && ["asmr", "docu", "elder", "custom", "ai"].includes(eng.voicedesign.mode))
        ? eng.voicedesign.mode
        : (() => {
            const ctx = eng.voicedesign?.context ?? "";
            const i = VOICE_DESIGN_EXAMPLES.findIndex((ex) => ex.instruct === ctx);
            return i >= 0 ? VD_KEYS[i] : (ctx.trim() !== "" ? "custom" : "ai");
          })();
      // [2026-09-01] 老大：设置中心选中的必须真正传到聊天回复里——
      // 语音设计卡内任何选中/改动都联动把「默认语音引擎」切到 VoiceDesign（选中即生效：
      // 聊天自动语音回复与 send_voice 走 defaultEngine，不联动的话选了也白选）。
      // VD_TOP = 联动补丁，所有 voicedesign 卡内 setEngine 调用统一带上
      const VD_TOP = { defaultEngine: "voicedesign" };
      const pickVdMode = (m) => {
        // [2026-08-22] 单选切换：示例=写死指令+关 AI 情绪；custom=保留文本+关 AI 情绪；ai=开 AI 情绪
        if (m === "ai") setEngine("voicedesign", { mode: "ai", emotion: true }, true, VD_TOP);
        else if (VD_KEYS.includes(m)) {
          const idx = VD_KEYS.indexOf(m);
          setEngine("voicedesign", { mode: m, context: VOICE_DESIGN_EXAMPLES[idx].instruct, emotion: false }, true, VD_TOP);
        } else {
          setEngine("voicedesign", { mode: "custom", emotion: false }, true, VD_TOP);
        }
      };
      // [2026-09-01] 老大：下拉三选一（官方示例/设计音色/交给 AI），互斥，选中哪个下面才显示哪个的配置项
      // 官方示例组（asmr/docu/elder）在下拉里归为一项"官方示例"
      const vdGroup = VD_KEYS.includes(vdMode) ? "examples" : vdMode;
      const pickVdGroup = (g) => {
        if (g === "examples") {
          pickVdMode(VD_KEYS.includes(vdMode) ? vdMode : "asmr");
        } else if (g === "custom") {
          // [2026-09-01 修] 老大：设计音色要显示"咱们自己设计的"默认描述——
          // 选官方示例时 context 被写成官方指令，从官方切过来必须换掉，不能拿"非空"当保留依据；
          // 只有用户自己写的描述（不等于任何官方指令）才保留
          const ctx = (eng.voicedesign?.context ?? "").trim();
          const isOfficialInstruct = VOICE_DESIGN_EXAMPLES.some((ex) => ex.instruct === ctx);
          if (ctx === "" || isOfficialInstruct) {
            setEngine("voicedesign", { mode: "custom", context: CUSTOM_VOICE_DEFAULT, emotion: false }, true, VD_TOP);
          } else {
            pickVdMode("custom");
          }
        } else {
          pickVdMode("ai");
        }
      };
      // [2026-09-01] 老大：年龄感只留 3 档（少年/中年/老年）；旧配置的婴儿/幼儿/青年按最近档归并，旧值仍可合成
      const AI_AGE_LABELS = { teen: "少年感", middle: "中年感", old: "老年感" };
      const normalizeAiAge = (v) => {
        if (v === "teen" || v === "middle" || v === "old") return v;
        if (v === "infant" || v === "child") return "teen";
        if (v === "young") return "middle";
        const s = String(v ?? "");
        if (/老/.test(s)) return "old";
        if (/中/.test(s)) return "middle";
        return "teen";
      };
      // [2026-08-22] AI 自动模式的稳定锚点行：checkbox + 值控件。
      // optionsOrPlaceholder: null=无具体值可选(如音色质感)；数组=[v,l][] 渲染 select；字符串=自由文本输入(placeholder)
      const vdLockRow = (label, keyName, value, onValue, optionsOrPlaceholder) => h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
        h("label", { style: { display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" } },
          h("input", { type: "checkbox", checked: eng.voicedesign?.[keyName] === true, onChange: (e) => setEngine("voicedesign", { [keyName]: e.target.checked }, true, VD_TOP), style: { accentColor: "var(--vk-accent,#4b6fff)", cursor: "pointer", width: "13px", height: "13px" } }),
          label),
        Array.isArray(optionsOrPlaceholder) && eng.voicedesign?.[keyName] === true ? h("select", {
          value: value,
          onChange: (e) => onValue(e.target.value),
          // [2026-08-22] 修复: 之前 onMouseDown preventDefault 会禁掉原生下拉弹出, 导致固定性别选不了
          style: { ...vInput, width: "auto", padding: "3px 8px", fontSize: "12px" },
        }, optionsOrPlaceholder.map(([v, l]) => h("option", { key: v, value: v }, l))) : null,
        typeof optionsOrPlaceholder === "string" && eng.voicedesign?.[keyName] === true ? h("input", {
          type: "text", value: value, placeholder: optionsOrPlaceholder,
          onChange: (e) => onValue(e.target.value),
          style: { ...vInput, width: "120px", padding: "3px 8px", fontSize: "12px" },
        }) : null,
        optionsOrPlaceholder === null ? h("span", { style: { fontSize: "11px", opacity: .8 } }, "（保持同一质感）") : null,
      );
      // [本地改造 2026-08-21] 已移除 VoiceClone/VoiceDesign 勾选：分区始终显示
      const designOn = false;
      const cloneOn = false;

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "16px", width: "100%", boxSizing: "border-box" } },
        // 分区标题（语音图标已移到各服务商卡片前）+ 仓库链接（内联，不换行）
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary,#e6e9ef)" } },
          "语音服务",
          h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 400, color: "var(--dsw-alias-label-secondary,#9aa3b2)" } },
            h("a", {
              href: "https://github.com/oadank/dsh-input-tools",
              target: "_blank", rel: "noopener",
              title: "语音插件源码仓库（dsh-input-tools）",
              style: { color: "var(--dsw-alias-link,#5b9cff)", textDecoration: "none" },
            }, "语音插件仓库 ↗"),
            h("span", { style: { color: "var(--dsw-alias-label-tertiary,#6b7384)" } }, "·"),
            h("a", {
              href: "https://github.com/oadank/deepseek-harness",
              target: "_blank", rel: "noopener",
              title: "整合版：插件已内置，一键安装，推荐大多数用户",
              style: { color: "var(--dsw-alias-link,#5b9cff)", textDecoration: "none" },
            }, "整合版（推荐）↗"),
          ),
        ),
        // [2026-08-21] 试听失败错误提示；[2026-08-22] fixed 顶部弹窗 Toast + 限高滚动（错误堆栈超长不撑爆）
        previewErr !== null ? h("div", {
          style: {
            position: "fixed", top: "24px", left: "50%", transform: "translateX(-50%)", zIndex: 9999,
            background: "rgba(229,72,77,.95)", color: "#fff", borderRadius: "10px",
            padding: "10px 18px", fontSize: "13px", lineHeight: "1.5",
            boxShadow: "0 6px 24px rgba(0,0,0,.45)",
            maxWidth: "520px", maxHeight: "45vh", overflowY: "auto",
            whiteSpace: "pre-wrap", wordBreak: "break-word", pointerEvents: "none",
          },
        }, "试听失败：" + previewErr) : null,
        // [2026-08-21] 语音能力状态面板（安装即用 vs dsh 原生契约支持）
        caps !== null ? h("div", { style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px", background: "rgba(128,128,128,.05)", fontSize: "12.5px", lineHeight: "1.5" } },
          h("div", { style: { fontSize: "12px", fontWeight: 600, opacity: .8 } }, "语音能力"),
          h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h("span", { style: { color: "#3ecf8e" } }, "✅"), " 语音输入（录音+识别+发送）", h("span", { style: { marginLeft: "auto", opacity: .7 } }, "插件自带")),
          h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h("span", { style: { color: "#3ecf8e" } }, "✅"), " 聊天语音气泡（可点播放）", h("span", { style: { marginLeft: "auto", opacity: .7 } }, "插件内置")),
          h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
            caps.voiceContentContract === true
              ? h("span", { style: { color: "#3ecf8e" } }, "✅")
              : h("span", { style: { color: "#e5a53a" } }, "⚠️"),
            " dsh 原生语音消息（多模态直发）",
            h("span", { style: { marginLeft: "auto", opacity: .7 } },
              caps.voiceContentContract === true ? "当前 dsh 支持" : "当前 dsh 不支持，自动转文字发送")),
          caps.voiceContentContract === true ? null : h("div", { style: { fontSize: "12px", opacity: .75, marginTop: "2px" } },
            "说明：当前 dsh（npm 安装版）契约不支持原生语音消息，语音自动转文字发送，AI 通过【用户语音】标记识别。原生语音消息需使用「含语音改造的 dsh」——注意：官方源码/官方发布版均无此功能，语音能力是语音插件配套的 dsh 本地改造（本机 lecoo 的 dev 仓库即为改造版），正整理提交官方。"),
        ) : null,
        // ⑤ ASR 语音识别（必填项，无开关）
        h("div", { style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px", background: "rgba(128,128,128,.05)" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("span", { style: { display: "inline-flex", width: "22px", height: "22px", borderRadius: "6px", background: "rgba(128,128,128,.12)", alignItems: "center", justifyContent: "center", color: "var(--vk-accent,#4b6fff)", flex: "none" } }, micIcon),
            h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "ASR 语音识别"),
            helpTip("把语音转成文字（必填配置，选一种模式即可）。本地服务：请求常驻 HTTP 服务（默认 127.0.0.1:18790）；本地命令：直接调用 sherpa-onnx exe，无需额外装服务，速度与本地服务基本一致（8 秒音频约 1.4s，其中真正推理只占 0.16s，其余是每次加载模型的固定开销）；在线 API：走 OpenAI 兼容接口，不占用本地算力。", asrTipPinned, setAsrTipPinned, asrTipHover, setAsrTipHover, "center"),
          ),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
              vField("模式", h("select", {
                value: eng.asr.mode ?? "service",
                onChange: (e) => setEngine("asr", { mode: e.target.value }, true),
                style: vInput,
              },
                h("option", { value: "service" }, "本地常驻服务"),
                h("option", { value: "cmd" }, "本地命令"),
                h("option", { value: "api" }, "在线 API"))),
              (eng.asr.mode ?? "service") === "service" ? vField("本地服务地址", h("input", { value: eng.asr.url ?? "", onChange: (e) => setEngine("asr", { url: e.target.value }, true), placeholder: "http://127.0.0.1:18790", style: vInput })) : null,
              (eng.asr.mode ?? "service") === "cmd" ? vField("本地命令", h("input", { value: eng.asr.cmd ?? "", onChange: (e) => setEngine("asr", { cmd: e.target.value }, true), placeholder: "sherpa-onnx-offline.exe --tokens=... --sense-voice-model=... --num-threads=4", style: vInput })) : null,
              (eng.asr.mode ?? "service") === "api" ? [
                secretField("API Key", "asr", eng.asr.apiKey ?? "", (e) => setEngine("asr", { apiKey: e.target.value }, true), "sk-..."),
                vField("API 地址", h("input", { value: eng.asr.apiBaseUrl ?? "", onChange: (e) => setEngine("asr", { apiBaseUrl: e.target.value }, true), placeholder: "https://api.openai.com/v1", style: vInput })),
              ] : null,
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
              h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "none" } }, "示例音频："),
              h("audio", { ref: asrAudioRef, controls: true, preload: "none", style: { maxWidth: "320px", height: "32px", flex: "none" } }),
              h("button", {
                type: "button",
                style: {
                  border: "none", borderRadius: "999px", padding: "7px 16px", fontSize: "12.5px", fontWeight: 600,
                  background: asrResult?.busy ? "rgba(229,72,77,.85)" : "rgba(128,128,128,.15)",
                  color: "inherit", cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: recognizeAsrSample,
              }, asrResult?.busy ? "识别中…" : "识别这段音频"),
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("button", {
                type: "button",
                style: {
                  border: "1px solid var(--vk-accent,#4b6fff)", borderRadius: "999px", padding: "6px 16px",
                  fontSize: "12.5px", fontWeight: 600, background: "transparent", color: "var(--vk-accent,#4b6fff)",
                  cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: detectAsr,
              }, "检测已安装"),
              h("button", {
                type: "button",
                style: {
                  border: "none", borderRadius: "999px", padding: "6px 16px", fontSize: "12.5px", fontWeight: 600,
                  background: asrInstalling ? "rgba(128,128,128,.15)" : "var(--vk-accent,#4b6fff)",
                  color: "#fff", cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: installAsr,
              }, asrInstalling ? "准备命令…" : "复制安装命令"),
              // [2026-09-01] 老大：这行说明默认不显示，点了「复制安装命令」才出来（平时占地方没人看）
              asrCmd !== null ? h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
                "复制命令后，打开「以管理员身份运行」的 PowerShell 粘贴执行。脚本自动下载 sherpa-onnx + SenseVoice 模型 + ffmpeg 并注册开机自启服务，安装到插件目录内统一路径") : null,
            ),
            asrCmd !== null ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("div", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "安装命令（点击选中全部，Ctrl+C 复制）："),
              h("code", {
                style: {
                  display: "block", fontSize: "12px", lineHeight: "1.6", fontFamily: "Consolas, monospace",
                  color: "var(--dsw-alias-label-primary,#e6e9ef)",
                  border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
                  padding: "8px 10px", background: "rgba(128,128,128,.08)",
                  wordBreak: "break-all", whiteSpace: "pre-wrap", cursor: "text", userSelect: "all",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: (e) => {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(e.currentTarget);
                  sel.removeAllRanges();
                  sel.addRange(range);
                },
              }, asrCmd),
            ) : null,
            asrResult !== null && asrResult.text !== undefined ? h("div", {
              style: {
                fontSize: "12.5px", lineHeight: "1.6",
                color: asrResult.ok ? "var(--dsw-alias-label-primary,#e6e9ef)" : "#e5484d",
                border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", padding: "8px 10px",
                background: "rgba(128,128,128,.06)", whiteSpace: "pre-wrap",
              },
            }, asrResult.text) : null,
          ),
        ),
        // 默认引擎
        vField("默认语音引擎", h("select", {
          value: config.defaultEngine,
          onChange: (e) => {
            // [本地改造 2026-08-21] 修复：defaultEngine 之前只改本地 state 不持久化，刷新回 auto；
            // 现在与其它字段一致：防抖 POST 立即保存
            const next = { ...config, defaultEngine: e.target.value };
            // [本地改造 2026-08-22] 选「语音设计」时若还没选过模式，默认「纪录片旁白」；用户自己切过就保留原设计
            if (e.target.value === "voicedesign" && !(config.engines?.voicedesign?.mode)) {
              next.engines = { ...(config.engines ?? {}), voicedesign: { ...(config.engines?.voicedesign ?? {}), mode: "docu", context: VOICE_DESIGN_EXAMPLES[1].instruct, emotion: false } };
            }
            setConfig(next);
            if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = window.setTimeout(() => {
              fetch("/voice-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) }).catch(() => {});
            }, 400);
          },
          style: vInput,
        },
          ["auto", ...ENGINES_ORDER].map((k) => h("option", { key: k, value: k },
            k === "auto" ? "auto（按规则自动选择，未启用任何引擎时用微软 edge 免费兜底）"
              : k === "voicedesign"
                ? "小米语音设计（VoiceDesign）：默认用「纪录片旁白」指令"
                : k === "voiceclone"
                  ? "小米克隆（VoiceClone）" + (cloneSamples.length > 0 ? "：默认用「" + cloneSamples[0].name + "」" : "（未添加样本）")
                  : ENGINE_LABELS[k])))),
        // 语音三原则：问号按钮（hover 显示，点击固定/收起）
        h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center", gap: "6px" } },
          h("button", {
            type: "button", "aria-label": "语音自动回复规则", title: "语音自动回复规则",
            style: {
              border: "none", borderRadius: "999px", width: "22px", height: "22px", padding: "0",
              background: rulesPinned ? "var(--vk-accent,#4b6fff)" : "rgba(128,128,128,.15)",
              color: "inherit", cursor: "pointer", fontSize: "12px", fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            },
            onMouseDown: (e) => e.preventDefault(),
            onMouseEnter: () => setRulesHover(true),
            onMouseLeave: () => setRulesHover(false),
            onClick: () => setRulesPinned((v) => !v),
          }, "?"),
          h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "语音自动回复规则", rulesPinned ? "（已固定，点击收起）" : "（悬停查看，点击固定）"),
          showRules ? h("div", {
            style: {
              position: "absolute", top: "calc(100% + 6px)", left: "0", zIndex: 30,
              background: "var(--dsw-specific-input-major,#ffffff)",
              border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
              padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
              fontSize: "12px", lineHeight: "1.8", color: "var(--dsw-alias-label-secondary,#9aa3ad)",
              minWidth: "360px", maxWidth: "480px",
            },
          }, VOICE_RULES.map((r) => h("div", { key: r }, r))) : null,
        ),
        // [2026-08-27] 助手语音自动播放开关（默认开，不用手动开）
        h("label", {
          style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", color: "var(--dsw-alias-label-primary,#e6e9ef)", cursor: "pointer" },
        },
          h("input", {
            type: "checkbox",
            checked: config.autoPlayAssistantVoice !== false,
            onChange: (e) => {
              const v = e.target.checked;
              setAutoPlayAssistantVoice(v);
              const next = { ...config, autoPlayAssistantVoice: v };
              setConfig(next);
              if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
              saveTimerRef.current = window.setTimeout(() => {
                fetch("/voice-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) }).catch(() => {});
              }, 400);
            },
            style: { accentColor: "var(--vk-accent,#4b6fff)", cursor: "pointer", width: "14px", height: "14px" },
          }),
          h("span", {}, "助手语音自动播放（AI 发来语音自动播放，默认开）"),
        ),
        // ① edge
        vCard(ENGINE_LABELS.edge, openCards.edge, () => toggleCard("edge"),
          vField("音色", voiceSelect("edge", eng.edge.voice, meta?.edgeVoices, (v) => setEngine("edge", { voice: v }, true))), "#4b9fff"),
        // ② 小米 MiMo（三模型合一卡片）
        vCard(h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          ENGINE_LABELS.xiaomi,
          helpTip("想让 AI 唱歌？直接对 AI 说“唱首歌/用歌声回我”，回复时自动加 (唱歌) 标签。", xmTipPinned, setXmTipPinned, xmTipHover, setXmTipHover),
          h("span", { style: { fontSize: "12px", fontWeight: 400, color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
            "（限时免费，请以官方为准）",
            h("a", {
              href: MIMO_DOC_URL, target: "_blank", rel: "noreferrer",
              style: { color: "var(--vk-accent,#4b6fff)", textDecoration: "none" },
            }, "MiMo 官方模型页"),
          ),
        ), openCards.xiaomi, () => toggleCard("xiaomi"),
          () => h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
            // [本地改造 2026-08-21] API Key（卡片最上；不再有模型勾选）
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
              secretField("API Key", "xiaomi", eng.xiaomi.apiKey, (e) => setEngine("xiaomi", { apiKey: e.target.value }, true),
                (eng.xiaomi.apiKey !== "" || meta?.envKeys?.xiaomi) ? "已填写——输入新值可替换" : "MIMO_API_KEY"),
            ),
            // 语音模型：MiMo-V2.5-TTS（基础 TTS，音色 + 语言风格）
            h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "语音模型：MiMo-V2.5-TTS"),
              ),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
                vField("音色", voiceSelect("xiaomi", eng.xiaomi.voice, meta?.xiaomiVoices, (v) => setEngine("xiaomi", { voice: v }, true), false)),
                vField("默认语言风格", h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
                  h("select", {
                    value: STYLE_PRESETS.find((sp) => sp.ctx === (eng.xiaomi.context ?? ""))?.key ?? "",
                    onChange: (e) => {
                      const hit = STYLE_PRESETS.find((sp) => sp.key === e.target.value);
                      setEngine("xiaomi", { context: hit ? hit.ctx : "" }, true);
                    },
                    style: { ...vInput, flex: 1 },
                  },
                    STYLE_PRESETS.map((sp) => h("option", { key: sp.key || "nat", value: sp.key }, sp.label))),
                  previewBtn("style", "试听", () => previewVoice("xiaomi", eng.xiaomi.voice, eng.xiaomi.context ?? "", undefined, "style")),
                )),
              ),
            ),
            // [2026-08-22] 语音设计：MiMo-V2.5-TTS-VoiceDesign（单选：官方示例 / 自定义 / 交给 AI，始终显示）
            h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", borderLeft: "2px solid #38bdf8", paddingTop: "8px", paddingLeft: "8px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "语音设计：MiMo-V2.5-TTS-VoiceDesign"),
                helpTip("「音色设计 VoiceDesign」用一段文字描述你想要的声音（性别/年龄/质感/语速/情绪），AI 照着念。单选：选官方示例（ASMR / 纪录片旁白 / 年迈老先生），或自定义填写，或「交给 AI 自动发挥」（AI 按对话情境写音色描述，可勾选固定性别/音色/年龄保持声音稳定——尚未充分测试）。选为默认语音引擎后默认用「纪录片旁白」；切换过就保留你的选择。", designTipPinned, setDesignTipPinned, designTipHover, setDesignTipHover, "center", "top"),
              ),
              // [2026-09-01] 老大：一个下拉三选一（互斥），选中哪个下面才显示哪个的配置项
              h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                h("select", {
                  value: vdGroup,
                  onChange: (e) => pickVdGroup(e.target.value),
                  style: { ...vInput, width: "220px", flex: "none" },
                },
                  h("option", { value: "examples" }, "官方示例"),
                  h("option", { value: "custom" }, "设计音色"),
                  h("option", { value: "ai" }, "交给 AI 自动发挥"),
                ),
                h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
                  vdGroup === "examples" ? "选中即默认音色指令" : vdGroup === "custom" ? "自己写一段音色描述" : "AI 每次随机写描述"),
              ),
              vdGroup === "examples" ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                VOICE_DESIGN_EXAMPLES.map((ex, i) => {
                  const key = VD_KEYS[i];
                  const active = vdMode === key;
                  return h("div", {
                    key: ex.title,
                    style: {
                      display: "flex", alignItems: "center", gap: "8px", padding: "5px 8px", borderRadius: "6px", cursor: "pointer",
                      border: "1px solid " + (active ? "var(--vk-accent,#4b6fff)" : "transparent"),
                      background: active ? "rgba(75,111,255,.14)" : "rgba(128,128,128,.05)",
                    },
                    onClick: () => pickVdMode(key),
                  },
                    // [2026-09-01] 老大：官方示例前面要有单选框（选中=用这个音色指令）
                    h("input", { type: "radio", name: "vd-mode", checked: active, onChange: () => pickVdMode(key), style: { accentColor: "var(--vk-accent,#4b6fff)", cursor: "pointer", flex: "none", width: "14px", height: "14px", margin: "0" } }),
                    h("span", { style: { fontSize: "12.5px", fontWeight: active ? 600 : 400, color: "var(--dsw-alias-label-primary,#e6e9ef)", flex: "none" } }, ex.title),
                    h("span", { style: { flex: 1 } }),
                    helpTip(
                      h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
                        h("div", null, h("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "Instruct："), ex.instruct),
                        h("div", null, h("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "Text："), ex.text),
                      ),
                      vdExamplePins[i], (v) => { const n = [...vdExamplePins]; n[i] = v; setVdExamplePins(n); },
                      vdExampleHovers[i], (v) => { const n = [...vdExampleHovers]; n[i] = v; setVdExampleHovers(n); },
                      "right", "top",
                    ),
                    // [2026-09-01] 老大：直接播预生成固定文件，不实时合成不花额度
                    a8Btn("vd-ex:" + key, "🔊 试听", () => playVdSample(i)),
                  );
                }),
              ) : vdGroup === "custom" ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                h("textarea", {
                  value: eng.voicedesign?.context ?? "",
                  onChange: (e) => setEngine("voicedesign", { context: e.target.value }, true, VD_TOP),
                  placeholder: CUSTOM_VOICE_DEFAULT,
                  style: { ...vInput, minHeight: "64px", resize: "vertical", lineHeight: "1.6" },
                }),
                h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                  a8Btn("vd-custom", "🔊 试听", () => previewVoice("voicedesign", undefined, eng.voicedesign?.context ?? "", undefined, "vd-custom", { text: "这是一段使用你设计的音色朗读的语音，用来检查当前音色描述的效果。" })),
                  h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "写好后点试听；切到其它选项会保留这段文本"),
                ),
              ) : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                  vdLockRow("固定性别", "lockGender", eng.voicedesign?.aiGender ?? "female", (v) => setEngine("voicedesign", { aiGender: v }, true, VD_TOP), [["female", "女"], ["male", "男"]]),
                  vdLockRow("固定年龄感", "lockAge", normalizeAiAge(eng.voicedesign?.aiAge), (v) => setEngine("voicedesign", { aiAge: v }, true, VD_TOP),
                    [["teen", "少年感"], ["middle", "中年感"], ["old", "老年感"]]),
                ),
                h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                  a8Btn("vd-ai", "🔊 试听（AI 随机写描述）", () => previewVoice("voicedesign", undefined, "", undefined, "vd-ai", { text: "哈哈，今天可算把你等来了！我跟你说个事儿——我刚才差点把杯子摔了，哎呀吓死我啦！" })),
                  h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "每次随机一条描述，声音严格按锁定的性别与年龄生成"),
                ),
              ),
            ),
            // 克隆模型：MiMo-V2.5-TTS-VoiceClone（样本管理，始终显示）
            h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", borderLeft: "2px solid #f472b6", paddingTop: "8px", paddingLeft: "8px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "克隆模型：MiMo-V2.5-TTS-VoiceClone"),
                helpTip("克隆音色与预置音色（冰糖等）互斥：在「默认语音引擎」里选择「小米克隆（VoiceClone）」后，默认回复一律使用下方克隆声音；开启 VoiceDesign 时，AI 会在克隆底嗓上叠加情感指令（如「用委屈撒娇的语气」），克隆声同样带情感。", cloneListTipPinned, setCloneListTipPinned, cloneListTipHover, setCloneListTipHover, "center", "top"),
              ),
              // [2026-09-01] 老大：跟 audio8 卡统一成一行式 —— 克隆列表 [下拉] 🔊原音 🔊克隆声（那坨路径文本是垃圾）
              cloneSamples.length > 0 ? (() => {
                const curId = cloneSamples.some((s) => s.id === (eng.voiceclone?.sampleId ?? "")) ? eng.voiceclone.sampleId : cloneSamples[0].id;
                const cur = cloneSamples.find((s) => s.id === curId);
                return h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                  h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "none" } }, "克隆列表："),
                  h("select", {
                    value: curId, title: "选中即默认音色（默认语音引擎选「小米克隆」后用它）",
                    onChange: (e) => setEngine("voiceclone", { sampleId: e.target.value }, true),
                    style: { ...vInput, width: "200px", flex: "none" },
                  }, cloneSamples.map((sp) => h("option", { key: sp.id, value: sp.id }, sp.name ?? "样本"))),
                  a8Btn("clone-src:" + curId, "🔊 原音", () => previewSourceVoice(cur.path, "clone-src:" + curId)),
                  a8Btn("clone-baked:" + curId, "🔊 克隆声", () => playBakedPreview(cur, "clone-baked:" + curId)),
                  curId === BUNDLED_CLONE_ID ? null : h("button", {
                    type: "button", "aria-label": "删除", title: "删除此克隆音色",
                    style: { border: "none", borderRadius: "6px", width: "26px", height: "26px", flex: "none", background: "rgba(229,72,77,.15)", color: "#e5484d", cursor: "pointer", fontSize: "13px" },
                    onMouseDown: (e) => e.preventDefault(),
                    onClick: () => setEngine("voiceclone", { samples: cloneSamples.filter((x) => x.id !== curId) }, true),
                  }, "✕"),
                );
              })() : h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", lineHeight: 1.7 } },
                "克隆列表：暂无（用下方按钮上传一段参考语音）",
              ),
              // [2026-09-01] 老大：添加表单只留一个上传按钮 —— 试听文本内置固定、名字用文件名、沟通指令用小团团的默认
              h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
                h("button", {
                  type: "button", onClick: () => cloneFileRef.current?.click(), disabled: addingClone,
                  style: { background: "var(--vk-accent,#4b6fff)", color: "#fff", border: "none", borderRadius: "999px", padding: "7px 16px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer", flex: "none" },
                }, addingClone ? "上传中…" : "📤 上传克隆音色"),
                h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "mp3/wav ≤10MB，建议 15-60 秒单人纯人声；名字取文件名，语气指令内置"),
                h("input", { ref: cloneFileRef, type: "file", accept: ".mp3,.wav,audio/mpeg,audio/wav", style: { display: "none" }, onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f !== undefined && f !== null) void addCloneSample(f); } }),
                cloneAddMsg !== null ? h("div", { style: { fontSize: "12px", color: cloneAddMsg.ok ? "#73c991" : "#f14c4c", flexBasis: "100%" } }, cloneAddMsg.text) : null,
              ),
            ),
          ), "#ff8c1a"),
        // [2026-09-01] ③' Audio8 本地克隆 TTS（零样本克隆，音色先在本机注册：register_voice.py）
        vCard(h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          ENGINE_LABELS.audio8,
          helpTip("Audio8 TTS：本机 CPU 零样本声音克隆（0.6B INT4）。先在服务器上用 register_voice.py 注册音色（录音 ≤30 秒 + 逐字文本），这里下拉选音色即可。不选则自动用最新注册的音色。CPU 推理较慢（一句约 15-30 秒）。", false, () => {}, false, () => {}, "center"),
        ), openCards.audio8, () => toggleCard("audio8"),
          [
            // [2026-09-01] 常驻服务（模型常驻内存）；命令行只作兜底，不再暴露到 UI（老大：冗余）
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
              vField("常驻服务地址", h("input", { value: eng.audio8?.url ?? "http://127.0.0.1:18795", onChange: (e) => setEngine("audio8", { url: e.target.value }, true), placeholder: "http://127.0.0.1:18795", style: vInput })),
            ),
            // 一行：克隆列表 [下拉，选中即默认] 🔊 原音 🔊 克隆声（实时合成） 合成耗时
            (() => {
              const voices = (meta?.audio8Voices ?? []).map((v) => (typeof v === "string" ? { name: v, display: v } : v));
              if (voices.length === 0) {
                return h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "克隆列表：暂无已注册音色（去飞书配置中心上传一段参考语音）");
              }
              const cur = eng.audio8?.voice ?? "";
              const sel = voices.some((v) => v.name === cur) ? cur : voices[voices.length - 1].name;
              return h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", flex: "none" } }, "克隆列表："),
                h("select", {
                  value: sel, title: "选中即默认音色",
                  onChange: (e) => setEngine("audio8", { voice: e.target.value }, true),
                  style: { ...vInput, width: "160px", flex: "none" },
                }, voices.map((v) => h("option", { key: v.name, value: v.name }, v.display || v.name))),
                a8Btn("a8-src:" + sel, "🔊 原音", () => playAudio8Source(sel, "a8-src:" + sel)),
                a8Btn("a8-clone:" + sel, "🔊 克隆声（实时合成）", () => {
                  startA8Ticker();
                  previewVoice("audio8", sel, undefined, undefined, "a8-clone:" + sel, { url: eng.audio8?.url ?? "", cmd: eng.audio8?.cmd ?? "" }, stopA8Ticker, stopA8Ticker);
                }, stopA8Ticker),
                a8Dur !== null ? h("span", { style: { fontSize: "12px", flex: "none", color: "var(--dsw-alias-label-secondary,#9aa3ad)" }, title: "合成耗时（点到出声）" }, fmtA8Dur(a8Dur)) : null,
              );
            })(),
            // [2026-09-01] 老大：本地克隆缺上传按钮 —— 选音频 → 自动 ASR 逐字文本 → 注册，名字用文件名
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("button", {
                type: "button", onClick: () => a8FileRef.current?.click(), disabled: a8Adding,
                style: { background: "var(--vk-accent,#4b6fff)", color: "#fff", border: "none", borderRadius: "999px", padding: "7px 16px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer", flex: "none" },
              }, a8Adding ? "注册中…（ASR 转写 + 提特征，约十几秒）" : "📤 上传克隆音色"),
              h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "音频 ≤20MB（建议 ≤30 秒单人纯人声）；逐字文本自动 ASR，名字取文件名"),
              h("input", { ref: a8FileRef, type: "file", accept: "audio/*", style: { display: "none" }, onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f !== undefined && f !== null) void addAudio8Voice(f); } }),
              a8AddMsg !== null ? h("div", { style: { fontSize: "12px", color: a8AddMsg.ok ? "#73c991" : "#f14c4c", flexBasis: "100%" } }, a8AddMsg.text) : null,
            ),
          ], "#a855f7"),
        // ③ 本地 TTS（与其他卡片一致：勾选后才显示配置字段）
        vCard(h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          ENGINE_LABELS.local,
          helpTip("本地模型常驻内存（CPU 推理）。填本地命令（每次调用启动进程，较慢）；或填 HTTP 服务地址（推荐，模型常驻一次加载后快）。两者都填时 HTTP 优先；留空则跳过本地引擎。点「复制安装命令」可一键下载 sherpa-onnx + 中文 MeloTTS 模型 + ffmpeg，并自动生成可用的启动脚本。", localTipPinned, setLocalTipPinned, localTipHover, setLocalTipHover, "center"),
        ), openCards.local, () => toggleCard("local"),
          [
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
              vField("本地命令（每次调用启动进程）", h("input", { value: eng.local.cmd ?? "", onChange: (e) => setEngine("local", { cmd: e.target.value }, true), placeholder: "如 node <插件目录>\\local-tts.mjs（安装脚本会自动填好）", style: vInput })),
              vField("HTTP 服务地址（常驻模式）", h("input", { value: eng.local.url ?? "", onChange: (e) => setEngine("local", { url: e.target.value }, true), placeholder: "如 http://127.0.0.1:5000/tts（POST {text} 返回音频）", style: vInput })),
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
              previewBtn("local-preview", "试听本地 TTS", () => previewVoice("local", undefined, undefined, undefined, "local-preview", { cmd: eng.local.cmd ?? "", url: eng.local.url ?? "" })),
              h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "点击试听（用上方填的命令/地址合成）"),
            ),
            // [2026-08-21] 本地 TTS 一键安装（与 ASR 同款交互）
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", borderTop: "1px dashed var(--dsw-alias-border-l1,#333a45)", paddingTop: "8px" } },
              h("button", {
                type: "button",
                style: {
                  border: "none", borderRadius: "999px", padding: "6px 16px", fontSize: "12.5px", fontWeight: 600,
                  background: ttsInstalling ? "rgba(128,128,128,.15)" : "var(--vk-accent,#4b6fff)",
                  color: "#fff", cursor: "pointer",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: installLocalTts,
              }, ttsInstalling ? "准备命令…" : "复制安装命令"),
              h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } },
                "复制命令后，打开「以管理员身份运行」的 PowerShell 粘贴执行。脚本自动下载 sherpa-onnx（含离线 TTS）+ 中文 MeloTTS 模型 + ffmpeg，并生成 local-tts.mjs 启动脚本"),
            ),
            ttsCmd !== null ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("div", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "安装命令（点击选中全部，Ctrl+C 复制）："),
              h("code", {
                style: {
                  display: "block", fontSize: "12px", lineHeight: "1.6", fontFamily: "Consolas, monospace",
                  color: "var(--dsw-alias-label-primary,#e6e9ef)",
                  border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px",
                  padding: "8px 10px", background: "rgba(128,128,128,.08)",
                  wordBreak: "break-all", whiteSpace: "pre-wrap", cursor: "text", userSelect: "all",
                },
                onMouseDown: (e) => e.preventDefault(),
                onClick: (e) => {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(e.currentTarget);
                  sel.removeAllRanges();
                  sel.addRange(range);
                },
              }, ttsCmd),
            ) : null,
          ], "#22c55e"),
        // ④ 阿里 qwen3-tts
        vCard(ENGINE_LABELS.ali, openCards.ali, () => toggleCard("ali"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
            secretField("API Key", "ali", eng.ali.apiKey ?? "", (e) => setEngine("ali", { apiKey: e.target.value }, true),
              (eng.ali.apiKey !== "" || meta?.envKeys?.ali) ? "已填写——输入新值可替换" : "dashscope API Key"),
            vField("音色", voiceSelect("ali", eng.ali.voice ?? "Cherry", meta?.aliVoices, (v) => setEngine("ali", { voice: v }, true))),
          ), "#ec4899"),

      );
    }

    // ── [本地改造 2026-08-21] 语音条尾部「复制转写」按钮 ─────────────
    // 挂在 conversation.chat.voice-actions 槽（核心补的挂点）：按钮渲染在语音条
    // （VoiceCard）内部、转写文本之后，样式对齐系统复制按钮（28px 圆形透明、
    // hover 变背景；图标 14px）。
    const actionCopySvg = h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
      h("rect", { x: "5.5", y: "5.5", width: "7", height: "7", rx: "1.2", fill: "none", stroke: "currentColor", strokeWidth: "1.3" }),
      h("path", { d: "M10.5 5.5V4.5A1 1 0 0 0 9.5 3.5H5A1 1 0 0 0 4 4.5v4.5a1 1 0 0 0 1 1h1", fill: "none", stroke: "currentColor", strokeWidth: "1.3" }),
    );
    const actionCheckSvg = h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
      h("path", { d: "M3.5 8.5L6.5 11.5L12.5 4.5", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }),
    );
    function VoiceCopyTranscriptAction(props) {
      const transcript = props.transcript;
      const [copied, setCopied] = react.useState(false);
      if (typeof transcript !== "string" || transcript === "") return null;
      const onCopy = () => {
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(transcript).then(done, done);
        } else { done(); }
      };
      const label = copied ? "已复制转写文本" : "复制转写文本";
      const style = {
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: "28px", height: "28px", padding: "6px", border: "none",
        borderRadius: "28px", background: "transparent",
        color: "var(--dsw-alias-label-tertiary)", cursor: "pointer",
        flexShrink: 0,
      };
      return h("button", {
        type: "button",
        onClick: onCopy,
        title: label,
        "aria-label": label,
        style,
        onMouseEnter: (e) => {
          e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)";
          e.currentTarget.style.color = "var(--dsw-alias-label-secondary)";
        },
        onMouseLeave: (e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--dsw-alias-label-tertiary)";
        },
      }, copied ? actionCheckSvg : actionCopySvg);
    }

    const inject = ["slots"];

    function apply(ctx) {
      const getConnection = () => ctx.get("connection");
      const getModels = () => ctx.get("modelDirectories");
      // [0.1.5 三次修·监督员真实 DOM]
      // 结构：card[data-composer-card] > row > tools > [ modes(完全权限), 插件插槽(data-slot>图片/录音) ]
      // 类名 CSS Modules 哈希（前缀会变，当前 IkQe8W_）→ 禁止匹配字面哈希。
      // 插槽外层有 display:contents 的 data-slot 包装（slots 渲染器统一锚点），
      // contains(图片按钮) 命中的是该包装节点，insertBefore 挪包装即可。
      // 算法（监督员指定，照抄）：
      //   tools = 图片按钮.closest('[class*="tools"]');
      //   slot  = tools.children 中 contains(图片按钮) 的那个;
      //   modes = tools.querySelector('[class*="modes"]');
      //   若 modes 存在且 slot 不在 modes 前 → tools.insertBefore(slot, modes)。
      // MutationObserver 监听 card 子树；React 重渲染会把 slot 挪回 modes 后，重挂再插。
      // 会话内 / 新会话(hero) 同构 InputBar（都有 data-composer-card），querySelectorAll 全处理。
      ctx.effect(() => {
        if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
        const placeOne = (img) => {
          const tools = img.closest('[class*="tools"]');
          if (!tools) return;
          let slot = null;
          for (const child of tools.children) {
            if (child !== img && child.contains(img)) { slot = child; break; }
          }
          if (!slot) return;
          // insertBefore 要求 modes 是 tools 的直接子节点；先取直接子，再回退 querySelector。
          let modes = null;
          for (const child of tools.children) {
            if (child.matches && child.matches('[class*="modes"]')) { modes = child; break; }
          }
          if (!modes) modes = tools.querySelector('[class*="modes"]');
          if (!modes || modes.parentElement !== tools) return;
          const mi = Array.prototype.indexOf.call(tools.children, modes);
          const ni = Array.prototype.indexOf.call(tools.children, slot);
          if (mi >= 0 && ni >= 0 && ni > mi) {
            tools.insertBefore(slot, modes);
          }
        };
        const place = () => {
          try {
            // 会话内 + 新会话可能同时挂多份 composer，全量处理
            document.querySelectorAll('[aria-label="添加图片"]').forEach(placeOne);
          } catch { /* 节点竞态：卸载中引用已失效 */ }
        };
        place();
        let scheduled = false;
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => { scheduled = false; place(); });
        };
        const mo = new MutationObserver(schedule);
        // 稳定锚点优先 data-composer-card；class*card 作兜底
        const cardOf = (node) => {
          if (!(node instanceof Element)) return null;
          return node.closest?.('[data-composer-card]')
            ?? node.closest?.('[class*="card"]')
            ?? (node.matches?.('[data-composer-card], [class*="card"]') ? node : null);
        };
        const attach = (node) => {
          const card = cardOf(node);
          if (card) mo.observe(card, { childList: true, subtree: true });
        };
        document.querySelectorAll('[data-composer-card], [class*="card"]').forEach((el) => mo.observe(el, { childList: true, subtree: true }));
        // 新 card 挂上时补 observe（body 级只为捕获 card 出现，非永久全页抖动放大器）
        const bodyMo = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) attach(n);
          }
          schedule();
        });
        bodyMo.observe(document.body, { childList: true, subtree: true });
        return () => { mo.disconnect(); bodyMo.disconnect(); };
      }, "dsh-input-tools: left-before-modes");
      ctx.effect(() => {
        const disposers = [
          // 附件槽：priority:-1 覆盖官方（lowest renders；官方默认 0 不冲突）
          ctx.slots.inject("conversation.input.attachments", () => ctx.slots.register({
            name: "conversation.input.attachments",
            id: "composer-attachments-overlay",
            priority: -1,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId }),
          }, ComposerAttachmentsOverlay)),
          ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
            name: "conversation.input.left",
            id: "composer-left",
            order: 10,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId }),
          }, ToolbarLeft)),
          ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
            name: "conversation.input.right",
            id: "composer-balance",
            order: -10,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId, getModelStore: () => {
              try { const models = getModels(); if (!models) return undefined; return models.directoryFor(sessionId).store; }
              catch { return undefined; }
            } }),
          }, BalanceMeter)),
          // 设置页「语音服务」分区（settings.section 槽）
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "voice",
            order: 4,
            label: () => "语音服务",
          }, VoiceSettingsSection)),
          // [2026-08-22] 设置页「图片识别」独立分区（从语音服务拆出）
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "vision",
            order: 5,
            label: () => "图片识别",
          }, VisionSettingsSection)),
          // [2026-09-11] 设置页「全局人设 / MCP / Skill」管理分区（host-files 端点）
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "persona",
            order: 6,
            label: () => "全局人设",
          }, PersonaSection)),
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "mcp",
            order: 7,
            label: () => "MCP 服务器",
          }, McpSection)),
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "skills",
            order: 8,
            label: () => "Skill 管理",
          }, SkillsSection)),
          // [本地改造 2026-08-21] 语音条尾部「复制转写」按钮（voice-actions 槽，
          // 渲染在语音卡内转写文本之后；样式对齐系统复制按钮）
          ctx.slots.inject("conversation.chat.voice-actions", () => ctx.slots.register({
            name: "conversation.chat.voice-actions",
            id: "voice-copy-transcript",
            order: 0,
          }, VoiceCopyTranscriptAction)),
        ];
        return () => { for (const d of disposers) d(); };
      }, "dsh-input-tools: toolbar");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});