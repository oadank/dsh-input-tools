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
    // [2026-09-25 老大定稿 /de 副驾] ⚡ 组件挂载时把"往输入框写一段话"的能力挂到这里：
    // 命令注册活在 apply 作用域，摸不到组件里的 setEditorText，只能这样递出来。
    let sharedComposerFill = null;
    // 命令的 onSelect 活在 apply 作用域，够不到组件里那份 copyClipboard；写框失败时的兜底只用到剪贴板，不代按发送。
    const copyClipboardSafe = async (text) => {
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    };

    // ── [2026-09-22 老大实测·切走再切回横幅丢失] ⚡ 优化状态按会话存 ──────────
    // 横幅/状态原来是 ToolbarLeft 组件内的 useState：切会话时该组件被卸载重建，
    // 后台还在跑但横幅没了（老大实测）。这里改成模块级、按 sessionId 存：
    //   { phase, toast, draft }  draft = 跑完时用户不在本会话、暂存待回填的稿子。
    // 会话切换不刷新页面，所以放内存就够。
    const optSessions = new Map();
    const optSessionSubs = new Set();
    // [2026-09-22 老大要求·关掉浏览器/刷新也得保住] 只把"待回填的稿子"落 localStorage：
    // 内存 Map 扛得住会话切换，扛不住刷新/关页；稿子是用户说过的话，不能丢。
    // 存整体 { [sessionId]: { draft, ts } }，超过 6 小时的旧稿不再恢复（避免陈旧内容以后突然冒出来）。
    const OPT_DRAFT_LS_KEY = "dsh-opt-draft-v1";
    const OPT_DRAFT_TTL_MS = 6 * 60 * 60 * 1000;
    const optDraftAll = () => {
      try { const raw = window.localStorage.getItem(OPT_DRAFT_LS_KEY); const o = raw ? JSON.parse(raw) : null; return o && typeof o === "object" ? o : {}; }
      catch { return {}; }
    };
    const optDraftSave = (sid, draft, meta) => {
      if (sid === undefined || sid === null) return;
      try {
        const all = optDraftAll();
        // [2026-09-22] 统计条（字数/耗时/检索）跟稿子一起存：回填时横幅要一起恢复，
        // 否则横幅只剩一句提示，看着像"没字"（老大实测）。
        all[String(sid)] = meta === undefined || meta === null
          ? { draft: draft, ts: Date.now() }
          : { draft: draft, ts: Date.now(), meta: meta };
        window.localStorage.setItem(OPT_DRAFT_LS_KEY, JSON.stringify(all));
      } catch { /* 无存储权限：退回只存内存 */ }
    };
    const optDraftRemove = (sid) => {
      if (sid === undefined || sid === null) return;
      try {
        const all = optDraftAll();
        if (all[String(sid)] !== undefined) {
          delete all[String(sid)];
          window.localStorage.setItem(OPT_DRAFT_LS_KEY, JSON.stringify(all));
        }
      } catch { /* 同上 */ }
    };
    const optDraftRestore = () => {
      const all = optDraftAll();
      const now = Date.now();
      for (const key of Object.keys(all)) {
        const rec = all[key];
        if (!rec || typeof rec.draft !== "string" || rec.draft === "") continue;
        if (typeof rec.ts === "number" && now - rec.ts > OPT_DRAFT_TTL_MS) { optDraftRemove(key); continue; }
        const restored = { draft: rec.draft };
        if (typeof rec.meta === "string" && rec.meta !== "") restored.meta = rec.meta;
        optSessions.set(key, Object.assign({}, optSessions.get(key) || {}, restored));
      }
    };
    // 每次把稿子挂进按会话记录时，都登记一次；ToolbarLeft 订阅到这个登记就立刻尝试回填，
    // 不依赖"组件重新挂载"（原来不切会话时组件一直没卸载，草稿就永远没人填 = 老大实测的丢稿）。
    const optRefillWaiters = new Map();
    const optRefillNotify = (sid) => {
      const fn = optRefillWaiters.get(String(sid));
      if (fn !== undefined) { optRefillWaiters.delete(String(sid)); fn(); }
    };
    const optSessionGet = (sid) => (sid === undefined || sid === null ? null : optSessions.get(String(sid)) || null);
    const optSessionPatch = (sid, patch) => {
      if (sid === undefined || sid === null) return;
      const key = String(sid);
      const next = Object.assign({}, optSessions.get(key) || {}, patch);
      optSessions.set(key, next);
      // 稿子字段与持久化同步：有稿子写入 localStorage，明确清空(draft:"")则删除。
      if ("draft" in patch) {
        if (typeof patch.draft === "string" && patch.draft !== "") optDraftSave(key, patch.draft, patch.meta);
        else if (patch.draft === "" || patch.draft === null || patch.draft === undefined) optDraftRemove(key);
      }
      if (typeof patch.draft === "string" && patch.draft !== "") optRefillNotify(key);
      for (const fn of Array.from(optSessionSubs)) { try { fn(); } catch { /* 订阅者异常不影响状态 */ } }
    };
    const optSessionClear = (sid) => {
      if (sid === undefined || sid === null) return;
      optSessions.delete(String(sid));
      for (const fn of Array.from(optSessionSubs)) { try { fn(); } catch { /* 同上 */ } }
    };
    const optSessionSubscribe = (fn) => { optSessionSubs.add(fn); return () => { optSessionSubs.delete(fn); }; };
    // [2026-09-22 老大实测·优化中状态卡死] 只有"本页面正在跑的"任务才允许恢复成 busy。
    // 刷新页面后 live 标记随内存一起消失 → 旧会话不会再显示"优化中…"（那个任务已经没了）。
    const optLive = new Set();
    const optSessionLive = (sid) => (sid === undefined || sid === null ? false : optLive.has(String(sid)));
    // [2026-09-22 老大实测·稿子被写进别的会话] 只认"发起时那个输入框元素"：
    // 记录目标编辑器 → 写之前确认它仍在页面上（isConnected）。切走会话时该元素被卸载，
    // 检查失败 → 绝不落字，改为挂草稿；切回来重新挂载 → 自动回填。这条不依赖会话 id 判断。
    let optEditorSeq = 0;
    const markOptEditor = (el) => {
      if (!el) return null;
      optEditorSeq += 1;
      const key = "opt-target-" + Date.now() + "-" + optEditorSeq;
      try { el.setAttribute("data-dsh-opt-target", key); } catch { return null; }
      return key;
    };
    const optEditorAlive = (key) => {
      if (!key) return null;
      try {
        const el = document.querySelector('[data-dsh-opt-target="' + key + '"]');
        return el && el.isConnected ? el : null;
      } catch { return null; }
    };
    // [2026-09-22] 版本标记：控制台 `[dsh-input-tools] engine <版本>` 用来确认浏览器跑的是哪份代码。
    const OPT_ENGINE = "2026-09-23-bannerfix";

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
    // [2026-09-22 老大要求·录音与播放必须互斥] 录音期间禁止任何语音播放（官方语音卡 / 插件语音条 /
    // 自动播放）。原来只在录音入口停插件自己的语音条、官方卡照响，且录音期间自动播放没被禁。
    let voiceRecordingActive = false;
    // ── [2026-09-22 老大要求·录音期间屏幕不许锁] ───────────────────────────────
    // 标准做法是 Screen Wake Lock API（navigator.wakeLock.request("screen")），但它**只在安全上下文**
    // 存在：HTTPS 或 localhost。老大手机走的是 http://<tailscale-ip>:3080（非安全上下文），
    // navigator.wakeLock 是 undefined → 必须再加一层兜底：往页面塞一个 1px、1 秒、无声的循环视频，
    // 只要页面在解码视频，iOS/Android 就不会按系统超时自动锁屏（业界老办法）。
    // 两条路都失败时上报 wake-lock 失败事件，屏幕照旧按系统设置熄屏（不静默装成功）。
    const WAKE_LOCK_FALLBACK_VIDEO = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAGWdkAAqs2V+IiMBEAAADAAQAAAMACDxIllgBAARo74/L/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALGAAAAAQAAABRzdGNvAAAAAAAAAAEAAANFAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAAIZnJlZQAAAs5tZGF0AAACrAYF//+o3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMyAwNDgwY2IwIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTEgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9MiBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MSBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTEwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABJliIQAFf/q/8JVP72zdFxF//E=";
    let wakeLockSentinel = null;
    let wakeLockFallbackEl = null;
    let wakeLockVisibilityHooked = false;
    async function acquireWakeLock() {
      if (!wakeLockVisibilityHooked && typeof document !== "undefined") {
        wakeLockVisibilityHooked = true;
        // 切后台会被系统自动释放 wake lock，回前台且还在录音就重新要
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible" && voiceRecordingActive) void acquireWakeLock();
        });
      }
      try {
        if (typeof navigator !== "undefined" && navigator.wakeLock && typeof navigator.wakeLock.request === "function") {
          if (wakeLockSentinel === null) {
            wakeLockSentinel = await navigator.wakeLock.request("screen");
            wakeLockSentinel.addEventListener("release", () => { wakeLockSentinel = null; });
            reportVoiceStage("wake-lock", null, { via: "api" });
          }
          return;
        }
      } catch (e) {
        reportVoiceStage("wake-lock-api-fail", e, { protocol: typeof location !== "undefined" ? location.protocol : "" });
      }
      try {
        if (wakeLockFallbackEl !== null || typeof document === "undefined") return;
        const v = document.createElement("video");
        v.setAttribute("playsinline", "");
        v.setAttribute("webkit-playsinline", "");
        v.muted = true;
        v.loop = true;
        v.preload = "auto";
        v.src = WAKE_LOCK_FALLBACK_VIDEO;
        v.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;";
        document.body.appendChild(v);
        wakeLockFallbackEl = v;
        try { await v.play(); } catch (pe) { reportVoiceStage("wake-lock-video-play-fail", pe, {}); }
        reportVoiceStage("wake-lock", null, { via: "video" });
      } catch (e) {
        reportVoiceStage("wake-lock-fallback-fail", e, {});
      }
    }
    function releaseWakeLock() {
      try {
        if (wakeLockSentinel !== null) { const s = wakeLockSentinel; wakeLockSentinel = null; void s.release(); }
      } catch { /* 忽略 */ }
      try {
        if (wakeLockFallbackEl !== null) {
          const v = wakeLockFallbackEl;
          wakeLockFallbackEl = null;
          try { v.pause(); } catch { /* 忽略 */ }
          v.remove();
        }
      } catch { /* 忽略 */ }
    }
    // [2026-09-22 老大实测·播放卡死"点不动"] 播放按钮的图标不能只等自己 audio 的事件：被全局互斥掐停、
    // 音频流被切断、React 重渲染把节点换掉时事件都可能到不了，图标就停在"播放中"，点下去还在走 pause
    // 分支 → 看着完全没反应。这里登记所有语音条的同步回调，play/pause/ended 在 document 级广播一次，
    // 让每个按钮把自己拉回真实状态（自愈）。
    const voiceBtnSyncers = new Map()
    const syncAllVoiceButtons = () => {
      for (const [el, fn] of voiceBtnSyncers) {
        if (!el.isConnected) { voiceBtnSyncers.delete(el); continue }
        try { fn() } catch { /* 单个按钮出错不影响其它 */ }
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
        // [2026-09-22 互斥] 录音期间任何播放（含官方语音卡、用户手点的那条）立即掐掉
        if (voiceRecordingActive) { try { target.pause(); } catch { /* 忽略 */ } syncAllVoiceButtons(); return; }
        document.querySelectorAll("audio").forEach((a) => {
          if (a !== target && !a.paused) { try { a.pause(); } catch { /* 忽略 */ } }
        });
        lastAutoPlayedAudio = target.closest("[data-voice-reply]") ? target : lastAutoPlayedAudio;
        syncAllVoiceButtons();
      }, true);
      // [2026-09-22 自愈] 暂停/播完也广播：互斥掐停、音频流中断走的都是这些事件，
      // 别让图标停在假的"播放中"（"点下去没反应"的根源）。
      document.addEventListener("pause", () => syncAllVoiceButtons(), true);
      document.addEventListener("ended", () => syncAllVoiceButtons(), true);
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
      // [2026-09-22] 被自动播放策略拦过（没手势）就置位：scanAndPlay 先停手，等用户碰屏幕再补播。
      let autoplayBlocked = false;
      const scanAndPlay = () => {
        if (!autoPlayAssistantVoice) return;
        if (voiceRecordingActive) return; // [2026-09-22 互斥] 录音期间不自动播
        if (autoplayBlocked) return; // [2026-09-22] 被策略拦过：等用户碰屏幕再补播，别空转
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
        // [2026-09-22 修·老大实测"自动播放会不停重复播"] 原来只有 play() 成功才记账：被自动播放策略
        // 或录音互斥拦掉时**不记账** → 1.5 秒后又挑中同一条重试 → 反复试图出声（听感就是同一条不停重播）。
        // 改成**先记账再播**：失败不无限重试（这条转为"未自动播，可手动点"），并上报一次现场便于追查。
        playedVoiceIds.add(vid);
        persistPlayedVoiceIds();
        audio.play().then(() => {
          lastAutoPlayedAudio = audio;
          autoplayBlocked = false;
        }).catch((err) => {
          const nm = String((err && err.name) || "");
          // [2026-09-22 补修·老大实测"是不是把自动播放关了"] "先记账"有副作用：iOS 没用户手势时本来就会
          // 拒一次（NotAllowedError），被拒也记成"已播" → 这条语音**永远不再自动播**，看着就是被关了。
          // 策略性拒绝必须撤销记账并等用户碰屏幕补播；其它失败（流断/中断）才保持"不重试"防同一条反复响。
          if (nm === "NotAllowedError" || nm === "NotSupportedError") {
            playedVoiceIds.delete(vid);
            persistPlayedVoiceIds();
            autoplayBlocked = true;
            reportVoiceStage("autoplay-blocked", null, { vid: String(vid).slice(0, 24), name: nm });
            return;
          }
          reportVoiceStage("autoplay-play-fail", err, { vid: String(vid).slice(0, 24) });
        });
      };
      // [2026-09-22] 用户第一次碰屏幕 = 有手势了：清掉"被拦"标记并立刻补播
      //（不补的话，被 iOS 拦过一次的那条语音永远不会自动出声，看着就像自动播放被关了）。
      const retryAfterGesture = () => {
        if (!autoplayBlocked) return;
        autoplayBlocked = false;
        scanAndPlay();
      };
      document.addEventListener("pointerdown", retryAfterGesture, true);
      document.addEventListener("touchstart", retryAfterGesture, true);
      const obs = new MutationObserver(() => scanAndPlay());
      obs.observe(document.body, { childList: true, subtree: true, attributeFilter: ["src"] });
      window.setInterval(scanAndPlay, 1500);
      tryPlay_compat();
      function tryPlay_compat() { setTimeout(scanAndPlay, 800); }
      // c) 录音互斥：插件录音入口统一先停自动播放（见录音按钮 handler 调 stopAutoPlayedAudio）
      window.__dshStopAutoPlayedAudio = stopAutoPlayedAudio;
    }

    // ── [2026-09-22 老大拍板] 关掉官方 composer 的"自动聚焦" ───────────────────
    // 官方 InputBar 有两处把焦点交还输入框：①Unlock（挂载/切会话）②工具栏按钮按下后还原
    // （packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:164-171 / 256-270）。
    // 桌面是贴心，手机上是每次发完、点完聊天记录就弹输入法。老大要求：**一律不自动聚焦，
    // 要打字自己点**。官方没给开关，这里在插件层兜住——只有用户自己按在输入框上才放行。
    let composerAutoFocusGuardInstalled = false;
    function installComposerNoAutoFocus() {
      if (composerAutoFocusGuardInstalled || typeof document === "undefined") return;
      composerAutoFocusGuardInstalled = true;
      let lastPointerDownAt = 0;
      let lastPointerDownOnComposer = false;
      // [2026-09-22 修·"发完还是弹输入法"] 发送键/工具按钮**和输入框在同一个 composer 容器里**，
      // 原来只判断 closest("[data-composer-input]")，于是点发送键被误判成"用户点了输入框"→放行。
      // 按钮/链接一律不算"点输入框"（打字不可能靠在按钮上）。
      const isComposer = (el) => {
        if (!el || typeof el.closest !== "function") return false;
        if (el.closest("button,[role='button'],a")) return false;
        return !!el.closest("[data-composer-input]");
      };
      const markPointer = (e) => {
        lastPointerDownAt = Date.now();
        lastPointerDownOnComposer = isComposer(e.target);
      };
      const allowComposerFocus = () => {
        // ⚡ 写稿/回填是程序化聚焦，给 5 秒免死金牌（否则刚填完就被拦）
        try { if (Number(window.__dshComposerFocusGraceAt) > Date.now() - 5000) return true; } catch { /* 忽略 */ }
        // 用户 1 秒内亲手点过输入框 → 这正是他要键盘
        return lastPointerDownOnComposer && Date.now() - lastPointerDownAt < 1000;
      };
      // [2026-09-22 修·"点发送还是弹输入法"] 前两版都在事后收（focusin 里 blur），手机上没用：
      // 键盘是"用户手势中聚焦输入框"直接激起来的，blur() 追不上（client-voice.log 里
      // noautofocus-blur 记了一堆，键盘照样弹）。真根因在官方：InputBar 给发送/工具按钮挂了
      // onMouseDown={keepFocus}，实现是 event.preventDefault() + editor.getRootElement().focus()
      // （ui-conversation .../input/editor/view-binding.ts:152）。→ 唯一可靠的解法是**掐掉聚焦动作本身**：
      // 给 contenteditable 宿主（[data-composer-input]）的 focus() 上闸门，只有上面 allowComposerFocus()
      // 放行时才真的聚焦。iOS 手指点输入框是浏览器原生聚焦、不走 JS focus()，所以打字不受影响。
      if (!HTMLElement.prototype.__dshComposerFocusPatched) {
        const origFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function patchedComposerFocus(...args) {
          try {
            if (this && typeof this.hasAttribute === "function" && this.hasAttribute("data-composer-input") && !allowComposerFocus()) {
              reportVoiceStage("noautofocus-block", null, { tag: this.tagName, cls: String(this.className || "").slice(0, 60) });
              return;
            }
          } catch { /* 忽略 */ }
          return origFocus.apply(this, args);
        };
        HTMLElement.prototype.__dshComposerFocusPatched = true;
      }
      document.addEventListener("pointerdown", markPointer, true);
      document.addEventListener("mousedown", markPointer, true);
      // [2026-09-22 修·发送键仍弹输入法] 不猜了：①**连续几拍**确认焦点没被塞回输入框（程序化聚焦
      // 可能晚到 80~600ms）②每次真的收掉都上报服务器（`noautofocus-blur`），下次复现直接看现场。
      const blurComposerIfStolen = (label) => {
        for (const delay of [0, 80, 250, 600]) {
          window.setTimeout(() => {
            const ae = document.activeElement;
            if (!isComposer(ae)) return;
            try { if (Number(window.__dshComposerFocusGraceAt) > Date.now() - 5000) return; } catch { /* 忽略 */ }
            try { ae.blur(); } catch { /* 忽略 */ }
            reportVoiceStage("noautofocus-blur", null, { label, delay, tag: ae.tagName, cls: String(ae.className || "").slice(0, 60) });
          }, delay);
        }
      };
      document.addEventListener("pointerup", (e) => { if (!isComposer(e.target)) blurComposerIfStolen("pointerup"); }, true);
      document.addEventListener("click", (e) => { if (!isComposer(e.target)) blurComposerIfStolen("click"); }, true);
      document.addEventListener("focusin", (e) => {
        if (!isComposer(e.target)) return;
        // ⚡ 写稿/回填是程序化聚焦，给 5 秒免死金牌（否则刚填完就被收回焦点）
        try { if (Number(window.__dshComposerFocusGraceAt) > Date.now() - 5000) return; } catch { /* 忽略 */ }
        // 用户 1 秒内亲手点过输入框 → 这正是他要的，放行
        if (lastPointerDownOnComposer && Date.now() - lastPointerDownAt < 1000) return;
        try { e.target.blur(); } catch { /* 忽略 */ }
        reportVoiceStage("noautofocus-blur", null, { label: "focusin", tag: e.target.tagName, cls: String(e.target.className || "").slice(0, 60) });
      }, true);
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
            // [2026-09-22 修·用户语音条不能播] 原走官方 /api/voice，那条路由把 Content-Type
            // 写死 audio/mpeg（不看真实内容），而用户录音是 WebM/Opus → 声明与内容不符，浏览器
            // 直接拒播（现象：语音条点了没反应）。改走本插件自己的 /voice/object/<sha>——它用
            // sniffAudioType() 嗅探真实容器（本日已补 WebM 分支）。
            const src = meta.objectRef?.voiceId
              ? `/voice/object/${encodeURIComponent(String(meta.objectRef.voiceId).replace(/^sha256:/, ""))}`
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
        // [2026-09-22 修·"第二次听就卡住点不动"] 原来 play() 是异步的却**立刻**把图标改成 ⏸，也不监听
        // 播放事件：只要有一次 play 失败、或被全局互斥暂停，图标就和真实状态对不上（看着在播、点下去没反应）。
        // 改为**图标完全由真实音频事件驱动**，点击只负责发起播放/暂停，失败如实反映并上报服务器。
        const syncBtn = () => {
          if (audio.error !== null && audio.error !== undefined) { btn.textContent = "⚠"; btn.title = "音频加载失败"; return; }
          btn.textContent = audio.paused ? "▶" : "⏸";
          btn.title = audio.paused ? "播放语音" : "暂停";
        };
        // [2026-09-22 老大实测·播放卡死] 登记进全局同步表：任何 play/pause/ended 广播都会轮到本按钮，
        // 不再只指望它自己的 audio 事件（被互斥掐停/流中断时那些事件可能压根不到）。
        voiceBtnSyncers.set(btn, syncBtn);
        /** 点击后立刻同步，并在 300ms 后复查一次——事件丢了也能自己爬回正确图标。 */
        let syncTimer = null;
        const syncSoon = () => {
          syncBtn();
          if (syncTimer !== null) window.clearTimeout(syncTimer);
          syncTimer = window.setTimeout(() => { syncTimer = null; syncBtn(); }, 300);
        };
        btn.onclick = () => {
          // [2026-09-22 自愈] 不再拿 audio.paused 当唯一真相：先把"在播"无条件停掉，
          // 否则状态错乱时这一下永远走 pause 分支、看着就是点了没反应。
          if (!audio.paused) { try { audio.pause(); } catch { /* 忽略 */ } syncSoon(); return; }
          let p = null;
          try { p = audio.play(); } catch (err) { p = Promise.reject(err); }
          if (p && typeof p.catch === "function") {
            p.catch((err) => {
              reportVoiceStage("bubble-play-fail", err, {
                src: String(audioSrc).slice(0, 140),
                readyState: audio.readyState, networkState: audio.networkState,
              });
              try { btn.textContent = "⚠"; btn.title = "播放失败（详情已上报）"; } catch { /* 忽略 */ }
            });
          }
          syncSoon();
        };
        audio.onplay = syncBtn;
        audio.onpause = syncBtn;
        audio.onended = syncBtn;
        audio.onerror = () => { syncBtn(); };
        // [2026-09-22 自愈] 流卡住/等待缓冲也要把图标拉回真实状态，否则"看着在播、点下去没反应"。
        audio.onstalled = syncBtn;
        audio.onwaiting = syncBtn;
        audio.ondurationchange = syncBtn;
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
    // [2026-09-21] ⚡ 提示词优化分区卡片图标（与 micIcon/imageIcon 同规格，跟随 accent 上色）
    const boltIcon = h("svg", svgProps,
      h("path", { d: "M9.2 1.2 L3.6 8.8 H7.1 L6.6 14.8 L12.4 7.0 H8.9 Z", fill: "currentColor" }),
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
    // hover 实底对齐官方 .add:hover。
    // [2026-09-22 修·老大实测"录音中点一下屏幕，红按钮变黑、秒数还在"] 这个 handler 是**命令式改 DOM
    // style.background** 的：手指离开按钮时它把底色写回硬编码灰，把 React 刚设的红底直接盖掉；而 React 的
    // state 没变、不会再渲染一次把红色写回来 → 按钮就停在灰/黑底（label 仍是秒数，看着就是"红按钮变黑"）。
    // 现在：①有专用底色的状态一律传 active=true，handler 完全不碰底色；②restBg 可指定"离开时恢复成什么"。
    const circleBtnHover = (active, restBg) => {
      const rest = restBg || "var(--dsw-specific-selector, rgba(128,128,128,.16))";
      return {
        onMouseEnter: (e) => { if (!active) e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover-solid, rgba(128,128,128,.28))"; },
        onMouseLeave: (e) => { if (!active) e.currentTarget.style.background = rest; },
      };
    };

    // ── 左工具行：图片（官方 draft 链路）+ 语音 ─────────────────────
    // [iPhone 实测 2026-09-11] iOS Safari MediaRecorder 不支持 audio/webm，只支持 audio/mp4。
    // 写死 webm 会在构造/停止时抛错（Safari 文案 "undefined is not an object"）。
    // 按 isTypeSupported 依次探测：webm;codecs=opus → webm → mp4 → 浏览器默认（无 mimeType）。
    function pickRecorderMimeType() {
      if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
      // [2026-09-22 修·iPhone 录出空壳（老大语音问题总根）] Safari 会**谎报**
      // isTypeSupported("audio/webm;codecs=opus") === true（实测 iPhone OS 18_7 / Safari 27.2，
      // 探测回 supports 含 webm，于是 actual 选了 webm），录出来的却是 5 字节空壳：
      // ASR 返回 500、语音条播不了、发出去是"空包"。历史上 10 次 voice-direct-degrade / 6 次
      // send-fail 都是这个。**苹果设备一律优先它真能录的 mp4**（2026-09-11 实测 iPhone 只认 mp4）；
      // 其余浏览器仍走 webm。
      const ua = typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "";
      const apple = /iPhone|iPad|iPod/i.test(ua)
        || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
      const candidates = apple
        ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
        : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
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
    // ══════════════════════════════════════════════════════════
    // [2026-09-20] 视频消息（host 侧配套：send_video 工具 + GET /video-media Range 路由）
    // video/reply 事件 → 独立视频横条；user/message 里的视频附件 → 气泡下方可播放条。
    // 交互对齐官方 ImageLightbox 与老大 8090：点开放大播放，×/遮罩/Esc 关闭收回。
    // ══════════════════════════════════════════════════════════
    let reactDom = null;
    try { reactDom = require("react-dom"); } catch { /* 缺 react-dom：放大层退化为行内 fixed 渲染 */ }

    function fmtDuration(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return "";
      const s = Math.round(n / 1000);
      return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }

    function videoSrcOf(attachmentId) {
      return "/video-media?attachmentId=" + encodeURIComponent(attachmentId);
    }

    /** 放大播放层：portal 到 body，<video controls 自动播放>；点遮罩/×/Esc 关闭。 */
    function VideoLightbox({ src, label, onClose }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        const prev = document.activeElement;
        return () => {
          window.removeEventListener("keydown", onKey);
          try { if (prev && typeof prev.focus === "function") prev.focus(); } catch { /* 忽略 */ }
        };
      }, [onClose]);
      const layer = h("div", {
        role: "dialog", "aria-modal": "true", "aria-label": label || "视频播放",
        style: { position: "fixed", inset: "0", zIndex: "1000", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.78)" },
        onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h("video", {
          src, controls: true, autoPlay: true, playsInline: true,
          style: { maxWidth: "min(100%, 1400px)", maxHeight: "calc(100vh - 80px)", borderRadius: "12px", background: "#000", outline: "none" },
          onMouseDown: (e) => e.stopPropagation(),
        }),
        h("button", {
          type: "button", "aria-label": "关闭", title: "关闭（Esc）", onClick: onClose,
          style: { position: "absolute", top: "14px", right: "18px", width: "38px", height: "38px", borderRadius: "50%", border: "none", background: "rgba(255,255,255,.16)", color: "#fff", fontSize: "20px", lineHeight: "38px", cursor: "pointer" },
        }, "×"),
      );
      return reactDom && typeof reactDom.createPortal === "function"
        ? reactDom.createPortal(layer, document.body)
        : layer;
    }

    // [2026-09-21] present 附件卡视频化：官方点卡走 openFile → Sidebar 文档页，字节受
    // readBytes 全文件上限，大视频必挂（"打开就不能看"）。此拦截把视频扩展名的
    // [data-presented-file] 卡点击改道灯箱，src 走 host /workspace-media（Range 流式，
    // 与 video 横条同一交互）。菜单钮（aria-haspopup）放行——系统默认应用/资源管理器保留。
    const PRESENTED_VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
    function openPresentedMediaOverlay(src, label) {
      if (document.querySelector("[data-presented-video-overlay]")) return;
      const layer = document.createElement("div");
      layer.setAttribute("data-presented-video-overlay", "");
      layer.style.cssText = "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.78)";
      const video = document.createElement("video");
      video.src = src; video.controls = true; video.autoplay = true; video.playsInline = true;
      video.setAttribute("aria-label", label || "视频播放");
      video.style.cssText = "max-width:min(100%,1400px);max-height:calc(100vh - 80px);border-radius:12px;background:#000;outline:none";
      const x = document.createElement("button");
      x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "关闭"); x.title = "关闭（Esc）";
      x.style.cssText = "position:absolute;top:14px;right:18px;width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.16);color:#fff;font-size:20px;line-height:38px;cursor:pointer";
      const close = () => {
        document.removeEventListener("keydown", onKey);
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* 已释放 */ }
        layer.remove();
      };
      const onKey = (ev) => { if (ev.key === "Escape") close(); };
      video.addEventListener("mousedown", (ev) => ev.stopPropagation());
      layer.addEventListener("mousedown", (ev) => { if (ev.target === layer) close(); });
      x.addEventListener("click", close);
      layer.appendChild(video); layer.appendChild(x);
      document.body.appendChild(layer);
      document.addEventListener("keydown", onKey);
      const p = video.play(); if (p && typeof p.catch === "function") p.catch(() => {});
    }
    document.addEventListener("click", (e) => {
      if (!(e.target instanceof Element)) return;
      const card = e.target.closest("[data-presented-file]");
      if (card === null) return;
      const btn = e.target.closest("button");
      if (btn === null) return;
      if (btn.getAttribute("aria-haspopup") === "menu") return;
      const previewBtn = card.querySelector("button[title]");
      const abs = previewBtn === null ? null : previewBtn.getAttribute("title");
      if (abs === null || !PRESENTED_VIDEO_EXT.test(abs)) return;
      e.preventDefault(); e.stopPropagation();
      openPresentedMediaOverlay("/workspace-media?path=" + encodeURIComponent(abs), abs.slice(Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/")) + 1));
    }, true);

    // ── [2026-09-21] 侧栏文件树视频预览（A 侧注册；配套核心 ui-sidebar-documentpreview 的 stream 加载模式 B）──
    // 官方 bytes-complete 走 readBytes：32MB 上限 + base64 RPC 膨胀，视频根本不该走那条路。
    // stream 模式 = owner 不读字节，渲染器拿 useResource 的 absolutePath 拼 /workspace-media（Range 流式可 seek）。
    const SIDEBAR_VIDEO_ID = "@oadank/dsh-input-tools/sidebar-video";
    const SIDEBAR_VIDEO_EXT = ["mp4", "mov", "webm", "m4v"];
    function SidebarVideoBody({ resourceAddress, content, useResource }) {
      const meta = useResource(resourceAddress);
      const abs = meta && meta.value && typeof meta.value.absolutePath === "string" ? meta.value.absolutePath : null;
      if (abs === null) {
        return h("div", { "data-sidebar-video": "", style: { padding: "24px 16px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", fontSize: "13px" } },
          h("p", { style: { margin: "0" } }, meta && meta.failure ? "视频元数据读取失败：" + String(meta.failure.code || meta.failure.message || "") : "视频路径解析中…"));
      }
      const name = abs.slice(Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/")) + 1);
      return h("div", { "data-sidebar-video": "", style: { display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", height: "100%", boxSizing: "border-box" } },
        h("video", {
          src: "/workspace-media?path=" + encodeURIComponent(abs),
          controls: true, playsInline: true, preload: "metadata",
          "aria-label": "视频预览 " + name, title: name,
          style: { maxWidth: "100%", maxHeight: "calc(100vh - 220px)", borderRadius: "10px", background: "#000", outline: "none" },
        }));
    }

    /** 聊天流里的视频横条：官方 singleFit 同款（长边 240、比例 clamp [0.25,4]、cover 裁）。
     *  side: 'ai'=左对齐（助手） / 'user'=右对齐（用户）。
     *  [2026-09-24] 宽高优先用事件里的，没有就等 <video> metadata 再按原比例算（竖屏不再被压成 16:9）。 */
    function VideoReplyBar({ video, side }) {
      const [open, setOpen] = useState(false);
      const [nat, setNat] = useState({ w: Number(video.width) || 0, h: Number(video.height) || 0 });
      const src = videoSrcOf(video.attachmentId);
      const w = nat.w > 0 ? nat.w : 16;
      const ht = nat.h > 0 ? nat.h : 9;
      const ratio = Math.min(4, Math.max(0.25, w / ht));
      let bw; let bh;
      if (ratio >= 1) { bw = 240; bh = Math.max(60, Math.round(240 / ratio)); }
      else { bh = 240; bw = Math.max(60, Math.round(240 * ratio)); }
      const dur = fmtDuration(video.durationMs || nat.durationMs);
      const label = video.alt || video.name || "视频";
      const isUser = side === "user";
      return h("div", {
        "data-video-reply": "",
        "data-video-side": isUser ? "user" : "ai",
        style: {
          display: "flex", flexDirection: "column", gap: "4px", padding: "2px 0",
          alignSelf: isUser ? "flex-end" : "flex-start",
          marginLeft: isUser ? "auto" : "0",
          marginRight: isUser ? "0" : "auto",
          alignItems: isUser ? "flex-end" : "flex-start",
        },
      },
        h("button", {
          type: "button", "aria-label": "放大播放视频", title: "点击放大播放",
          onClick: () => setOpen(true),
          style: { position: "relative", margin: 0, padding: 0, width: bw + "px", height: bh + "px", minWidth: "44px", minHeight: "44px", border: "none", borderRadius: "16px", overflow: "hidden", cursor: "zoom-in", background: "#000", display: "block" },
        },
          h("video", {
            src, muted: true, playsInline: true, preload: "metadata",
            onLoadedMetadata: (e) => {
              const v = e && e.target;
              if (v && v.videoWidth > 0 && v.videoHeight > 0) {
                setNat((prev) => (prev.w > 0 && prev.h > 0 ? prev : { w: v.videoWidth, h: v.videoHeight, durationMs: Math.round((v.duration || 0) * 1000) }));
              }
            },
            style: { width: "100%", height: "100%", objectFit: "cover", display: "block", pointerEvents: "none" },
          }),
          h("span", {
            "aria-hidden": "true",
            style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" },
          }, h("span", {
            style: { width: "40px", height: "40px", borderRadius: "50%", background: "rgba(0,0,0,.45)", color: "#fff", fontSize: "16px", lineHeight: "40px", textAlign: "center", paddingLeft: "3px" },
          }, "▶")),
          dur !== "" ? h("span", {
            style: { position: "absolute", right: "8px", bottom: "8px", padding: "1px 7px", borderRadius: "10px", background: "rgba(0,0,0,.6)", color: "#fff", fontSize: "11px", pointerEvents: "none" },
          }, dur) : null,
        ),
        video.alt ? h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", maxWidth: "280px" } }, video.alt) : null,
        open ? h(VideoLightbox, { src, label, onClose: () => setOpen(false) }) : null,
      );
    }

    // ── video/reply → 'video-reply' chat node（镜像核心 image-reply.ts 的折叠逻辑）──
    const videoReplyDefinition = {
      kind: "video-reply",
      target: "chat",
      match: (event) => (event.type === "video/reply" ? { id: String(event.seq), role: "start" } : null),
      start: (_context, match) => {
        const d = match.event.data || {};
        if (typeof d.attachmentId !== "string") return undefined;
        return {
          turn: typeof d.turn === "number" ? d.turn : 0,
          seq: match.event.seq,
          time: match.event.time,
          video: {
            attachmentId: d.attachmentId,
            mediaType: d.mediaType || "video/mp4",
            bytes: d.bytes || 0,
            width: d.width, height: d.height, durationMs: d.durationMs,
            alt: typeof d.alt === "string" && d.alt !== "" ? d.alt : undefined,
          },
        };
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        const s = context.state;
        if (s === undefined) return null;
        const loc = (context.start && context.start.location) ||
          (context.matches && context.matches[0] && context.matches[0].location) ||
          { kind: "unresolved" };
        return {
          key: context.key, kind: "video-reply", id: context.id, target: "chat",
          anchorSeq: s.seq, location: loc, visibility: "visible",
          data: { turn: s.turn, seq: s.seq, time: s.time, video: s.video },
        };
      },
    };
    function VideoReplyNodeView({ node }) {
      try { window.__dshVideo = window.__dshVideo || {}; window.__dshVideo.viewCalls = (window.__dshVideo.viewCalls || 0) + 1; } catch { /* 探针用 */ }
      // AI 侧：靠左（与助手消息同侧）。用户侧靠右。
      return h("div", {
        "data-video-reply-row": "ai",
        style: {
          display: "flex", justifyContent: "flex-start", alignItems: "flex-start",
          width: "100%", maxWidth: "100%", padding: "2px 0",
          marginLeft: "0", marginRight: "auto", alignSelf: "flex-start",
          textAlign: "left", direction: "ltr",
        },
      }, h(VideoReplyBar, { video: node.data.video, side: "ai" }));
    }

    // ── 用户消息里的视频附件 → 气泡下方 'user-video' 播放条 ──
    // user/message 的 content 里 file 块带 {type:'file', attachment:{attachmentId, mediaType?, name?}}；
    // 事件结构对不上时返回空（静默降级为官方文件 chip，绝不误伤普通消息）。
    function videoPartsFromUserMessage(data) {
      const parts = Array.isArray(data && data.content) ? data.content : [];
      const out = [];
      for (const p of parts) {
        if (!p) continue;
        const att = (p.type === "file" || p.type === "image")
          ? (p.attachment || p.file || (p.attachment && p.attachment.file) || null)
          : null;
        const nested = att && typeof att === "object" && att.file && typeof att.file === "object" ? att.file : att;
        if (!nested || typeof nested.attachmentId !== "string") continue;
        const mt = typeof nested.mediaType === "string" ? nested.mediaType : (typeof att.mediaType === "string" ? att.mediaType : "");
        const nm = typeof nested.name === "string" ? nested.name
          : (typeof nested.filename === "string" ? nested.filename
            : (typeof att.name === "string" ? att.name : ""));
        if (mt.indexOf("video/") === 0 || /\.(mp4|m4v|mov|webm)$/i.test(nm)) {
          out.push({
            attachmentId: nested.attachmentId,
            mediaType: mt || "video/mp4",
            bytes: nested.bytes || att.bytes || 0,
            name: nm,
            width: Number(nested.width) || undefined,
            height: Number(nested.height) || undefined,
          });
          try {
            const map = window.__dshVideoNameToId || (window.__dshVideoNameToId = new Map());
            if (nm) { map.set(nm, nested.attachmentId); map.set(nm.toLowerCase(), nested.attachmentId); }
          } catch { /* 无 window */ }
        }
      }
      return out;
    }

    // [2026-09-25] 会话里出现带视频的用户消息/收件箱插入时，先登记 文件名→attachmentId。
    // 不管出不出节点，这张表都要填，否则 fileCard 升级预览找不到媒体、点击也没反应。
    function rememberVideosFrom(data) {
      try { videoPartsFromUserMessage(data); } catch { /* ignore */ }
    }

    // AI 侧「收到的用户视频」：收件箱插入副本 → 左对齐预览（带路径，AI 靠它找文件）。
    const inboxVideoDefinition = {
      kind: "user-video",
      target: "chat",
      match: (event) => {
        if (event.type === "user/message") {
          rememberVideosFrom(event.data);
          return null; // 用户消息里的视频走 fileCard→预览，不另出节点
        }
        if (event.type === "agent/inbox/spliced") {
          const inserted = (event.data && Array.isArray(event.data.inserted)) ? event.data.inserted : [];
          const data = { content: inserted.flatMap((m) => (m && m.content) || []) };
          rememberVideosFrom(data);
          return videoPartsFromUserMessage(data).length > 0 ? { id: "uvin-" + event.seq, role: "start" } : null;
        }
        return null;
      },
      start: (_context, match) => {
        const inserted = (match.event.data && Array.isArray(match.event.data.inserted)) ? match.event.data.inserted : [];
        return {
          seq: match.event.seq,
          videos: videoPartsFromUserMessage({ content: inserted.flatMap((m) => (m && m.content) || []) }),
        };
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        const s = context.state;
        if (s === undefined) return null;
        const loc = (context.start && context.start.location) ||
          (context.matches && context.matches[0] && context.matches[0].location) ||
          { kind: "unresolved" };
        return {
          key: context.key, kind: "user-video", id: context.id, target: "chat",
          anchorSeq: s.seq + 0.02, location: loc, visibility: "visible",
          data: { videos: s.videos },
        };
      },
    };
    function UserVideoNodeView({ node }) {
      const vids = Array.isArray(node.data.videos) ? node.data.videos : [];
      // AI 侧收到的用户视频：靠左
      return h("div", {
        "data-video-reply-row": "ai",
        style: {
          display: "flex", flexWrap: "wrap", gap: "10px",
          justifyContent: "flex-start", alignItems: "flex-start",
          width: "100%", maxWidth: "100%", padding: "2px 0",
          marginLeft: "0", marginRight: "auto", alignSelf: "flex-start",
        },
      }, vids.map((v) => h(VideoReplyBar, { key: v.attachmentId, video: v, side: "ai" })));
    }

    // ── [2026-09-26 零改动化迁移] AI 语音回复条 + AI 图片回复条 ──
    // 原居 fork ui-chat（VoiceCard/VoiceReplyNodeView/ImageReplyNodeView + voice-reply.ts/
    // image-reply.ts），现搬回插件：与视频条同一正路（官方 Conversation Node 纪律——
    // uic.events.register + keyed conversation.chat.node 渲染器），fork 侧即将还原官方版。
    // 属性 data-voice-reply/data-voice-id 保持不变：自动播放、全局互斥、自愈广播照常工作。
    const voiceObjectUrlCache = new Map();
    async function loadVoiceUrl(ref) {
      const cached = voiceObjectUrlCache.get(ref.voiceId);
      if (cached !== undefined) return cached;
      // [2026-09-26 案2] 读口从官方 edge-tts 包的 /api/voice（无 Range，iPhone 拒播）
      // 换成本插件自带 /voice/object/<sha>（带 Range/206 + 音频嗅探，2026-09-22 iOS 修复版）。
      const base = typeof location !== "undefined" ? location.origin : "http://127.0.0.1";
      const sha = String(ref.voiceId).replace(/^sha256:/, "");
      const url = new URL("/voice/object/" + encodeURIComponent(sha), base);
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error("voice load failed: " + String(response.status));
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      voiceObjectUrlCache.set(ref.voiceId, objectUrl);
      return objectUrl;
    }
    // 微信式定宽：4 秒内 96px，之后每秒 +4px，上限 320px（无转写时才定宽，有转写按文字自然撑开）。
    function voiceCardWidth(seconds) {
      if (seconds <= 4) return 96;
      return Math.min(320, 96 + (seconds - 4) * 4);
    }
    function VoiceCardBar({ attachment, asrFailedHint }) {
      const [url, setUrl] = useState(null);
      const [failed, setFailed] = useState(false);
      const [playing, setPlaying] = useState(false);
      const [copied, setCopied] = useState(false);
      const [reloadKey, setReloadKey] = useState(0);
      const audioRef = useRef(null);
      const voiceId = attachment.voiceId;
      // 依赖用稳定的 voiceId（内容寻址，内容变 id 必变）：流式渲染期间 node 反复重建，
      // 若依赖 attachment 对象会把正在自动播放的新语音掐断（2026-09-22 实测教训，原样带过来）。
      useEffect(() => {
        let cancelled = false;
        setFailed(false);
        loadVoiceUrl(attachment).then(
          (next) => { if (!cancelled) setUrl((prev) => (prev === next ? prev : next)); }, // 地址没变保持原引用，别换掉播放中的 src
          () => { if (!cancelled) setFailed(true); },
        );
        return () => { cancelled = true; };
      }, [voiceId, reloadKey]);
      const toggle = () => {
        const audio = audioRef.current;
        // 失败态可点：重新取地址再来一次，不把自己锁死（2026-09-22「播一半停住点不动」教训）。
        if (audio === null || failed || audio.error !== null) {
          setFailed(false); setUrl(null); setReloadKey((k) => k + 1);
          return;
        }
        if (playing) { try { audio.pause(); } catch { /* 忽略 */ } }
        else { void audio.play().catch(() => setFailed(true)); }
      };
      const seconds = attachment.durationMs !== undefined && attachment.durationMs !== null
        ? Math.max(1, Math.ceil(attachment.durationMs / 1000)) : null;
      const hasTranscript = typeof attachment.transcript === "string" && attachment.transcript !== "";
      const pill = {
        display: "inline-flex", alignItems: "center", gap: "8px", maxWidth: "100%",
        height: "44px", padding: "0 16px 0 10px", boxSizing: "border-box",
        background: "var(--dsw-specific-bubble, rgba(120,160,255,0.16))",
        borderRadius: "22px", color: "inherit",
      };
      if (!hasTranscript && attachment.durationMs !== undefined) pill.width = voiceCardWidth(seconds || 1) + "px";
      const btnGhost = {
        width: "24px", height: "24px", flex: "0 0 auto", display: "grid", placeItems: "center",
        border: "none", borderRadius: "6px", background: "transparent", color: "inherit",
        opacity: 0.6, cursor: "pointer", padding: "0",
      };
      const icon = playing
        ? h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
            h("rect", { x: "3.5", y: "3.5", width: "3", height: "9", rx: "1", fill: "currentColor" }),
            h("rect", { x: "9.5", y: "3.5", width: "3", height: "9", rx: "1", fill: "currentColor" }))
        : h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
            h("path", { d: "M5 3.5L12.5 8L5 12.5V3.5Z", fill: "currentColor" }));
      return h("div", { "data-voice": "", style: pill },
        h("button", {
          type: "button", "aria-label": playing ? "停止播放" : "播放语音", onClick: toggle,
          style: { width: "28px", height: "28px", flex: "0 0 auto", display: "grid", placeItems: "center", border: "none", borderRadius: "50%", background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.12))", color: "inherit", cursor: "pointer", padding: "0" },
        }, icon),
        h("span", { style: { fontSize: "12px", opacity: 0.72, fontVariantNumeric: "tabular-nums" } }, seconds === null ? "" : seconds + "s"),
        hasTranscript
          ? h("span", { title: "语音转写文字", style: { fontSize: "12.5px", maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, attachment.transcript)
          : (asrFailedHint ? h("span", { title: "语音未能识别", style: { fontSize: "12px", opacity: 0.5 } }, "未能识别") : null),
        hasTranscript
          ? h("button", {
              type: "button", "aria-label": copied ? "已复制" : "复制转写", title: copied ? "已复制" : "复制转写",
              onClick: () => {
                const text = attachment.transcript || "";
                const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1000); };
                try { void navigator.clipboard.writeText(text).then(done, done); } catch { done(); }
              },
              style: btnGhost,
            }, copied
              ? h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true }, h("path", { d: "M3.5 8.5L6.5 11.5L12.5 4.5", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }))
              : h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
                  h("rect", { x: "5.5", y: "5.5", width: "7", height: "7", rx: "1.2", fill: "none", stroke: "currentColor", strokeWidth: "1.3" }),
                  h("path", { d: "M10.5 5.5V4.5A1 1 0 0 0 9.5 3.5H5A1 1 0 0 0 4 4.5v4.5a1 1 0 0 0 1 1h1", fill: "none", stroke: "currentColor", strokeWidth: "1.3" })))
          : null,
        url !== null
          ? h("audio", { ref: audioRef, src: url, onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false) })
          : null,
      );
    }
    function VoiceReplyRow({ node }) {
      const voice = node.data.voice;
      return h("div", {
        "data-voice-reply": "", "data-voice-id": voice.voiceId,
        style: { display: "flex", justifyContent: "flex-start", alignItems: "flex-start", width: "100%", maxWidth: "100%", padding: "2px 0", marginLeft: "0", marginRight: "auto", alignSelf: "flex-start", textAlign: "left", direction: "ltr" },
      }, h(VoiceCardBar, { attachment: voice }));
    }
    const voiceReplyDefinition = {
      kind: "voice-reply",
      target: "chat",
      match: (event) => (event.type === "voice/reply" ? { id: String(event.seq), role: "start" } : null),
      start: (_context, match) => {
        const d = match.event.data || {};
        if (typeof d.voiceId !== "string") return undefined;
        return {
          turn: typeof d.turn === "number" ? d.turn : 0,
          seq: match.event.seq,
          time: match.event.time,
          voice: {
            voiceId: d.voiceId,
            mediaType: d.mediaType || "audio/mpeg",
            bytes: d.bytes || 0,
            durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
            transcript: typeof d.transcript === "string" && d.transcript !== "" ? d.transcript : undefined,
          },
        };
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        const s = context.state;
        if (s === undefined) return null;
        const loc = (context.start && context.start.location) ||
          (context.matches && context.matches[0] && context.matches[0].location) ||
          { kind: "unresolved" };
        return {
          key: context.key, kind: "voice-reply", id: context.id, target: "chat",
          anchorSeq: s.seq, location: loc, visibility: "visible",
          data: { turn: s.turn, seq: s.seq, time: s.time, voice: s.voice },
        };
      },
    };
    function ImageReplyRow({ node, renderMessageImages }) {
      const image = node.data.image;
      if (typeof renderMessageImages !== "function") return null;
      return h("div", { "data-image-reply": "" }, renderMessageImages({
        images: [{
          attachment: {
            attachmentId: image.attachmentId,
            mediaType: image.mediaType,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
            ...(typeof image.name === "string" && image.name !== "" ? { name: image.name } : {}),
          },
        }],
        align: "start",
      }));
    }
    const imageReplyDefinition = {
      kind: "image-reply",
      target: "chat",
      match: (event) => (event.type === "image/reply" ? { id: String(event.seq), role: "start" } : null),
      start: (_context, match) => {
        const d = match.event.data || {};
        if (typeof d.attachmentId !== "string") return undefined;
        return {
          turn: typeof d.turn === "number" ? d.turn : 0,
          seq: match.event.seq,
          time: match.event.time,
          image: {
            attachmentId: d.attachmentId,
            mediaType: d.mediaType || "image/png",
            bytes: d.bytes || 0,
            width: Number(d.width) || 1,
            height: Number(d.height) || 1,
            name: typeof d.alt === "string" && d.alt !== "" ? d.alt : undefined,
          },
        };
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        const s = context.state;
        if (s === undefined) return null;
        const loc = (context.start && context.start.location) ||
          (context.matches && context.matches[0] && context.matches[0].location) ||
          { kind: "unresolved" };
        return {
          key: context.key, kind: "image-reply", id: context.id, target: "chat",
          anchorSeq: s.seq, location: loc, visibility: "visible",
          data: { turn: s.turn, seq: s.seq, time: s.time, image: s.image },
        };
      },
    };

    function ToolbarLeft({ connection, sessionId }) {
      // [2026-09-22] 版本标记只打一次：老大 Ctrl+Shift+J 看 Console 即可确认是否新代码。
      useEffect(() => {
        if (window.__dshOptEngineLogged === OPT_ENGINE) return;
        window.__dshOptEngineLogged = OPT_ENGINE;
        console.info("[dsh-input-tools] engine " + OPT_ENGINE);
      }, []);
      const [recording, setRecording] = useState(false);
      // [2026-09-22 老大反馈·"麦克风点完不立刻变红、反应慢"] 红底原来挂在 recording 上，而 recording 要等
      // getUserMedia 把麦克风开起来（首次还要等权限弹窗）才置 true → 点下去一两秒没反应。
      // 加一个"启动中"态：点下去立刻红，拿到流之后再交给 recording。
      const [micStarting, setMicStarting] = useState(false);
      const [seconds, setSeconds] = useState(0);
      const secondsRef = useRef(0);
      const [voiceError, setVoiceError] = useState(null); // 语音发送失败提示
      const voiceErrorTimerRef = useRef(null);
      const recorderRef = useRef(null);
      const chunksRef = useRef([]);
      const timerRef = useRef(null);
      const fileRef = useRef(null);
      const videoFileRef = useRef(null); // [2026-09-20] 发视频按钮的隐藏 input
      // [2026-09-22 新增·⚡空框语音输入] 录音结束后的去向："send"=照旧发出去；
      // "voiceopt"=只转写不发送，交给 voiceStopHandlerRef（转写→优化→回填输入框）。
      const voiceStopModeRef = useRef("send");
      const voiceStopHandlerRef = useRef(null);
      const voiceStartingRef = useRef(false);
      // [2026-09-21] ⚡ 提示词优化：idle|busy|done|fail 状态机 + {original, optimized} 暂存（done 点击还原）
      // [2026-09-25 现场记录仪·临时] 「还原」老是掉，静态读代码判不出是哪条路径干的（嫌疑：点击路径用
      // findEditor，轮询路径用 findComposerEl，两套定位可能不是同一个元素）。这里把状态跳变、原因、
      // 当时的框内文字长度写进**浏览器标签页标题**，老大复现一次我从桌面助手 /active 读标题即得真相。
      // 诊断完就拆——这是临时探针，不留成长期副作用。
      const [optStateRaw, setOptStateRaw] = useState("idle");
      const optState = optStateRaw;
      const optTraceRef = useRef([]);
      const optStateNowRef = useRef("idle"); // 轮询回调里读不到最新 optState（闭包是首帧的），探针另存一份
      const setOptState = (v, why) => setOptStateRaw((s) => {
        const n = typeof v === "function" ? v(s) : v;
        if (n !== s) {
          optStateNowRef.current = n;
          optTraceRef.current.push(`${s}>${n}${why ? "(" + why + ")" : ""}`);
          if (optTraceRef.current.length > 5) optTraceRef.current.shift();
        }
        return n;
      });
      const syncOptProbe = () => {
        try {
          const el = typeof findComposerEl === "function" ? findComposerEl() : null;
          const tl = el ? String(getComposerText(el) || "").length : -1;
          const pr = optPairRef.current;
          const pl = pr ? String(pr.optimized || "").trim().length : -1;
          const same = !!(el && pr && typeof normOpt === "function" && normOpt(getComposerText(el)) === normOpt(pr.optimized));
          // [2026-09-25 根因已由老大 F12 现场定死] 探针不再写标题（那会污染标签页），改走 console。
          console.info("[dsh-opt-probe] state=" + optStateNowRef.current + " txt=" + tl + " pair=" + pl + " eq=" + (same ? "Y" : "N") + " « " + optTraceRef.current.slice(-3).join(" "));
        } catch { /* 探针失败不影响任何功能 */ }
      };
      useEffect(() => { syncOptProbe(); }, [optState]);
      const [optDelta, setOptDelta] = useState(null); // [2026-09-21] done 态显示"改了 N 字"，治"看不出变化"
      // [2026-09-21 老大要求] 优化元信息条：显示在输入框正上方、背景透明（不是 toast 深色底）
      const [optMeta, setOptMeta] = useState(null);
      // [2026-09-23 老大实测·"耗时 11.7s 不准"] measuredMs = 从点 ⚡ 到稿子落进输入框的实测墙钟时间，
      // 给了就用它（用户真正等的时间），没给才回落服务端自报的 durationMs。
      const fmtOptMeta = (j, oLen, nLen, measuredMs) => {
        const d = new Date();
        const pad = (x) => String(x).padStart(2, "0");
        const ts = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " "
          + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
        const delta = nLen - oLen;
        const measured = Number(measuredMs);
        const dur = Number.isFinite(measured) && measured > 0 ? measured : Number(j && j.durationMs);
        const qn = j && Array.isArray(j.retrievalQueries) ? j.retrievalQueries.length
          : (j && Array.isArray(j.queries) ? j.queries.length : 0);
        return ts
          + " ｜ 字数 " + oLen + " → " + nLen + "（" + (delta >= 0 ? "+" : "") + delta + "）"
          + " ｜ 耗时 " + (Number.isFinite(dur) ? (dur / 1000).toFixed(1) + "s" : "—")
          + " ｜ 检索 " + qn + " 条查询"
          + " ｜ 上下文 " + (j && j.conversationContextUsed ? "有" : "无")
          + " ｜ 漂移 " + (j && j.drift ? "有" : "无")
          + " ｜ 重试 " + (Number(j && j.attempts) || 1) + " 次";
      };
      // [2026-09-21 老大要求] 不许只用图标/灰按钮糊弄：每个状态都配一句人话，悬浮在按钮上方 6 秒。
      const [optToast, setOptToast] = useState(null); // { text, kind: info|ok|warn|err }
      const optToastTimerRef = useRef(null);
      // [2026-09-22 老大要求·实时秒数] 录音结束后的"正在转文字并优化…"横幅显示从 0 起每秒递增的秒数
      // （原来的"（稍等）"看不出还要多久）。null = 没在计时；渲染处把秒数拼到横幅文案尾部。
      const [optElapsed, setOptElapsed] = useState(null);
      const optElapsedTimerRef = useRef(null);
      // [2026-09-25 修「（已Xs）第一个数从 1s 开始」] 原来是 interval 每 1000ms 给计数 +1：
      // 起点靠上一次残留值 + 每格都漂一点，第一格显示就成了 1。改成**按时间戳现算**，
      // interval 只负责打更刷新 → 第一格必为 0，且累计秒数不再漂移。
      const optT0Ref = useRef(0);
      const startOptElapsed = () => {
        optT0Ref.current = Date.now();
        setOptElapsed(0);
        if (optElapsedTimerRef.current !== null) window.clearInterval(optElapsedTimerRef.current);
        optElapsedTimerRef.current = window.setInterval(() => {
          const t0 = optT0Ref.current;
          setOptElapsed(t0 ? Math.max(0, Math.floor((Date.now() - t0) / 1000)) : 0);
        }, 250);
      };
      const stopOptElapsed = () => {
        if (optElapsedTimerRef.current !== null) { window.clearInterval(optElapsedTimerRef.current); optElapsedTimerRef.current = null; }
        setOptElapsed(null);
      };
      // [2026-09-22 老大反馈·手机放大页面后横幅偏位] position:fixed 是相对 layout viewport 定位的，
      // pinch zoom 后可视区（visual viewport）只占它的一块，横幅就会看着跑偏、超出输入框。
      // 这里订阅 visualViewport 的 resize/scroll 当重算触发器（+1 → 组件重渲染 → 下面的定位段重跑）。
      const [, setVvTick] = useState(0);
      useEffect(() => {
        const vv = (typeof window !== "undefined") ? window.visualViewport : null;
        if (!vv) return undefined;
        const bump = () => setVvTick((n) => n + 1);
        vv.addEventListener("resize", bump);
        vv.addEventListener("scroll", bump);
        return () => { vv.removeEventListener("resize", bump); vv.removeEventListener("scroll", bump); };
      }, []);
      // [2026-09-22 老大实测·切回来横幅只剩上半截] 横幅位置是渲染那一刻按输入框尺寸算死的
      // （bottom = 视口底 − 输入框顶 + 8）。稿子自动填进输入框后输入框长高，横幅不知道 →
      // 被顶出框外/被输入框盖住。这里盯住输入框尺寸：一变就重算位置（复用 setVvTick 触发重渲染）。
      // 注：findComposerEl 定义在本行下方，但因为它在 effect 回调里执行（渲染后才跑），
      // 不会犯"定义前使用"的错——这一点我特意核过。
      useEffect(() => {
        const el = findComposerEl();
        if (el === null || typeof ResizeObserver === "undefined") return undefined;
        const ro = new ResizeObserver(() => setVvTick((n) => n + 1));
        ro.observe(el);
        return () => ro.disconnect();
      }, [sessionId, optState]);
      // [2026-09-22 老大反馈·横幅一闪就没了] 第三参 persist=true 时横幅**不自动消失**（录音中/转写中
      // 这类必须看清流程的提示用）；其余状态照旧 6 秒后收起。非常驻提示一律把秒数计时收掉。
      // [2026-09-22 切会话横幅丢失] 同时写进"按会话"的模块级状态：这样切走再切回，
      // 组件重新挂载时能从那里把常驻横幅恢复出来（后台任务本来就没停）。
      const showOptToast = (text, kind, persist) => {
        // [2026-09-25] 给横幅打"常驻/临时"标记：下面挂载同步要据此决定该不该覆盖屏幕上的内容。
        const rec0 = { text: text, kind: kind || "info", persisted: persist === true };
        setOptToast(rec0);
        // [2026-09-22 老大实测·手机横幅只露上半截、看不到完整提示] 完整文字同时打到控制台，
        // 老大可整句复制给我，不依赖屏幕能看到多少。
        try { console.info("[dsh-opt-toast] " + (kind || "info") + " ｜ " + text); } catch { /* 控制台不可用 */ }
        // [2026-09-22 修·误清常驻横幅] 只有"常驻横幅"这一路才动按会话记录；
        // 短暂提示（6 秒自动收）不能把常驻横幅字段清掉，否则切走再切回横幅就没了。
        if (persist === true) {
          optSessionPatch(sessionId, { toast: rec0 });
        }
        if (optToastTimerRef.current) window.clearTimeout(optToastTimerRef.current);
        if (persist !== true) {
          stopOptElapsed();
          // [2026-09-25 修「发出去后『正在优化…』横幅赖着不走」] 常驻横幅存在按会话记录里，
          // 上面 L1111 的 sync 会把 rec.toast 无条件灌回 optToast —— 于是任务早就结束了，
          // 任何一次 patch（含发送后归零）都把"⏳ 正在优化…"重新捞回屏幕，且它永不自愈。
          // 既然这条新提示已经取代了常驻横幅，就顺手把记录里的常驻字段作废。
          try { optSessionPatch(sessionId, { toast: null }); } catch { /* 无该会话记录 */ }
        }
        if (persist === true) return;
        optToastTimerRef.current = window.setTimeout(() => setOptToast(null), 6000);
      };
      // [2026-09-22 老大实测·切走再切回横幅消失] 挂载时从按会话状态恢复常驻横幅，
      // 并订阅变化：被切回本会话时，横幅/秒数/稿子提示立刻回到屏幕上。
      useEffect(() => {
        const sync = () => {
          optDraftRestore(); // [2026-09-22] 刷新/重开页面：把落盘的待回填稿子先认回来
          const rec = optSessionGet(sessionId);
          if (rec === null) return;
          // [2026-09-23 修·老大实测两 bug（A）] phase 是"当时那一刻"的按钮态，被按会话存下来后，
          // 原来在**任何一次 patch 之后**（含 ⚡ 自己发的常驻横幅）都被无条件回灌，于是：
          //   ① 切到别的会话，⚡ 突然变"↩ 还原原文"——上次优化残留的 done 被灌了回来；
          //   ② 点 ⚡ 开始录音的同一拍里：setOptState("rec") → showOptToast(persist) → patch → sync
          //      → 残留 done 把刚设的 rec 顶掉 → ⚡ 显示"还原原文"，秒数与 ✕ 跑到麦克风那颗上（截图现场）。
          // 现在只承认"本页面真在跑的在途任务"：optSessionLive 这个闸门 09-22 就立了（见 L117 注释）却没接上，
          // 这里接上。done/same/drift/fail 一律不回灌——done 由下面轮询按"框里是不是那张稿子"现算（唯一真相）。
          if (rec.phase === "busy" && optSessionLive(sessionId)) setOptState("busy");
          if (rec.toast === undefined) { /* 记录里没这个字段：不碰屏幕 */ }
          else if (rec.toast === null) {
            // [2026-09-25 修·结果横幅被自己的作废逻辑掐掉] 作废常驻横幅会经订阅回到这里，
            // 原来无条件 setOptToast(null) → 刚 showOptToast("✅ 优化好了…") 就被同一次 patch 抹了。
            // 现在只收"屏幕上正是那条常驻横幅"的情况，临时提示（6 秒自收）留给它自己的定时器。
            setOptToast((cur) => (cur && cur.persisted === true ? null : cur));
          } else setOptToast(rec.toast);
          if (rec.elapsed !== undefined) setOptElapsed(rec.elapsed);
        };
        sync();
        return optSessionSubscribe(sync);
      }, [sessionId]);
      const optPairRef = useRef(null);
      // [2026-09-23 watchdog] 连续多少轮轮询"显示 busy 却查无在途任务"才收兵（800ms/轮，取 2＝1.6s）
      const busyStaleRef = useRef(0);
      // [2026-09-21] ⚡ 状态持久化：pair 落 sessionStorage——刷新后若输入框仍是优化稿，
      // 按钮自动回到"↩ 还原原文"；发送清空则成对作废。老大实测"刷新没保存状态"的补刀。
      const OPT_PAIR_KEY = "dsh-opt-pair";
      const OPT_PAIR_KEY_LEGACY = "dsh-o…pair"; // 旧脏键（曾误写成带省略号的字面量）：只读兼容，写入一律用新键
      const readOptPair = () => {
        try {
          const raw = window.sessionStorage.getItem(OPT_PAIR_KEY) ?? window.sessionStorage.getItem(OPT_PAIR_KEY_LEGACY);
          return raw === null ? null : JSON.parse(raw);
        } catch { return null; }
      };
      const clearOptPair = () => {
        try { window.sessionStorage.removeItem(OPT_PAIR_KEY); } catch { /* 无存储权限 */ }
        try { window.sessionStorage.removeItem(OPT_PAIR_KEY_LEGACY); } catch { /* 无存储权限 */ }
      };
      // [2026-09-21 修「发送后还原按钮挂死」] 与渲染层 findEditor 同逻辑：挑可见 composer，没有再退 textarea。
      const findComposerEl = () => {
        const all = Array.from(document.querySelectorAll("[data-composer-input]"));
        const visible = all.find((el) => {
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          return r && r.width > 0 && r.height > 0;
        });
        if (visible) return visible;
        if (all.length > 0) return all[0];
        return document.querySelector("textarea");
      };
      const getComposerText = (el) => {
        if (!el) return "";
        return (el.tagName === "TEXTAREA"
          ? String(el.value || "")
          : String(el.innerText || "").replace(/[\u200b\u2060]/g, "")).trim();
      };
      // [2026-09-25 修「还原按钮闪一下就没了」] 原来 done 状态靠 txt === optimized.trim() 的**精确比对**维持，
      // 而稿子是多行的：Lexical 的 innerText 与模型输出在换行/行尾空格/\r\n/零宽字符上任差一点，
      // 800ms 轮询就判定"用户改过了"→ resetOptUi → ⚡ 从「还原原文」被打回闪电，还原功能看起来就丢了。
      // 归一化再比：统一换行、去零宽、去每行行尾空白、首尾 trim。
      const normOpt = (s) => String(s == null ? "" : s)
        .replace(/\r\n?/g, "\n").replace(/[\u200b\u2060\ufeff]/g, "")
        .replace(/[ \t]+$/gm, "").trim();
      /** 归零 ⚡ UI：清 pair/sessionStorage/状态条。reportSent=true 时回填采用率日志。 */
      const resetOptUi = (pair, reportSent, why) => {
        // [临时探针] 归零前先把现场留下：谁调的、当时框内几个字、pair 几个字、两边归一化后等不等
        try {
          const el = typeof findComposerEl === "function" ? findComposerEl() : null;
          const tl = el ? String(getComposerText(el) || "").length : -1;
          const pl = pair ? String(pair.optimized || "").trim().length : -1;
          const eq = !!(el && pair && normOpt(getComposerText(el)) === normOpt(pair.optimized));
          optTraceRef.current.push(`RESET[${why || "?"}] txt=${tl} pair=${pl} eq=${eq ? "Y" : "N"}`);
          if (optTraceRef.current.length > 5) optTraceRef.current.shift();
        } catch { /* 探针失败不影响归零 */ }
        if (reportSent && pair && pair.id && !pair.sentReported) {
          pair.sentReported = true;
          reportOptFeedback(pair.id, { sent: true });
        }
        optPairRef.current = null;
        setOptState("idle", "reset:" + (why || "?"));
        setOptMeta(null);
        setOptDelta(null);
        setOptToast(null); // [2026-09-25] 归零=这次优化彻底结束（发出去了/作废了），横幅必须一起收掉
        clearOptPair();
        // [2026-09-23 修（B）] 原来只清 React 状态和 sessionStorage pair，**从不清按会话记录里的 phase**
        // → 残留的 "done" 就成了上面那颗雷的燃料。归零时顺手把它一起清掉（清到发起那条会话名下）。
        try { optSessionPatch((pair && pair.sessionId) || sessionId, { phase: "idle", toast: null }); } catch { /* 无该会话记录 */ }
      };
      // [需求④] 采用率回填：sent=优化稿真的发出去了 / edited=发之前手改过或点了还原原文。
      // 主键是后端写日志时用的 ts（POST /optimize-prompt 返回的 id）。
      const reportOptFeedback = (id, patch) => {
        if (!id) return;
        try {
          void fetch("/optimize-log-feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...patch }),
          });
        } catch { /* 上报失败不影响使用 */ }
      };
      useEffect(() => {
        const iv = window.setInterval(() => {
          // [2026-09-22 修·⚡ 录音期间被轮询打回常态（老大实测：闪电红一会儿就没了、麦克风又冒出红秒数）]
          // 上一次文本优化残留在 sessionStorage 的 pair，会在输入框为空时触发 resetOptUi，
          // 把 "rec" 归零 → 于是横幅/红态消失、麦克风那颗又显示 ●秒数 + 叉。录音期间（含启动中）整个轮询停手。
          if (voiceStopModeRef.current === "voiceopt" || voiceStartingRef.current) return;
          // [2026-09-23 修 watchdog] busy 的语义是"有任务在飞"。可历史上三条路会把它焊死：
          //   ① 文本优化只 optLive.add、从不 delete（见本次 finally）；② 录音空包/残包/被系统掐断三条
          //   死路直接把 optState 留在 busy 却永远等不到处理器；③ 切走暂存那条也没清 live。
          // 后果＝⚡ 永久显示"优化中…"且点不动（onOptimize 见 busy 直接 return），只能刷新页面。
          // 这里按"真没有在途任务就不许 busy"兜底：连续两轮（800ms×2）没有 live 标记、没在录音，
          // 就把按钮收回 ⚡。以后任何新泄漏都能自愈，不再需要老大手动刷新。
          const reallyInFlight = optLive.size > 0 || recorderRef.current !== null || voiceStartingRef.current;
          if (reallyInFlight) {
            busyStaleRef.current = 0;
          } else {
            busyStaleRef.current += 1;
            if (busyStaleRef.current >= 2) {
              busyStaleRef.current = 0;
              setOptState((s) => {
                if (s === "busy") console.warn("[dsh-optimize] watchdog：busy 没有在途任务支撑，强制收回 ⚡");
                return s === "busy" ? "idle" : s;
              }, "watchdog");
            }
          }
          // [2026-09-25] 探针只在状态跳变时打一行 console（原来这里每 800ms 打一次，刷屏）。
          // findComposerEl 会退化到 document.querySelector("textarea")
          // （页面上第一个 textarea），设置页的提示词框/隐藏框都可能抢在前面 → 读回空字符串 →
          // 轮询按"框空=已发送"把 done 打掉，⚡ 就从「↩ 还原」变回闪电。
          // 改法：先在所有候选里找出"与 pair 归一化相等"的那一个；找不到再退回可见 composer。
          let ed = findComposerEl();
          {
            const pr0 = optPairRef.current || readOptPair();
            const baseTxt = ed ? getComposerText(ed) : "";
            if (pr0 && pr0.optimized && normOpt(baseTxt) !== normOpt(pr0.optimized)) {
              try {
                const cands = Array.from(document.querySelectorAll("[data-composer], textarea"));
                let best = null; let bestLen = -1;
                for (const el of cands) {
                  const tx = getComposerText(el);
                  if (!tx) continue;
                  if (normOpt(tx) === normOpt(pr0.optimized)) { best = el; bestLen = 1e9; break }
                  if (tx.length > bestLen) { bestLen = tx.length; best = el }
                }
                if (best && (normOpt(baseTxt) === "" || bestLen > baseTxt.length)) ed = best;
              } catch { /* 挑不动就用原元素 */ }
            }
          }
          if (!ed) return;
          const txt = getComposerText(ed);
          if (!optPairRef.current) {
            const p = readOptPair();
            // [修挂死] pair 与 sessionStorage 都空 + 输入框空 = 已发送/已清空，强制把按钮从「还原」打回 ⚡
            if (p === null) {
              if (txt === "") {
                setOptState((s) => (s === "busy" || s === "rec" ? s : "idle"));
                setOptMeta(null);
                setOptDelta(null);
              }
              return;
            }
            if (p && p.optimized && txt !== "" && normOpt(txt) === normOpt(p.optimized)) {
              p.miss = 0;
              optPairRef.current = p;
              setOptState("done", "poll认回");
            } else if (txt === "") {
              resetOptUi(p, true, "poll:框空");
            } else if (p && p.optimized) {
              // 连错两轮（≈1.6s）才判"用户手改过、还原作废"。一轮就作废太脆：程序化刚写完的瞬时
              // 渲染态、Lexical 的 innerText 差异都能骗过比对（老大实测：还原按钮闪一下就变回闪电）。
              p.miss = (p.miss || 0) + 1;
              if (p.miss >= 2) resetOptUi(p, false, "poll:文字不符连错2轮");
            }
            return;
          }
          const pair = optPairRef.current;
          if (txt === "") {
            resetOptUi(pair, true, "poll:有pair但框空");
            return;
          }
          // [2026-09-25 把 L2164 注释吹过但没实现的能力补上] 框里此刻就是这张稿 → 就必须是 done（能还原）。
          // 兜住两类漏网：① 走了"切走暂存"支路、回填后没人设 done（就是你这次 console 里的现场）；
          // ② 组件被重挂载把 done 洗成 idle。以前这条分支只负责作废、从不认回，还原就是这么丢的。
          if (optStateNowRef.current !== "done" && normOpt(txt) === normOpt(pair.optimized)) {
            setOptState("done", "poll:框里就是这张稿→认回还原");
            return;
          }
          if (!pair.editedReported && normOpt(txt) !== normOpt(pair.optimized)) {
            pair.editedReported = true;
            reportOptFeedback(pair.id, { edited: true });
          }
        }, 800);
        return () => window.clearInterval(iv);
      }, []);
      const rootRef = useRef(null);
      const voiceSupported = typeof navigator !== "undefined" && typeof MediaRecorder !== "undefined";
      // 排序由 apply 级 MutationObserver 处理（insertBefore slot 到 modes 前）
      useEffect(() => { startVoiceBubbleObserver(); startAssistantVoiceAutoPlay(); installComposerNoAutoFocus(); }, []);

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
          // [2026-09-22 硬防线·老大批准] 识别不出内容就别发：发出去也是一条"只有本地路径、谁都读不到"的空语音
          // （原来 transcript=undefined 时照样 sendAsVoice，序列化退化成"本地语音文件路径: …"）。
          // 直接让用户重录，比糊一条无效消息强。
          if (transcript === undefined) {
            fail("没听清，请再说一次（这句没识别出内容，没发出去）");
            return;
          }
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
        voiceRecordingActive = false; // [2026-09-22 互斥] 录音结束（含取消）：放开播放
        releaseWakeLock(); // [2026-09-22 老大要求] 录音结束（含取消）：撤掉"屏幕常亮"
        if (recorder !== null && recorder.state !== "inactive") {
          if (send) recorder.stop();
          else {
            // [2026-09-22 新增] 取消录音：连 ⚡ 语音输入的待办处理器一起清掉，别让下次录音误入该分支。
            voiceStopModeRef.current = "send";
            voiceStopHandlerRef.current = null;
            // [2026-09-22 修·取消后 ⚡ 卡在"录音中"] 任何取消路径都必须把 ⚡ 状态收回 idle
            // （原来只有 ⚡ 自己那条路复位，用麦克风/横幅取消会把按钮卡在录音态）
            setOptState((s) => (s === "rec" ? "idle" : s));
            recorder.onstop = null;
            try { recorder.stop(); } catch { /* ignore */ }
          }
        }
        setRecording(false);
        setMicStarting(false); // [2026-09-22] 启动态一并收回
        setSeconds(0);
      }, []);

      const startRecording = useCallback(async () => {
        if (connection === undefined || sessionId === undefined) return;
        // [2026-09-22 修·防重入] 连点两下会并发起两个 getUserMedia/MediaRecorder，前一个被顶掉后
        // 还可能自行 onstop 产出残包。启动期间（含权限弹窗等待）忽略后续点击。
        if (voiceStartingRef.current || recorderRef.current !== null) return;
        voiceStartingRef.current = true;
        // [2026-09-22] 立刻进"启动中"：按钮先红起来，别让老大点下去一两秒以为没反应。
        setMicStarting(true);
        // [2026-09-22 修·录音与播放互斥] 开始录音前**掐掉所有播放**（含官方语音卡——原来只停了插件自己的
        // audio[data-voice-bubble]，官方那条照响）；并置"录音中"旗标，录音期间禁止任何播放与自动播放。
        voiceRecordingActive = true;
        try { if (typeof window.__dshStopAutoPlayedAudio === "function") window.__dshStopAutoPlayedAudio(); } catch { /* 忽略 */ }
        try { document.querySelectorAll("audio").forEach((a) => { try { if (!a.paused) a.pause(); } catch { /* 忽略 */ } }); } catch { /* 忽略 */ }
        void acquireWakeLock(); // [2026-09-22 老大要求] 录音期间屏幕常亮（HTTPS 用 API，HTTP 走静音视频兜底）
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
          /** [2026-09-22 防线·老大批准] 读音频真实时长（秒）；拿不到返回 null（=不拦，宁可放过不误杀）。
           *  iOS 的 MediaRecorder 常给出 duration=Infinity，用"seek 到极大值"的老办法逼它吐出真实时长。 */
          const probeAudioDuration = (blob) => new Promise((resolve) => {
            let settled = false;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("audio");
            const finish = (v) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
              resolve(v);
            };
            const timer = window.setTimeout(() => finish(null), 4000); // 超时不算证据：不拦
            a.preload = "metadata";
            a.onloadedmetadata = () => {
              if (Number.isFinite(a.duration) && a.duration > 0) { finish(a.duration); return; }
              try { a.currentTime = 1e101; } catch { finish(null); }
            };
            a.ondurationchange = () => { if (Number.isFinite(a.duration) && a.duration > 0) finish(a.duration); };
            a.onerror = () => finish(null);
            a.src = url;
          });
          recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: blobType });
            chunksRef.current = [];
            stream.getTracks().forEach((t) => t.stop());
            if (blob.size === 0) {
              reportVoiceStage("empty-blob", null, { blobType });
              // [2026-09-23 修·⚡ 卡"优化中"] 空包这条路原来什么都不清：处理器还挂着、optState 停在
              // busy（点 ⚡ 停下时先设的），按钮就永久"优化中…"点不动。收回 idle 并摘掉待办处理器。
              voiceStopModeRef.current = "send";
              voiceStopHandlerRef.current = null;
              setOptState((s) => (s === "busy" || s === "rec" ? "idle" : s));
            }
            // [2026-09-22 修·空包] 录音链路偶尔只产出几个字节（浏览器/设备侧异常，老大实测踩到 5 字节）：
            // 这种"音频"既转写不出东西，发出去还是一条空语音消息。低于 1KB 一律判录音失败，绝不外发。
            if (blob.size > 0 && blob.size < 1024) {
              reportVoiceStage("tiny-blob", null, { bytes: blob.size, blobType });
              voiceStopModeRef.current = "send";
              voiceStopHandlerRef.current = null;
              // [2026-09-23 修·同上] 这条死路也不会再走处理器 → busy 必须当场收回，别留给下次录音擦屁股
              setOptState((s) => (s === "busy" || s === "rec" ? "idle" : s));
              setVoiceError("这段录音没录上声音（只有 " + blob.size + " 字节），请重新录一次。");
              if (voiceErrorTimerRef.current !== null) window.clearTimeout(voiceErrorTimerRef.current);
              voiceErrorTimerRef.current = window.setTimeout(() => setVoiceError(null), 6000);
            } else if (blob.size > 0) {
              const recSecs = secondsRef.current;
              // [2026-09-22 防线·老大批准] "录了 19 秒、音频里只有 0.59 秒"这种（iOS 录音被锁屏/切后台掐断，
              // 浏览器只交出开头一小段）以前照发：元数据写 19 秒、转写必然失败、最后糊一条"本地语音文件路径"给用户。
              // 现在发出之前先核音频真实时长，差太多（不足计时的一半）直接拦下、让用户重录。
              void (async () => {
                const realSec = await probeAudioDuration(blob);
                if (realSec !== null && recSecs >= 3 && realSec < recSecs * 0.5) {
                  reportVoiceStage("short-audio-guard", null, { realSec: Number(realSec.toFixed(2)), recSec: recSecs, bytes: blob.size });
                  voiceStopModeRef.current = "send";
                  voiceStopHandlerRef.current = null;
                  // [2026-09-23 修·同上] 被这道防线拦下也永远不会走优化处理器 → 当场收回 ⚡
                  setOptState((s) => (s === "busy" || s === "rec" ? "idle" : s));
                  setVoiceError("这段录音只录到 " + realSec.toFixed(1) + " 秒（你录了 " + recSecs + " 秒），后半段没录上，请重新录一次。");
                  if (voiceErrorTimerRef.current !== null) window.clearTimeout(voiceErrorTimerRef.current);
                  voiceErrorTimerRef.current = window.setTimeout(() => setVoiceError(null), 8000);
                  return;
                }
                // [2026-09-22 新增] ⚡ 语音输入：录音只交给外部处理器（转写+优化+回填），不发送消息。
                if (voiceStopModeRef.current === "voiceopt") {
                  const handler = voiceStopHandlerRef.current;
                  voiceStopHandlerRef.current = null;
                  voiceStopModeRef.current = "send";
                  if (typeof handler === "function") void handler(blob, recSecs * 1000);
                } else {
                  void sendVoiceBlob(blob, recSecs * 1000);
                }
              })();
            }
          };
          recorder.start();
          recorderRef.current = recorder;
          setMicStarting(false); // 流到手：交给正常录音态（红底 + 秒数）
          setRecording(true);
          setSeconds(0);
          timerRef.current = setInterval(() => setSeconds((s) => { secondsRef.current = s + 1; return s + 1; }), 1000);
          voiceStartingRef.current = false;
        } catch (e) {
          voiceStartingRef.current = false;
          setMicStarting(false); // [2026-09-22] 启动失败：把按钮的"启动中"红态收掉
          voiceRecordingActive = false; // 开录失败：别把"禁止播放"的旗标留在 true
          releaseWakeLock(); // [2026-09-22] 开录失败：撤掉屏幕常亮
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
        // [2026-09-20] 发视频按钮：选中的 mp4/webm/mov 走官方 draft 附件桥（onAddFiles），
        // 发送后由 user-video 会话节点渲染成可播放条。
        (() => {
          const onPickVideo = (e) => {
            const f = e.target.files && e.target.files[0];
            if (f && typeof sharedOnAddImages === "function") {
              try { sharedOnAddImages([f]); } catch { /* 官方桥拒绝：交给 chip 兜底显示 */ }
            }
            e.target.value = "";
          };
          return [
            h("button", {
              key: "vidbtn", type: "button", "aria-label": "添加视频", title: "添加视频（mp4/webm/mov）",
              style: circleBtn, ...circleBtnHover(false), onMouseDown: (e) => e.preventDefault(),
              onClick: () => videoFileRef.current?.click(),
            }, h("span", { style: { fontSize: "15px", lineHeight: 1 }, "aria-hidden": "true" }, "🎬")),
            h("input", {
              key: "vidinput", ref: videoFileRef, type: "file",
              accept: "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v",
              multiple: false, hidden: true, onChange: onPickVideo,
            }),
          ];
        })(),
        // [2026-09-21] ⚡ 提示词优化：点击把输入框文本送 /optimize-prompt 精炼回填，再点还原原文。
        (() => {
          // 官方输入框是 Lexical contenteditable（[data-composer-input]），不是 textarea——
          // 读用 innerText（剔零宽原子符），写用 execCommand 走真实 beforeinput，编辑器状态才同步。
          // [2026-09-21 修"写不进去"] 页面里可能有多个 [data-composer-input]（主输入框/隐藏次级框），
          // 以前 querySelector 只拿第一个——若是隐藏那个，写进去也看不见 → 现在挑**可见**的。
          const findEditor = () => {
            const shared = findComposerEl();
            if (shared) return shared;
            let el = rootRef.current ? rootRef.current.parentElement : null;
            while (el && el !== document.body) {
              const ta = el.querySelector && el.querySelector("textarea");
              if (ta) return ta;
              el = el.parentElement;
            }
            return null;
          };
          const getEditorText = (el) => (el.tagName === "TEXTAREA"
            ? String(el.value || "")
            : String(el.innerText || "").replace(/[\u200b\u2060]/g, ""));
          // [2026-09-21 修 bug] 官方输入框是 Lexical 编辑器：execCommand 常被它忽略（DOM 改了但编辑器状态没改，
          // 下一次渲染就回滚）→ 老大实测"点了优化但界面没变化"。改为：写 → 回读验证 → 换招重试 → 全失败就塞剪贴板并明确提示。
          const putSelectionIn = (el) => {
            try {
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              if (!sel) return false;
              sel.removeAllRanges();
              sel.addRange(range);
              return true;
            } catch { return false; }
          };
          const writeViaBeforeInput = (el, value) => {
            try {
              el.focus();
              if (!putSelectionIn(el)) return false;
              el.dispatchEvent(new InputEvent("beforeinput", {
                inputType: "insertText", data: value, bubbles: true, cancelable: true, composed: true,
              }));
              return true;
            } catch { return false; }
          };
          const writeViaExecCommand = (el, value) => {
            try {
              el.focus();
              putSelectionIn(el);
              document.execCommand("insertText", false, value);
              return true;
            } catch { return false; }
          };
          /** [2026-09-21 修追加 bug] 走剪贴板 paste 事件：Lexical 会用它**替换选区**（三个写法里最靠谱的一个）。 */
          const writeViaPaste = (el, value) => {
            try {
              el.focus();
              if (!putSelectionIn(el)) return false;
              const dt = new DataTransfer();
              dt.setData("text/plain", value);
              el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
              return true;
            } catch { return false; }
          };
          /** 经典组合：聚焦后用 execCommand selectAll 选中编辑器内全部，再 insertText 覆盖。 */
          const writeViaSelectAllExec = (el, value) => {
            try {
              el.focus();
              document.execCommand("selectAll", false);
              document.execCommand("insertText", false, value);
              return true;
            } catch { return false; }
          };
          const normTxt = (s) => String(s || "").replace(/[\u200b\u2060]/g, "").replace(/\s+/g, " ").trim();
          const editorHas = (el, value) => normTxt(getEditorText(el)) === normTxt(value);
          /** 清空编辑器：先给选区派发 deleteContentBackward（Lexical 认），不行再 execCommand delete。 */
          const clearEditor = (el) => {
            try {
              el.focus();
              putSelectionIn(el);
              el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true, composed: true }));
              if (normTxt(getEditorText(el)) !== "") document.execCommand("delete", false);
            } catch { /* 尽力 */ }
          };
          /**
           * 写入输入框：**每次尝试前先清空**（否则会在原文后面追加），逐个换招并回读验证；
           * 全部失败时把原文恢复回去，绝不在输入框里留垃圾；返回 false 交给调用方走剪贴板兜底。
           */
          const setEditorText = async (el, value) => {
            // [2026-09-22] ⚡ 写稿是程序化聚焦，给"禁自动聚焦"守卫一张 5 秒免死金牌
            try { window.__dshComposerFocusGraceAt = Date.now(); } catch { /* 忽略 */ }
            if (el.tagName === "TEXTAREA") {
              const d = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
              if (d && d.set) d.set.call(el, value); else el.value = value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.focus();
              return true;
            }
            const snapshot = getEditorText(el);
            const wait = (ms) => new Promise((r) => window.setTimeout(r, ms));
            for (const attempt of [writeViaSelectAllExec, writeViaPaste, writeViaBeforeInput, writeViaExecCommand]) {
              clearEditor(el);
              await wait(60);
              attempt(el, value);
              await wait(220);
              if (editorHas(el, value)) return true;
            }
            // 全失败：先打诊断（下次真失败有据可查），再恢复原文，别把输入框搞脏
            console.warn("[dsh-optimize] 写入输入框未生效，诊断：", {
              tag: el.tagName,
              isComposer: el.hasAttribute("data-composer-input"),
              w: el.getBoundingClientRect ? el.getBoundingClientRect().width : -1,
              before: normTxt(snapshot).slice(0, 30),
              after: normTxt(getEditorText(el)).slice(0, 30),
              want: normTxt(value).slice(0, 30),
            });
            clearEditor(el);
            await wait(60);
            writeViaPaste(el, snapshot);
            await wait(220);
            if (!editorHas(el, snapshot)) {
              try {
                clearEditor(el);
                await wait(60);
                writeViaBeforeInput(el, snapshot);
              } catch { /* 尽力恢复 */ }
            }
            return false;
          };
          // [2026-09-25 /de] 把写入能力挂到模块级，供 commandUi 的 onSelect 调用（组件卸载就收回，避免拿到死节点）。
          sharedComposerFill = async (text) => {
            const el = findEditor() || findComposerEl();
            if (!el) return false;
            return await setEditorText(el, String(text == null ? "" : text));
          };
          const copyClipboard = async (text) => {
            try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
          };
          // [需求① 前端] 抓最近 8~12 条对话当 conversationContext（治"把刚才那个方案优化一下"这类指代）。
          // uiConversation 只提供渲染注册、session 快照里也没有消息数组（父会话已核实），故走 DOM：
          // 官方聊天区容器 [data-chat-flow]，每行 [data-chat-flow-key]，行上带 data-chat-flow-kind / data-chat-turn。
          const collectConversationContext = (maxItems) => {
            try {
              const rows = Array.from(document.querySelectorAll("[data-chat-flow] > [data-chat-flow-key]:not([hidden])"));
              const pick = (el) => String(el.innerText || "").replace(/[\u200b\u2060]/g, "").replace(/\s*\n\s*/g, " ").trim();
              const keep = /^(message|assistant|voice-reply|image-reply)$/i;
              let picked = rows.filter((el) => keep.test(String(el.getAttribute("data-chat-flow-kind") || "")) && pick(el) !== "");
              if (picked.length === 0) picked = rows.filter((el) => pick(el) !== ""); // kind 命名若变，也不至于全空
              let texts = picked.slice(-(maxItems || 12)).map((el) => pick(el).slice(0, 400));
              while (texts.length > 1 && texts.join("\n").length > 4000) texts = texts.slice(1); // 超预算丢最旧
              return texts.join("\n").slice(0, 4000);
            } catch { return ""; }
          };
          // [2026-09-22 新增·⚡空框语音输入] 老大要的用法：输入框空着点 ⚡ = 开始录音；
          // 再点一下 = 停下、转写、优化，把结果放回输入框（不代发、不外发音频）。
          // [2026-09-22 老大定稿·前缀] 用独立的「【语音优化】」，跟麦克风那条（真发音频、带【用户语音】）区分开：
          // 他一眼就知道这条本来就没有语音条。他明确否掉了更长的【用户语音·优化稿】。
          // 配套：判定规则已同步写进 global-persona + openmem —— **见到【语音优化】同样必须 send_voice 回**（也是他说的话）。
          const VOICE_OPT_PREFIX = "【语音优化】";
          const blobToBase64 = (blob) => new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
            r.onerror = () => reject(new Error("读取录音失败"));
            r.readAsDataURL(blob);
          });
      // [2026-09-22 老大实测·不切会话稿子也丢] 挂起草稿后必须有人去填：
      // 组件没卸载 → 上面那个 [sessionId] effect 不会重跑 → 原来没人填，稿子就那么悬着。
      // 这里登记一个"回填等待者"：草稿一挂上就立刻尝试；编辑器没准备好就退避重试，
      // 实在填不进去就明确提示（并把稿子留在控制台可见处），绝不静默吞掉。
      const fillDraft = (draft, draftMeta) => {
        let tries = 0;
        const attempt = () => {
          tries += 1;
          // [2026-09-22 修·TDZ] 这里原来调 findEditor()，但那个函数定义在组件更靠下的位置
          // （约 L1534），本段在它之前执行 → 抛 "findEditor is not defined"，
          // 结果稿子明明优化好了却填不进去。改用下方已定义的 findComposerEl()。
          const ed = findComposerEl();
          if (!ed) {
            if (tries < 12) { window.setTimeout(attempt, 250); return; }
            showOptToast("稿子拿到了，但页面上找不到输入框；稿子已留在控制台，可复制使用。", "warn");
            console.warn("[dsh-optimize] 待回填稿子:", draft);
            return;
          }
          void setEditorText(ed, draft).then((ok) => {
            if (ok) {
              // [2026-09-22 老大实测·回填后横幅"没字"] 统计条跟着稿子一起恢复，
              // 否则横幅只剩一句提示（看着像透明横幅）。
              if (typeof draftMeta === "string" && draftMeta !== "") setOptMeta(draftMeta);
              showOptToast("✅ 上次的稿子已放进输入框（确认后自己按发送）", "ok");
              return;
            }
            if (tries < 12) { window.setTimeout(attempt, 250); return; }
            showOptToast("输入框不接受程序化写入，稿子已留在控制台，可复制使用。", "warn");
            console.warn("[dsh-optimize] 待回填稿子:", draft);
          });
        };
        attempt();
      };
      useEffect(() => {
        // 组件挂载/切回本会话时，先认一次已落盘的草稿。
        const rec = optSessionGet(sessionId);
        if (rec !== null && typeof rec.draft === "string" && rec.draft !== "") {
          const draft = rec.draft;
          const draftMeta = typeof rec.meta === "string" ? rec.meta : undefined;
          optSessionPatch(sessionId, { draft: undefined });
          fillDraft(draft, draftMeta);
        }
        // 之后本页面内任何时刻挂上来的草稿都由这里接手。
        const sid = sessionId === undefined || sessionId === null ? null : String(sessionId);
        if (sid === null) return undefined;
        optRefillWaiters.set(sid, () => {
          const cur = optSessionGet(sid);
          if (cur === null || typeof cur.draft !== "string" || cur.draft === "") return;
          const draft = cur.draft;
          const draftMeta = typeof cur.meta === "string" ? cur.meta : undefined;
          optSessionPatch(sid, { draft: undefined });
          fillDraft(draft, draftMeta);
        });
        return () => { optRefillWaiters.delete(sid); };
      }, [sessionId, optState]);
          // [2026-09-22 老大实测·切走再切回横幅丢失/稿子填错会话] 按会话记账：
          //   sessionId  = 发起这条录音/优化的会话，后面只认它，不认"屏幕现在开的是哪条"；
          //   phase/toast = 写进模块级按会话状态，切走再切回来横幅还在；
          //   draft      = 跑完时用户已不在本会话 → 稿子暂存在本会话名下，回来时自动回填。
          const sessionIdAtStart = sessionId;
          const editorElAtStart = findEditor();               // [2026-09-22] 发起时那个输入框
          const editorKeyAtStart = markOptEditor(editorElAtStart);
          const stillInSession = () => editorKeyAtStart !== null && optEditorAlive(editorKeyAtStart) !== null;
          const runVoiceOptimize = async (blob) => {
              optSessionPatch(sessionIdAtStart, { phase: "busy", draft: undefined });
              optLive.add(String(sessionIdAtStart));
              // [2026-09-22 老大要求·看耗时] 全程计时：听写（ASR）/ 优化各一段 + 总时长，
              // 结束后的横幅直接把统计摆出来（跟文本优化那条一致）。
              const t0 = Date.now();
              let asrMs = 0;
              let optMs = 0;
              let optJson = null;
              try {
                // [2026-09-22] 停录后立刻换成"在转写+优化"，别让"正在录音"那条常驻提示挂在那儿误导人。
                // [2026-09-22 老大要求] 去掉"（稍等）"，改由横幅实时显示已用秒数（startOptElapsed + 渲染处拼接）。
                // [2026-09-22 老大反馈] 结尾三个点被误读成"有字没显示出来"——去掉省略号，秒数就是进度。
                showOptToast("⏳ 正在转文字并优化", "info", true);
                startOptElapsed();
                const b64 = await blobToBase64(blob);
                const asrStart = Date.now();
                const tr = await fetch("/asr/transcribe", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ audioBase64: b64 }),
                });
                const tj = await tr.json().catch(() => null);
                asrMs = Date.now() - asrStart;
                const heard = tj && tj.ok && typeof tj.text === "string" ? tj.text.trim() : "";
                if (heard === "") throw new Error((tj && tj.error) || ("转写失败 HTTP " + tr.status));
                let final = heard;
                // [2026-09-22 老大实测·"优化失败却报成功"] 优化没成功时要如实说明：
                // 之前不管优化成不成，横幅一律写"已转文字并优化"，把原始听写稿说成优化稿。
                let optOk = false;
                let optErr = "";
                try {
                  const optStart = Date.now();
                  const r = await fetch("/optimize-prompt", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: heard, conversationContext: collectConversationContext(12), sessionId: sessionIdAtStart ?? "", source: "voice" }),
                  });
                  const j = await r.json().catch(() => null);
                  optMs = Date.now() - optStart;
                  optJson = j;
                  if (j && j.ok && typeof j.optimized === "string" && String(j.optimized).trim() !== "" && j.fellBack !== true) {
                    final = String(j.optimized).trim();
                    optOk = true;
                  } else {
                    optErr = (j && (j.error || (j.fellBack === true ? "改写稿丢了关键信息，已按原文返回" : ""))) || ("HTTP " + r.status);
                  }
                } catch (e) {
                  optErr = String((e && e.message) || e);
                }
                const payload = VOICE_OPT_PREFIX + final;
                optPairRef.current = null; // 语音稿没有"原文"可还原（原文是录音）
                // [2026-09-22 老大实测·稿子填错会话] 只在"还开着发起这条录音的会话"时才写输入框；
                // 否则稿子挂在本会话名下（draft），切回来由挂载/订阅那段自动回填。
                if (!stillInSession()) {
                  // [2026-09-22 老大实测·回填后横幅"没字"] 稿子走"暂存待回填"这条路时直接 return，
                  // 统计条（字数/耗时/检索）根本没生成 → 回填后横幅只剩一句提示，看着像没字。
                  // 现在把统计条一起算出来、与稿子同时暂存，回填时一并恢复。
                  const heldSecs = (ms) => (ms / 1000).toFixed(1) + "s";
                  const heldTiming = "共 " + heldSecs(Date.now() - t0)
                    + "（听写 " + heldSecs(asrMs) + " + 优化 " + heldSecs(optMs) + "）";
                  const heldMeta = (optJson && optJson.ok === true)
                    ? fmtOptMeta(optJson, heard.length, String(optJson.optimized ?? final).trim().length) + " ｜ " + heldTiming
                    : "语音输入 ｜ 字数 " + heard.length + " ｜ " + heldTiming;
                  optSessionPatch(sessionIdAtStart, { phase: "idle", draft: payload, meta: heldMeta, toast: null });
                  // [2026-09-23 修] 切走暂存这条路原来只挂稿子、不清在途标记 → 该会话永久"live"，
                  // 配上 sync 的 busy 闸门就成了"优化中…"复活币。任务其实早跑完了，标记该摘。
                  optLive.delete(String(sessionIdAtStart));
                  stopOptElapsed();
                  console.info("[dsh-voice-opt] 原输入框已不在页面上（用户切走了），稿子+统计条一起暂存待回填");
                  return;
                }
                const ed2 = optEditorAlive(editorKeyAtStart) || findEditor();
                const wrote = ed2 ? await setEditorText(ed2, payload) : false;
                if (!wrote) {
                  const copied = await copyClipboard(payload);
                  setOptState(copied ? "copy" : "fail");
                  showOptToast(copied ? "转写优化好了，但输入框不接受程序化写入：已复制到剪贴板，Ctrl+V 即可。" : "转写成功但写不进输入框，稿子见控制台。", copied ? "warn" : "err");
                  console.warn("[dsh-voice-opt] 稿子:", payload);
                  window.setTimeout(() => setOptState("idle"), 8000);
                  return;
                }
                setOptState("idle");
                // [2026-09-22] 写成功后收干净按会话状态：免得以后切回这条会话时
                // 又恢复出"优化中…"（这轮已经结束）。
                optLive.delete(String(sessionIdAtStart));
                optSessionClear(sessionIdAtStart);
                // [2026-09-22 老大实测·"稿子已进输入框却报语音输入失败"] 收尾（统计条/横幅）
                // 与写入分开：收尾里任何异常都不许再冒充"整条失败"——稿子明明已经放进去了。
                try {
                  // [2026-09-22 老大要求] 结束横幅带耗时统计：总时长 + 拆开（听写 / 优化），
                  // 另按文本优化那套补上字数/检索行（setOptMeta 会渲染成统计行）。
                  const totalMs = Date.now() - t0;
                  const secs = (ms) => (ms / 1000).toFixed(1) + "s";
                  const timing = "共 " + secs(totalMs) + "（听写 " + secs(asrMs) + " + 优化 " + secs(optMs) + "）";
                  if (optJson && optJson.ok === true) {
                    setOptMeta(fmtOptMeta(optJson, heard.length, String(optJson.optimized ?? final).trim().length) + " ｜ " + timing);
                  } else {
                    setOptMeta("语音输入 ｜ 字数 " + heard.length + " ｜ " + timing);
                  }
                  // [2026-09-22 老大实测·假成功] 优化成没成，横幅说实话，不再一律报"已优化"。
                  if (optOk) {
                    showOptToast("✅ 已转文字并优化，" + timing + "，放进输入框了——确认后自己按发送", "ok");
                  } else {
                    showOptToast("⚠️ 只转成文字了，这次没优化成功（" + (optErr || "未知原因") + "）；"
                      + timing + "，原始听写稿已放进输入框", "warn");
                  }
                } catch (uiErr) {
                  console.error("[dsh-voice-opt] 收尾提示出错（稿子已进输入框）:", uiErr);
                  showOptToast("稿子已放进输入框，但收尾统计出错：" + String((uiErr && uiErr.message) || uiErr), "warn");
                }
              } catch (e) {
                console.error("[dsh-voice-opt] 失败:", e);
                setOptState("fail");
                // [2026-09-22] 失败也报耗时：老大要能看到"这次到底花了多久才失败"。
                const failSecs = ((Date.now() - t0) / 1000).toFixed(1);
                // [2026-09-22] 失败不再只报一句"失败"：把真实错误 + 出错位置一起摆出来，
                // 老大不用开控制台也能把现象转述给我。
                const where = (e && e.stack ? String(e.stack).split("\n")[1] : "") || "";
                showOptToast("语音输入失败：" + String((e && e.message) || e)
                  + "（已用 " + failSecs + "s）" + (where ? " ｜ 位置：" + where.trim().slice(0, 90) : ""), "err");
                console.error("[dsh-voice-opt] 失败位置:", where);
                window.setTimeout(() => setOptState("idle"), 6000);
              }
            };
          const onVoiceOptimize = async () => {
            if (recording || voiceStartingRef.current) {
              // 结束录音：**无论用 ⚡ 还是麦克风按钮停的**，都走"转写+优化+回填"，绝不把录音误发出去。
              // [2026-09-22 修·实测踩坑] 原来只在"再点 ⚡"那条路钉住去向，结果老大用麦克风按钮一停，
              // 走的是老的发送路 → 把那段录音直接发出去了（还正好是 5 字节残包 → 空语音消息）。
              setOptState("busy");
              stopRecording(true);
              return;
            }
            // 开始录音：先把"停下来去哪"钉住，这样用哪颗按钮停都一样。
            voiceStopModeRef.current = "voiceopt";
            voiceStopHandlerRef.current = runVoiceOptimize;
            setOptState("rec");
            // [2026-09-22 老大反馈·横幅慢一两秒] 原句在 await startRecording() 之后：要等 getUserMedia
            // 把麦克风开起来（首次还要等权限弹窗）才有反馈，所以点下去一两秒没动静。挪到启动之前——
            // 点下去立刻出横幅；开录失败的分支再把它收掉，不假装在录。
            showOptToast("🎤 录音中 · 会自动优化你说的内容", "info", true);
            await startRecording();
            if (recorderRef.current === null) { // 开录失败已由 startRecording 自己提示
              setOptToast(null); // 开录失败：收掉刚才那条常驻横幅
              voiceStopModeRef.current = "send";
              voiceStopHandlerRef.current = null;
              setOptState("idle");
              return;
            }
          };
          const onOptimize = async () => {
            // [2026-09-22 新增] 录音中这一下是"停止并转写优化"，必须在 busy 拦截之前处理。
            if (recording) { await onVoiceOptimize(); return; }
            if (optState === "busy" || optState === "rec") return;
            const ed = findEditor();
            const cur = ed ? getEditorText(ed).trim() : "";
            const pair = optPairRef.current;
            // [2026-09-21 修挂死] done 态：空框/找不到输入框/pair 丢失 → 一律归零，绝不静默 return
            if (optState === "done") {
              if (!ed || cur === "") {
                resetOptUi(pair, true, "click:done但框空");
                showOptToast("已发送，优化状态已清空。", "info");
                return;
              }
              if (pair) {
                void setEditorText(ed, pair.original);
                if (!pair.editedReported) { pair.editedReported = true; reportOptFeedback(pair.id, { edited: true }); }
                resetOptUi(pair, false, "click:我还原文了");
                return;
              }
              // done 但 pair 丢了：无法还原，清掉残留按钮
              resetOptUi(null, false, "click:done但pair丢了");
              showOptToast("优化状态已失效，已清空。可重新点 ⚡ 优化当前输入。", "warn");
              return;
            }
            // 其它非 idle 残留态 + 空框：同样归零
            if (optState !== "idle" && (!ed || cur === "")) {
              resetOptUi(pair, optState === "done", "click:残留态且框空");
              return;
            }
            if (!ed) { console.error("[dsh-optimize] composer input not found"); return; }
            // [2026-09-22 新增·⚡空框语音输入] 空框点 ⚡ → 转语音输入（录音→转写→优化→回填）。
            if (cur === "") { await onVoiceOptimize(); return; }
            optPairRef.current = null; // 无成对：以当前文本优化
            setOptState("busy");
            // [2026-09-23 老大实测·文笔优化横幅串味] 上一条（多半是语音那条）的统计行会残留在横幅上：
            // 文本优化原来只在"改成功"分支写 optMeta，"无需改动/漂移/失败"分支不覆盖它 → 用户看到没发生过的
            // "听写 1.9s ｜ 共 11.7s"。发起即清掉旧统计行，并起实时秒数（跟语音那条一致）。
            setOptMeta(null);
            startOptElapsed();
            const textT0 = Date.now();
            // [2026-09-22 老大实测·切走再切回横幅丢失] 文本优化同样按会话记账：
            // 发起会话 = sessionIdAtStart；后台跑着时切走，横幅靠模块级状态保住。
            optSessionPatch(sessionIdAtStart, { phase: "busy", draft: undefined });
            optLive.add(String(sessionIdAtStart));
            // [2026-09-22 D 方案·老大拍板] 点 ⚡ 立刻给"优化中"常驻横幅：原文留在输入框里不动，好了自动替换；
            // 漂移/失败一律原样保留原文。用户不用盯着按钮干等（原来横幅空着，只有按钮上转个圈）。
            showOptToast("⏳ 正在优化…原文还在输入框里，好了自动替换", "info", true);
            try {
              const convCtx = collectConversationContext(12); // [需求①] 指代消解依据：最近 12 条对话
              const r = await fetch("/optimize-prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: cur, conversationContext: convCtx, sessionId: sessionIdAtStart ?? "", source: "text" }),
              });
              const j = await r.json().catch(() => null);
              if (j && j.ok && j.optimized && j.fellBack !== true && normOpt(j.optimized) === normOpt(cur)) {
                // 后端判定"无需润色"（提问/讨论/操作指令）时原样返回：给中性提示，绝不进 done 态骗人。
                // [2026-09-25 老大实测·"显示不用优化"看不懂是谁拦的] 分两种说清：闸门提前拦 vs 改写模型自己没改动。
                const byGate = j.gateSkipped === true;
                let gateMax = null;
                if (byGate) {
                  try {
                    const cd = await (await fetch("/optimize-config")).json();
                    gateMax = Number(cd && cd.config && cd.config.gateMaxLen) || null;
                  } catch { gateMax = null; }
                }
                const gGrade = (j.gate && j.gate.grade) || "L1";
                const gYes = j.gate && Number.isFinite(j.gate.yes) ? "（把握 " + Math.round(j.gate.yes * 100) + "%）" : "";
                const used = ((Date.now() - textT0) / 1000).toFixed(1);
                setOptState("same", byGate ? "闸门拦下" : "改写后与原样相同");
                // [2026-09-23] 也要写统计行：否则这里仍是上一条留下的旧账。
                setOptMeta(byGate
                  ? ("⛔ 前置闸门拦下（没送改写模型）：原文 " + cur.length + " 字 ≤ 门槛 " + (gateMax ?? 40) + " 字 + 判定「" + gGrade + "」" + gYes + " ｜ " + used + "s")
                  : ("改写模型跑完、回来一字未改：这句它判为已够清楚 ｜ 共 " + used + "s"));
                showOptToast(byGate
                  ? ("这次**没进改写**，是前置闸门按字数+判定拦的：原文 " + cur.length + " 字 ≤ 门槛 " + (gateMax ?? 40) + " 字，且判成「" + gGrade + "」。要它照改：设置页「改写前置闸门」旁的数字框把门槛调小（或直接关掉闸门）。")
                  : ("这句进了改写，但模型回来时一字未改 = 它认为原文已经够清楚（跟闸门无关）。"), "info");
                window.setTimeout(() => setOptState("idle", "same提示收回"), 2500);
              } else if (j && j.ok && j.optimized && j.fellBack !== true) {
                optPairRef.current = { original: cur, optimized: j.optimized, id: j.id, drift: j.drift === true, sessionId: sessionIdAtStart };
                try { window.sessionStorage.setItem(OPT_PAIR_KEY, JSON.stringify(optPairRef.current)); } catch { /* 无存储权限 */ }
                const deltaLen = String(j.optimized).trim().length - cur.length;
                setOptDelta(deltaLen);
                // [2026-09-21] 元信息条已含字数 → 不再 toast 重复「已改写：原 X 字…」
                // [2026-09-23] 耗时改用实测墙钟（老大反馈服务端那个数不准）。
                setOptMeta(fmtOptMeta(j, cur.length, String(j.optimized).trim().length, Date.now() - textT0));
                // [2026-09-22 老大实测·稿子填错会话] 只在还开着发起这条优化的会话时才写输入框；
                // 否则稿子挂在会话名下，切回来自动回填（不往别的会话乱塞）。
                // [2026-09-25 治「还原不出现」的源头] stillInSession 查的其实是**发起时那个输入框 DOM
                // 节点还在不在**（markOptEditor/optEditorAlive），harness 一次重渲染就能把它换掉；
                // 于是明明没切会话也被判成"已切走"，稿子改走暂存支路、状态留在 busy，
                // done 没人设 → 1.6 秒后 watchdog 把 busy 打死 → ⚡ 回到闪电，还原看着就丢了。
                // 现在补判据：当前可见输入框里仍是发起时那段原文 = 人还在这条会话、没发送没清空 → 直接回填。
                let edLive = ed;
                if (!stillInSession()) {
                  const cand = typeof findEditor === "function" ? findEditor() : findComposerEl();
                  const candTxt = cand ? getComposerText(cand) : "";
                  if (cand && normOpt(candTxt) === normOpt(cur)) {
                    edLive = cand;
                    console.info("[dsh-optimize] 发起时的输入框节点已被重渲染换掉，但当前框仍是原话 → 按同一会话直接回填");
                  } else {
                    // 真切走了才走暂存：状态明确收回 idle（别再留 busy 给 watchdog 收尸），
                    // 切回这条会话时由 refill 路回填，回填后由下面轮询的"认回 done"补上还原。
                    optSessionPatch(sessionIdAtStart, { draft: String(j.optimized), toast: null });
                    stopOptElapsed();
                    setOptState("idle", "切走已暂存");
                    console.info("[dsh-optimize] 用户已切到别的会话，优化稿暂存待回填");
                    return;
                  }
                }
                const wrote = await setEditorText(edLive, j.optimized);
                if (!wrote) {
                  // 编辑器拒绝程序化写入：绝不装成功——把优化稿塞剪贴板，让用户 Ctrl+V 直接覆盖
                  console.warn("[dsh-optimize] 写入输入框失败（Lexical 拒绝程序化插入），已转剪贴板兜底");
                  const copied = await copyClipboard(j.optimized);
                  setOptState(copied ? "copy" : "fail");
                  showOptToast(copied
                    ? "输入框不接受程序化改写，优化稿已复制到剪贴板：在输入框里按 Ctrl+V 覆盖即可。"
                    : "写入输入框失败、复制到剪贴板也失败，请去控制台手动取优化稿。", copied ? "warn" : "err");
                  window.setTimeout(() => setOptState("idle"), 8000);
                  return;
                }
                setOptState("done", "优化成功已回填");
                // [D 方案] 优化稿已自动替换进输入框：明确说"换好了"，并点出可以还原。
                showOptToast("✅ 优化好了，已替换输入框里的原文", "ok");
              } else if (j && j.ok && j.fellBack === true) {
                // 硬事实（数字/占位符/禁令）丢了才退回原文：明确告诉用户丢了什么
                const lost = (j.driftReport && Array.isArray(j.driftReport.lost)) ? j.driftReport.lost.join("、") : "";
                console.warn("[dsh-optimize] 硬事实丢失/残稿，已按原文返回: " + JSON.stringify(j.driftReport || {}));
                setOptState("drift");
                setOptMeta("改写稿丢了关键信息，已按原文返回 ｜ 共 " + ((Date.now() - textT0) / 1000).toFixed(1) + "s");
                // [2026-09-23] 后端体量闸门命中的残稿（模型只答了个"对，"）要说清是哪种，别让用户以为丢了数字。
                showOptToast(j.collapsed === true
                  ? "模型把这条当成对话应答了（只回了几个字）：已保留你的原文，没有替换。"
                  : ("改写稿丢了关键信息" + (lost ? "（" + lost + "）" : "") + "，已按原文返回，避免改坏。可在设置页关掉 AI 漂移判定。"), "warn");
                window.setTimeout(() => setOptState("idle"), 3000);
              } else {
                const msg = (j && j.error) || ("HTTP " + r.status);
                console.error("[dsh-optimize] 优化失败: " + msg);
                setOptState("fail");
                setOptMeta("优化失败 ｜ 共 " + ((Date.now() - textT0) / 1000).toFixed(1) + "s");
                showOptToast("优化失败：" + msg, "err");
                window.setTimeout(() => setOptState("idle"), 2500);
              }
            } catch (e) {
              console.error("[dsh-optimize] 优化失败: " + (e && e.message));
              setOptState("fail");
              setOptMeta("优化失败 ｜ 共 " + ((Date.now() - textT0) / 1000).toFixed(1) + "s");
              showOptToast("优化失败：" + String((e && e.message) || e), "err");
              window.setTimeout(() => setOptState("idle"), 2500);
            } finally {
              // [2026-09-23 修·地雷本体] 文本优化以前只 optLive.add、**从不 delete**，会话记录里也一直留着
              // phase:"busy" —— 于是这条会话此后每次 sync 都被合法恢复成"优化中…"（sync 只放行 busy && live，
              // 而 live 被这次泄漏永久坐实），⚡ 从此点不动（onOptimize 见 busy 直接 return）。收尾无条件清两处。
              optLive.delete(String(sessionIdAtStart));
              optSessionPatch(sessionIdAtStart, { phase: "idle" });
            }
          };
          if (typeof document !== "undefined" && !document.getElementById("dsh-opt-style")) {
            const st = document.createElement("style");
            st.id = "dsh-opt-style";
            st.textContent = "@keyframes dsh-opt-spin{to{transform:rotate(360deg)}}";
            document.head.appendChild(st);
          }
          // [2026-09-21 老大要求] 每个状态都给文字（不再光秃秃一个感叹号），另配半透明悬浮提示讲人话。
          // [2026-09-21 老大要求] 提示不许压住输入框：改成**贴在输入框正上方、横向铺开**（与附件预览同位置）。
      // [2026-09-22 老大实测·优化完横幅"变透明、一个字都没有"] 横幅只在 (统计条||提示) 非空时渲染，
      // 所以"空横幅"= 两个状态被清空了。这里加渲染自证日志：下次出现直接把 [dsh-opt-banner] 发我。
      try {
        if (optMeta !== null || optToast !== null) {
          console.info("[dsh-opt-banner] state=" + optState
            + " meta=" + (optMeta === null ? "null" : "有(" + String(optMeta).length + "字)")
            + " toast=" + (optToast === null ? "null" : "有")
            + " elapsed=" + String(optElapsed));
        } else if (optState !== "idle") {
          console.info("[dsh-opt-banner] 空横幅：state=" + optState + " meta=null toast=null（这就是你说的'横幅没字'）");
        }
      } catch { /* 控制台不可用 */ }
      // [2026-09-22] 修"切走再切回、横幅变空"：sync 不能把本地已有的统计条/提示清成空。
      // 只信"会话记录里明确有的值"，记录里没有的不动本地状态。
      const composerEl = (typeof document !== "undefined") ? findComposerEl() : null;
          const cRect = composerEl && composerEl.getBoundingClientRect ? composerEl.getBoundingClientRect() : null;
          // [2026-09-22 修·横幅宽度（两轮反馈合并）] ①先"手机上显示不全"：按输入框算 + fixed 因祖先
          // transform 退化成相对祖先 → 右侧被裁；②后"比输入框还长"：窄屏改成左右 inset 铺满整屏。
          // 现在 portalToBody 已经把 fixed 修回相对视口，于是统一**按输入框宽度对齐**，只夹两道：
          // 不超视口、桌面不超 720（窄屏就是输入框实际宽度）。
          // [2026-09-22 老大反馈·手机放大后横幅偏位] 上面这套用的是 layout viewport（innerWidth /
          // getBoundingClientRect），而用户放大页面看到的是 visual viewport：fixed 元素按 layout 坐标摆，
          // 在放大后的可视区里就整体偏掉、看着"超出输入框"。这里改用 visualViewport 的尺寸+偏移来算：
          // 先把输入框换算到可视区坐标，夹好之后再偏回去（fixed 用的仍是 layout 坐标）。
          const vv = (typeof window !== "undefined" && window.visualViewport) ? window.visualViewport : null;
          const vvLeft = vv ? vv.offsetLeft : 0;
          const vvTop = vv ? vv.offsetTop : 0;
          const vw = vv ? vv.width : ((typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 900);
          const vh = vv ? vv.height : ((typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800);
          const narrow = vw < 640;
          const bannerW = cRect
            ? Math.max(narrow ? 200 : 280, Math.min(cRect.width, narrow ? vw - 16 : 720))
            // [2026-09-22 老大拍板] 认不出输入框时**宁可窄，不许满屏**（原来窄屏直接铺满 vw-16，
            // 看着就像"超出输入框"）。窄屏按 280（≈手机输入框宽度），桌面 560。
            : Math.min(narrow ? 280 : 560, vw - 16);
          // [2026-09-22 实测结论·两版都试过] 去掉 vv.offsetLeft 那版（纯可视区坐标）老大实测**更糟**
          // （既不贴输入框也不在屏幕中间）→ 说明本机 iOS 的 position:fixed 实际按 **layout viewport**
          // 摆放，必须把可视区偏移加回去。故维持"夹好可视区坐标 + 加回 vvLeft"。
          const bannerLeft = (cRect
            ? Math.max(8, Math.min(cRect.left - vvLeft, vw - 8 - bannerW))
            : (narrow ? 8 : 16)) + vvLeft;
          const TOAST_STYLE = {
            position: "fixed", zIndex: 200,
            left: bannerLeft + "px",
            width: bannerW + "px",
            maxWidth: Math.max(120, vw - 16) + "px",
            boxSizing: "border-box",
            bottom: (cRect ? Math.max(8, vvTop + vh - cRect.top + 8) : 96) + "px",
            padding: "8px 10px", borderRadius: "8px", fontSize: "12px", lineHeight: 1.6,
            background: "rgba(24,28,36,.88)", color: "#e6e9ef",
            border: "1px solid rgba(255,255,255,.16)",
            backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
            boxShadow: "0 6px 20px rgba(0,0,0,.35)", whiteSpace: "normal", wordBreak: "break-word", textAlign: "left",
          };
          const TOAST_ACCENT = { info: "#9aa3ad", ok: "#34c759", warn: "#f5a623", err: "#ff5f57" };
          // [2026-09-22 老大实测·横幅被撑高的输入框挡住（ResizeObserver 仍未根治）]
          // 横幅显示期间**自我校正位置**：每 800ms 按输入框当前 rect 重算 bottom。
          // 定位实时用最新 rect，不依赖任何观察器是否触发/是否被节流。
          const setToastNode = (el) => {
            if (el === null || el === undefined) return;
            const prev = el.__dshToastFix;
            if (prev) window.clearInterval(prev);
            const fix = () => {
              try {
                const c = findComposerEl();
                const r = c && c.getBoundingClientRect ? c.getBoundingClientRect() : null;
                const v = (typeof window !== "undefined" && window.visualViewport) ? window.visualViewport : null;
                const vTop = v ? v.offsetTop : 0;
                const vH = v ? v.height : ((typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800);
                if (r) el.style.bottom = Math.max(8, vTop + vH - r.top + 8) + "px";
              } catch { /* 拿不到输入框就维持原位置 */ }
            };
            fix();
            el.__dshToastFix = window.setInterval(fix, 800);
          };
          const wide = { width: "auto", padding: "0 10px" };
          const optLabel =
            optState === "busy" ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", lineHeight: 1, whiteSpace: "nowrap" } },
              h("span", { style: { display: "inline-block", animation: "dsh-opt-spin 0.9s linear infinite" } }, "🔄"), "优化中…")
              : optState === "done" ? h("span", { style: { fontSize: "12px", lineHeight: 1, whiteSpace: "nowrap" } },
                // [2026-09-25 老大实测·"（+36字）一眼看不懂"] 按钮只说动作。字数增减本来就在输入框上方
                // 那条元信息里（"字数 12 → 48（+36）"），塞在「还原」后面反而像在说还原会加字。
                "↩ 还原原文")
                : optState === "copy" ? h("span", { style: { fontSize: "12px", lineHeight: 1, whiteSpace: "nowrap" } }, "📋 已复制，请 Ctrl+V 覆盖")
                  : optState === "same" ? h("span", { style: { fontSize: "12px", lineHeight: 1, whiteSpace: "nowrap" } }, "原文已够清楚，未改动")
                    : optState === "drift" ? h("span", { style: { fontSize: "12px", lineHeight: 1, whiteSpace: "nowrap" } }, "⚠ 关键信息会丢，已按原文")
                      : optState === "fail" ? h("span", { style: { fontSize: "12px", lineHeight: 1, whiteSpace: "nowrap" } }, "✗ 优化失败")
                        : optState === "rec" ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px", fontWeight: 600 } },
                          h("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: "#fff", display: "inline-block" } }),
                          `${seconds}s`)
                          : h("span", { style: { fontSize: "15px", lineHeight: 1 }, "aria-hidden": "true" }, "⚡");
          // [2026-09-22 修·手机横幅右侧被顶出屏幕] 横幅用的是 position:fixed；只要它的祖先带
          // transform（工具栏/槽位常见），固定定位就会退化成"相对该祖先"，于是怎么设宽度都会被顶出去。
          // 把它 portal 到 document.body：固定定位真正相对视口，窄屏的左右 inset 才会生效。
          const portalToBody = (node) => {
            try {
              if (reactDom && typeof reactDom.createPortal === "function" && typeof document !== "undefined" && document.body) {
                return reactDom.createPortal(node, document.body);
              }
            } catch { /* 拿不到 react-dom：退化到原位渲染 */ }
            return node;
          };
          return h("span", { key: "optwrap", style: { position: "relative", display: "inline-flex", alignItems: "center" } },
            h("button", {
              key: "optbtn", type: "button",
              "aria-label": optState === "idle" ? "优化提示词（输入框空着时=语音输入）" : optState === "rec" ? "录音中，点击结束并转写优化" : "提示词优化状态：" + optState,
              title: optState === "rec" ? "录音中：点我结束，然后自动转写+优化并放进输入框（不代发）" : optState === "busy" ? "正在优化…" : optState === "done" ? "点击还原为原文" : optState === "copy" ? "输入框不接受程序化写入：优化稿已复制到剪贴板，在输入框里 Ctrl+V 覆盖即可" : optState === "same" ? "原文已足够明确，无需润色（这类消息不改写）" : optState === "drift" ? "改写稿丢了关键信息（数字/占位符/禁令），已按原文返回" : optState === "fail" ? "优化失败（详情见控制台，或看悬浮提示）" : "精炼输入框提示词",
              style: {
                ...circleBtn,
                ...(optState === "busy" ? { opacity: 0.8, ...wide } : {}),
                ...(optState === "same" ? { background: "rgba(128,128,128,.18)", color: "inherit", ...wide } : {}),
                ...(optState === "copy" ? { background: "#f5a623", color: "#1a1a1a", ...wide } : {}),
                ...(optState === "done" ? { background: "#2f6feb", color: "#fff", ...wide } : {}),
                ...(optState === "drift" ? { background: "#f5a623", color: "#1a1a1a", ...wide } : {}),
                ...(optState === "fail" ? { background: "#e5484d", color: "#fff", ...wide } : {}),
                // [2026-09-22 老大定稿·录音态] ⚡ **标红** + 按钮上显示秒数 + 旁边弹 ✕ 取消（跟麦克风那套一致）；
                // 麦克风在 ⚡ 录音期间不红、也不重复出秒数/叉。
                ...(optState === "rec" ? { background: "#e5484d", color: "#fff", ...wide } : {}),
              },
              // [2026-09-22] 非 idle 时按钮有专用底色（录音红 / busy / done 蓝 / copy·drift 橙 / fail 红），
              // 一律不许 hover handler 去碰底色——否则手指一移开就被写成灰底（用户看到"红按钮变黑"）。
              ...circleBtnHover(optState !== "idle"),
              onMouseDown: (e) => e.preventDefault(),
              onClick: () => { void onOptimize(); },
            }, optLabel),
            // [2026-09-22 老大定稿] 取消改成"跟麦克风那套一样"：⚡ 录音时**紧挨着弹出一个 ✕**，
            // 点它丢弃录音。横幅去掉（秒数与取消已在 ⚡ 这一处，留着就重复）。
            (optState === "rec") ? h("button", {
              key: "optcancel", type: "button", "aria-label": "取消录音", title: "取消录音",
              style: { ...circleBtn, marginLeft: "4px", flex: "none" }, ...circleBtnHover(false),
              onMouseDown: (e) => e.preventDefault(),
              onClick: () => { stopRecording(false); setOptState("idle"); showOptToast("已取消录音。", "info"); },
            }, cancelIcon) : null,
            // [2026-09-21] 状态条：统计行 + 绿色操作提示（不再和 toast 重复报字数）
            (optMeta || optToast) ? portalToBody(h("div", {
              "data-dsh-opt-toast": "1",
              ref: setToastNode,
              style: {
                ...TOAST_STYLE,
                // [2026-09-22 修] 宽度一律继承 TOAST_STYLE（已按输入框宽度夹好，见上面 bannerW/bannerLeft），
                // 这里不再二次覆盖——上一版就是在这里给窄屏铺满整屏，才出现"比输入框还长"。
                background: "rgba(22,26,34,.88)",
                border: "1px solid rgba(255,255,255,.10)",
                borderLeft: "3px solid #34c759",
                boxShadow: "0 2px 10px rgba(0,0,0,.28)",
                backdropFilter: "blur(6px)",
                WebkitBackdropFilter: "blur(6px)",
                color: "#e6e9ef",
                fontSize: "12px",
                lineHeight: 1.55,
                padding: "6px 10px",
                pointerEvents: "none",
                whiteSpace: "normal",
                wordBreak: "break-word",
              },
            },
              optMeta ? h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "8px" } },
                h("span", null, optMeta),
              ) : null,
              // 其它状态的 toast（失败/剪贴板/漂移等）仍显示，不与字数重复
              // [2026-09-22] optElapsed 非 null 时尾巴上掛实时秒数（录音优化处理中：每秒 +1）。
              // [2026-09-22 老大反馈] 秒数用括号紧贴正文（原来是全角空格分隔，看着不舒服）。
              // [2026-09-25 老大实测·「看不到最后汇报结果的横幅」] 原来这个条件把 kind==="ok" 整个排除，
              // 于是"✅ 优化好了，已替换输入框里的原文"这类**结果汇报永远不上屏**，跑完只剩一行字数统计。
              // 现在一律渲染（绿色），6 秒后仍按原规则自动收起；常驻横幅继续带秒数。
              optToast ? h("div", {
                style: { marginTop: (optMeta || optState === "done") ? "4px" : "0", color: TOAST_ACCENT[optToast.kind] || "#c9d0d8" },
              }, optToast.text + (optElapsed === null ? "" : "（已 " + optElapsed + "s）")) : null,
            )) : null,
          );
        })(),
        voiceSupported && h("button", {
          type: "button",
          // [2026-09-22 老大反馈·"点完不立刻变红、反应慢"] micStarting（还没拿到麦克风流）也算"已在录音"：
          // 手指一按立刻红，不再等 getUserMedia（首次还要等权限弹窗）。
          "aria-label": (recording || micStarting) ? "停止并发送" : "录音",
          title: (recording || micStarting) ? "停止并发送" : "录音",
          style: { ...circleBtn, ...((recording || micStarting) && optState !== "rec" ? { background: "#e5484d", color: "#fff" } : {}) },
          ...circleBtnHover(recording || micStarting),
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => { if (recording) stopRecording(true); else if (!micStarting) void startRecording(); },
        }, recording
          // [2026-09-22 老大要求] ⚡ 录音态由横幅统一显示"录音中 · N 秒 + 取消"，麦克风这颗不再重复
          // 显示 ●秒数、也不再重复出叉——全屏只有一个秒数、一个取消。
          ? (optState === "rec" ? micIcon : h("span", {
              style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px", fontWeight: 600 },
            }, h("span", {
              style: { width: "6px", height: "6px", borderRadius: "50%", background: "#fff", display: "inline-block" },
            }), `${seconds}s`))
          : micIcon),
        recording && optState !== "rec" && h("button", {
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
          // [2026-09-26 案3] 服务端已插件化（lib/balance.js）且零状态：provider
          // 由模型 store 的 current 前缀显式携带（gw/volc-ark/deepseek-official…）。
          const url = new URL("/api/balance", window.location.origin);
          if (sessionId) url.searchParams.set("sessionId", String(sessionId));
          try {
            const store = getModelStore ? getModelStore() : undefined;
            const cur = store?.getSnapshot?.().current;
            const prov = typeof cur === "string" ? cur.split("/")[0]
              : (typeof cur === "object" && cur !== null ? String(cur.provider ?? cur.id ?? "").split("/")[0] : "");
            if (prov !== "") url.searchParams.set("provider", prov);
          } catch { /* 拿不到就按官方余额兜底 */ }
          const res = await fetch(url, { credentials: "same-origin" });
          if (!res.ok) return;
          const value = await res.json();
          setGatewayHealthy(value.gatewayHealthy ?? null);
          setBalance(value.balance ?? null);
          setUsage(value.usage ?? null);
          setVisible((value.balance ?? null) !== null || (value.usage ?? null) !== null);
          setLoaded(true);
        } catch { /* 静默 */ }
      }, [sessionId, getModelStore]);
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

    // ── [2026-09-21] 设置页：提示词优化分区（settings.section，读写 ~/.dsh/optimize-config.json）──
    // 四张卡：模型（服务商→模型，来自 DSH 自己配置）｜润色强度｜行为开关｜运行透视。
    // [2026-09-21 排版返工] 老大骂了两轮"光秃秃分割线、看着不明显"→ 全面改用左彩条卡片（同语音设置页风格）。
    // [2026-09-21 说明返工] 老大："?" 浮层反应慢、还被遮挡 → **撤销本分区所有 ? 浮层**，
    //   说明一律写成标题/条目**正下方的 dim 小字**（同「图片识别」页那种标题+下方小字写法），常显、不用悬停。
    /* ── [2026-09-25 老大定稿] 设置页「决策模型」分区 ─────────────────────────────
     * 这一族模型（jev / SystemOne 同族）只回概率、不生成文本，⚡ 改写前置闸门与 /de 的判断排序都靠它。
     * 老大明确要求：**模型是直接选的，不许用户填地址密钥** —— 所以这里只有一个下拉（预设清单）
     * 加一个「测一下」；当前生效的地址/模型/有没有取到 key 只读展示，key 永不明文回显。
     * 排版沿用 ⚡ 分区那套（同行副标题 + 卡片 + dim 小字说明）。 */
    function DecisionModelSection() {
      const [cur, setCur] = useState(null);
      const [presets, setPresets] = useState([]);
      const [saving, setSaving] = useState(false);
      const [saved, setSaved] = useState(false);
      const [err, setErr] = useState(null);
      const [testing, setTesting] = useState(false);
      const [probe, setProbe] = useState(null);
      const [keyInput, setKeyInput] = useState("");
      const dim = { fontSize: "11px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", lineHeight: 1.5 };
      const box = { background: "rgba(0,0,0,.25)", border: "1px solid rgba(128,128,128,.2)", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", lineHeight: 1.7, fontFamily: "ui-monospace, Consolas, monospace", wordBreak: "break-all" };
      const ctl = { background: "rgba(128,128,128,.08)", border: "1px solid rgba(128,128,128,.25)", borderRadius: "6px", padding: "5px 9px", fontSize: "12px", color: "inherit", minWidth: "0" };
      const btn = { border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "12px", fontWeight: 600, background: "rgba(124,92,255,.22)", color: "inherit", cursor: "pointer" };
      const load = () => {
        fetch("/decision-config").then((r) => r.json()).then((d) => {
          if (!d?.ok) { setErr((d && d.error) || "读不到决策模型配置"); return; }
          setPresets(d.presets || []); setCur(d.current || null); setErr(null);
        }).catch((e) => setErr(String((e && e.message) || e)));
      };
      useEffect(load, []);
      const apply = async (patch) => {
        setSaving(true); setErr(null); setSaved(false);
        try {
          const r = await fetch("/decision-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
          const d = await r.json().catch(() => null);
          if (d?.ok) { setCur(d.current); setSaved(true); setKeyInput(""); window.setTimeout(() => setSaved(false), 1800); }
          else setErr((d && d.error) || ("http " + r.status));
        } catch (e) { setErr(String((e && e.message) || e)); }
        setSaving(false);
      };
      const test = async () => {
        setTesting(true); setProbe(null); setErr(null);
        try {
          const r = await fetch("/decision-config/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          const d = await r.json().catch(() => null);
          setProbe(d || { ok: false, error: "无返回" });
        } catch (e) { setErr(String((e && e.message) || e)); }
        setTesting(false);
      };
      if (cur === null) {
        return h("div", { style: { padding: "16px", fontSize: "13px", color: "#9aa3ad" } }, err ? "决策模型配置读取失败：" + err : "决策模型配置加载中…");
      }
      const needKey = cur.preset !== "aliyun";
      return h("div", { style: { padding: "16px", display: "flex", flexDirection: "column", gap: "12px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
          h("div", { style: { fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "🧠 决策模型（快判断）"),
          h("span", { style: { fontSize: "11px", fontStyle: "italic", color: "#9aa3ad" } }, "只回概率不生成文本 · 单次 40~90ms · ⚡ 闸门与 /de 判断排序都用它"),
          h("div", { style: { flex: "1" } }),
          saved ? h("div", { style: { color: "#34c759", fontSize: "12px" } }, "✅ 已切换") : null,
          err ? h("div", { style: { color: "#e5484d", fontSize: "12px" } }, err) : null,
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h("div", { style: { fontSize: "12.5px", fontWeight: 600 } }, "选一家（默认阿里云百炼，已给你选好，不用填任何东西）"),
          h("select", {
            style: { ...ctl, maxWidth: "520px" }, value: cur.preset, disabled: saving,
            onChange: (e) => void apply({ preset: e.target.value }),
          }, presets.map((p) => h("option", { key: p.id, value: p.id }, p.label + " — " + p.note))),
          h("div", { style: dim }, "这一族的地址和协议是绑死的（POST …/systemone），所以只让你选，不让你填。"),
        ),
        h("div", { style: box },
          "当前生效：", cur.label, "\n",
          "地址：", cur.url, "\n",
          "模型：", cur.model, "\n",
          "密钥：", cur.hasKey ? "✅ 已取到（不回显明文）" : "❌ 没取到 —— ⚡ 闸门与 /de 判断会静默降级（不影响正常对话）",
          cur.manualUrl ? "\n注意：地址被手工覆盖过（decisionUrl），要回到预设就在上面重新选一次并清掉覆盖" : "",
        ),
        needKey ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", maxWidth: "520px" } },
          h("div", { style: { fontSize: "12.5px", fontWeight: 600 } }, "这家需要你自己的 API Key（阿里云那家不需要）"),
          h("div", { style: { display: "flex", gap: "8px" } },
            h("input", { type: "password", style: { ...ctl, flex: 1 }, placeholder: "留空=不改；保存后只显示已保存，不再回显", value: keyInput, onChange: (e) => setKeyInput(e.target.value) }),
            h("button", { style: btn, disabled: saving || keyInput.trim() === "", onClick: () => void apply({ key: keyInput.trim() }) }, "保存 key"),
            cur.hasKey ? h("button", { style: { ...btn, background: "rgba(229,72,77,.18)" }, disabled: saving, onClick: () => void apply({ clearKey: true }) }, "清除") : null,
          ),
        ) : null,
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
          h("button", { style: btn, disabled: testing, onClick: () => void test() }, testing ? "测着…" : "测一下（发一道真题看通不通）"),
          probe ? h("span", { style: probe.ok ? { color: "#34c759", fontSize: "12px" } : { color: "#e5484d", fontSize: "12px" } },
            probe.ok
              ? ("✅ " + probe.ms + "ms · 判定 " + Number(probe.noul).toFixed(2) + "（该题正确答案应偏高）· " + probe.model)
              : ("❌ " + (probe.error || "失败") + " · " + probe.model)) : null,
        ),
        h("div", { style: dim }, "切完立即生效（每次判断都实时读配置），不用重启 dsh-web。"),
      );
    }

    function PromptOptimizeSection() {
      const [cfg, setCfg] = useState(null);
      const [groups, setGroups] = useState([]);
      const [effModel, setEffModel] = useState("");
      const [unlocked, setUnlocked] = useState(false);
      const [saving, setSaving] = useState(false);
      const [saved, setSaved] = useState(false);
      const [err, setErr] = useState(null);
      const [info, setInfo] = useState(null);
      const [last, setLast] = useState(null);
      const [view, setView] = useState("last");   // "" | "last" | "prompt"（默认展开"最近一次"，让效果看得见）
      // [本地改造 2026-09-25] 原 STRENGTHS 三档说明随设置页强度选择器一起摘掉（全文件零引用），
      // 宿主端 strength 字段仍接受，只是界面不再摆这一排。
      const TOGGLES = [
        ["useContext", "注入最近对话", "带上最近几轮对话，用来消解「这个/那个」。关掉=只看这一句。"],
        ["useOpenmem", "读 openmem", "画像+记忆可作参考，但改写以原文和对话上下文为准，不把无关历史写进去。关掉=完全不读。"],
        ["retrievalRewrite", "检索先改写", "口语先改成好搜的短句再查记忆；命中仅作参考，不改写成记忆里的事。"],
        // [本地改造 2026-09-24 老大] 撤掉「AI 漂移判定」开关：默认关、没人会开，多花约 2 秒只拖速度。
      // 宿主端 driftCheck 字段与 DRIFT_SYSTEM 链路保留（以后想接阿里的 decision-model-preview 做这活，
      // 是把这次判定换快模型，而不是把它重新摆回设置页）。
        // [2026-09-25 判断模型] 与上面撤掉的"AI 漂移判定"正好相反：那个是多花 2 秒拖速度，这个是花 0.2 秒**省掉整轮改写**。
        ["gateCheck", "改写前置闸门", "花约 0.2 秒先问一句「这句值不值得改写」，判定不值得就直接原样返回（实测 188 条历史输入：可跳 17%、省总等待 16.6%、真误杀 0 条）。关掉=每句都送大模型。"],
        ["logUsage", "采用率日志", "每次优化记一行到 optimize-log.jsonl。"],
      ];
      // [2026-09-25] 闸门只对"够短的句子"生效：实测有把「模板名 {{project}} 别改，9 个镜头…」误判成 L1 的例子，
      // 全靠这道长度阀兜住 —— 想调大先拿 optimize-log 里的 gate 字段回测，别直接拆。
      const GATE_NUMBERS = [
        ["gateMaxLen", "闸门只管 ≤ 这么多字", "超过这个字数的输入一律照常改写（保命阀，默认 40）"],
      ];
      const btnSm = { border: "none", borderRadius: "6px", padding: "4px 12px", fontSize: "12px", fontWeight: 600, background: "rgba(128,128,128,.15)", color: "inherit", cursor: "pointer" };
      const dim = { fontSize: "11px", color: "var(--dsw-alias-label-secondary,#9aa3ad)", lineHeight: 1.5 };
      const lab = { fontSize: "13px", fontWeight: 600 };
      // ── 卡片（本分区自用；与语音页 vCard 同款：左彩条 + 图标底 + 轻染底色）──
      // 说明小字 helper：标题正下方第二行 dim 小字（老大点名的写法，永远可见、不用悬停）
      const sub = (text, extra) => text ? h("div", { style: { ...dim, marginTop: "2px", ...(extra || {}) } }, text) : null;
      // 卡片标题行：图标 + 主标题（+ 右侧自定义节点）
      const cardTitle = (title, accent, right) => h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
        h("span", { style: { display: "inline-flex", width: "22px", height: "22px", borderRadius: "6px", background: accent + "2e", alignItems: "center", justifyContent: "center", color: accent, flex: "none" } }, boltIcon),
        h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, title),
        right || null,
      );
      // [本地改造 2026-09-24 老大] 本分区每张卡各加收起/展开（与语音页 vCard 同手感），标题行整行可点。
      // 收成什么样记在 localStorage，下次进设置页还是你上次收的样子；默认全部展开。
      const CARD_STORE_KEY = "dsh.optimizeCardsOpen";
      const readCardStore = () => {
        try { const raw = globalThis.localStorage?.getItem(CARD_STORE_KEY); return raw ? JSON.parse(raw) : {} } catch { return {} }
      };
      const [cardOpen, setCardOpen] = useState(readCardStore);
      const cardIsOpen = (title) => cardOpen[title] !== false;
      const toggleCardOpen = (title) => setCardOpen((prev) => {
        const next = { ...prev, [title]: prev[title] === false };
        try { globalThis.localStorage?.setItem(CARD_STORE_KEY, JSON.stringify(next)) } catch { /* 无 localStorage 就不记，收起功能照常 */ }
        return next;
      });
      // 一张卡：title + titleSub（标题下小字）+ children（内容）；标题行点击收起/展开
      const optCard = (title, titleSub, accent, children, right) => {
        const open = cardIsOpen(title)
        return h("div", {
          style: {
            border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderLeft: "3px solid " + accent,
            borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px",
            background: accent + "12",
          },
        },
          h("div", {
            title: open ? "点击收起这一块" : "点击展开这一块",
            onClick: () => toggleCardOpen(title),
            style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", cursor: "pointer" },
          },
            h("span", { style: { fontSize: "10px", lineHeight: "1", color: accent, flex: "none", display: "inline-block", transform: open ? "none" : "rotate(-90deg)" } }, "▾"),
            cardTitle(title, accent, right),
          ),
          open ? sub(titleSub) : null,
          open ? children : null,
        )
      }
      // 单条设置：名称 + 控件 + 正下方说明小字（紧凑条目，用于开关/下拉）
      const optRow = (labelText, node, hint, key) => h("div", { key: key || labelText, style: { display: "flex", flexDirection: "column", gap: "4px" } },
        typeof labelText === "string" ? h("div", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, labelText) : labelText,
        node,
        sub(hint),
      );
      const code = { background: "rgba(0,0,0,.25)", border: "1px solid rgba(128,128,128,.2)", borderRadius: "6px", padding: "10px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "12px", lineHeight: 1.7, fontFamily: "ui-monospace, Consolas, monospace", maxHeight: "300px", overflow: "auto" };
      // [2026-09-21 撤销] 原 QTip / q() 悬停浮层已删——本分区说明改为常显的 dim 小字（见 sub/optRow）。
      const load = () => {
        fetch("/optimize-config").then((r) => r.json()).then((d) => {
          if (!d?.ok) return;
          setCfg(d.config || {});
          setEffModel(d.effectiveModel || d.defaultModel || "DV4F");
        }).catch(() => {});
        fetch("/optimize-models").then((r) => r.json()).then((d) => { if (d?.ok) setGroups(d.groups || []); }).catch(() => {});
        fetch("/optimize-inspect/prompt").then((r) => r.json()).then((d) => { if (d?.ok) setInfo(d); }).catch(() => {});
        fetch("/optimize-inspect/last").then((r) => r.json()).then((d) => { if (d?.ok) setLast(d.last); }).catch(() => {});
      };
      useEffect(() => { load(); }, []);
      if (cfg === null) {
        return h("div", { style: { padding: "16px", fontSize: "13px", color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "提示词优化配置加载中…");
      }
      const save = async (patch) => {
        setSaving(true); setErr(null);
        try {
          const r = await fetch("/optimize-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
          const d = await r.json().catch(() => null);
          if (d?.ok) {
            setCfg(d.config || cfg);
            if (d.effectiveModel) setEffModel(d.effectiveModel);
            setSaved(true); window.setTimeout(() => setSaved(false), 1800);
          } else { setErr((d && d.error) || ("http " + r.status)); }
        } catch (e) { setErr(String((e && e.message) || e)); }
        setSaving(false);
      };
      const curGroup = groups.find((g) => g.provider === (cfg.provider || "")) || null;
      const modelOptions = curGroup ? curGroup.models : groups.flatMap((g) => g.models);
      const modelLabel = (m) => (m.name && m.name !== m.id ? m.name + " · " + m.id : m.id);
      const renderView = () => {
        if (view === "") return null;
        if (view === "prompt") return h("div", { style: code }, info ? (info.effective || info.system) : "加载中…");
        if (!last) return h("div", { style: { ...code, color: "var(--dsw-alias-label-secondary,#9aa3ad)" } }, "还没有记录（去输入框点一次 ⚡）");
        const oLen = String(last.original || "").length;
        const nLen = String(last.optimized || "").length;
        const delta = nLen - oLen;
        // [2026-09-21 收尾] 优先读 last.retrievalQueries（与 API 同名字段），回落 last.queries
        const lastQueries = Array.isArray(last.retrievalQueries) ? last.retrievalQueries
          : (Array.isArray(last.queries) ? last.queries : []);
        const durSec = Number(last.durationMs);
        return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: dim },
            new Date(Number(last.ts)).toLocaleString() +
            " ｜ 字数 " + oLen + " → " + nLen + "（" + (delta >= 0 ? "+" : "") + delta + "）" +
            " ｜ 耗时 " + (Number.isFinite(durSec) ? (durSec / 1000).toFixed(1) + "s" : "—") +
            " ｜ 检索 " + lastQueries.length + " 条查询" +
            " ｜ 上下文 " + (last.conversationContextUsed ? "有" : "无") +
            " ｜ 漂移 " + (last.drift ? "有" : "无") + " ｜ 重试 " + (Number(last.attempts) || 1) + " 次" +
            (last.fellBack ? " ｜ 已退回原文" : ""),
          ),
          h("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } },
            h("div", { style: { flex: "1 1 300px", minWidth: "260px" } },
              h("div", { style: dim }, "原文"),
              h("div", { style: code }, String(last.original || "")),
            ),
            h("div", { style: { flex: "1 1 300px", minWidth: "260px" } },
              h("div", { style: dim }, "改写后"),
              h("div", { style: code }, String(last.optimized || "")),
            ),
          ),
          lastQueries.length > 0
            ? h("div", null, h("div", { style: dim }, "投喂给 openmem 的检索查询"), h("div", { style: code }, lastQueries.join("\n")))
            : null,
        );
      };
      return h("div", { style: { padding: "16px", display: "flex", flexDirection: "column", gap: "12px" } },
        // 分区标题：[2026-09-21 老大] 副标题与标题同行，用「标注体」（更小+斜体+次要色）区别正文，省一行
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
          h("div", { style: { fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary,#e6e9ef)" } }, "⚡ 提示词优化"),
          h("span", {
            style: {
              fontSize: "11px", fontWeight: 400, fontStyle: "italic",
              color: "var(--dsw-alias-label-secondary,#9aa3ad)",
              letterSpacing: "0.02em", whiteSpace: "nowrap",
            },
          }, "精炼输入再回填 · 即改即生效"),
          h("div", { style: { flex: "1" } }),
          saved ? h("div", { style: { color: "#34c759", fontSize: "12px" } }, "✅ 已保存") : null,
          err ? h("div", { style: { color: "#e5484d", fontSize: "12px" } }, err) : null,
        ),
        // ① 模型卡
        optCard("模型", "精炼用的模型与服务商，默认锁定。", "#7c5cff",
          h("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } },
            h("label", { style: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 200px", minWidth: "180px" } },
              h("span", { style: dim }, groups.length === 0 ? "服务商（未读到配置）" : "服务商"),
              h("select", {
                disabled: !unlocked || saving, value: cfg.provider || "",
                onChange: (e) => {
                  const v = e.target.value;
                  const g = groups.find((x) => x.provider === v);
                  const first = g && g.models[0] ? g.models[0].id : "";
                  setCfg({ ...cfg, provider: v, model: first });
                  void save({ provider: v, model: first });
                },
                style: { ...vInput, opacity: unlocked ? 1 : 0.6 },
              },
                h("option", { value: "" }, "— 默认网关 —"),
                groups.map((g) => h("option", { key: g.provider, value: g.provider }, g.provider + "（" + g.models.length + " 个模型）")),
              ),
            ),
            h("label", { style: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 240px", minWidth: "180px" } },
              h("span", { style: dim }, "模型"),
              h("select", {
                disabled: !unlocked || saving, value: cfg.model || "",
                onChange: (e) => { const v = e.target.value; setCfg({ ...cfg, model: v }); void save({ model: v }); },
                style: { ...vInput, opacity: unlocked ? 1 : 0.6 },
              },
                h("option", { value: "" }, "— 内置默认（" + (effModel || "DV4F") + "）—"),
                modelOptions.map((m) => h("option", { key: m.id, value: m.id }, modelLabel(m))),
              ),
            ),
          ),
          h("button", {
            type: "button", style: { ...btnSm, alignSelf: "flex-start" },
            title: unlocked ? "点一下锁定（防误改）" : "点一下解锁才能改模型与服务商",
            onClick: () => setUnlocked(!unlocked),
          }, unlocked ? "🔓 已解锁" : "🔒 已锁定"),
        ),
        // [本地改造 2026-09-24 老大] 「润色强度」三档下拉卡删除：平时固定走标准档，要升级只需勾
        // 下面那条「强制清单化回复」。宿主端 strength 字段照旧生效（standard / strong）。
        // ③ 行为开关卡（说明一律写成标题下方小字，不再用 ? 浮层）
        optCard("行为开关", "关掉=更快。", "#34c759",
          h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
            // [本地改造 2026-09-24 老大] 强度不再做三档下拉，改成一个方框：勾上=强制清单化。
            h("label", { style: { display: "flex", flexDirection: "column", gap: "3px", cursor: "pointer" } },
              h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-primary,#e6e9ef)" } },
                h("input", {
                  type: "checkbox", checked: (cfg.strength || "standard") === "strong", disabled: saving,
                  onChange: (e) => { const v = e.target.checked ? "strong" : "standard"; setCfg({ ...cfg, strength: v }); void save({ strength: v }); },
                }),
                h("span", null, "强制清单化回复"),
              ),
              sub("勾上=把要求条目化，每条写清做什么/参数/怎样算完成；不勾=标准档，只补范围、参数、格式、质量门槛，不改你原来的说法结构。"),
            ),
            TOGGLES.map(([k, label, hint]) => h("label", { key: k, style: { display: "flex", flexDirection: "column", gap: "3px", cursor: "pointer" } },
              h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-primary,#e6e9ef)" } },
                h("input", {
                  type: "checkbox", checked: cfg[k] !== false,
                  onChange: (e) => { const v = e.target.checked; setCfg({ ...cfg, [k]: v }); void save({ [k]: v }); },
                }),
                h("span", null, label),
              ),
              sub(hint),
            )),
            // [2026-09-25] 闸门长度阀：数字输入，失焦即存（不逐键打搅后端）。闸门关掉时置灰。
            GATE_NUMBERS.map(([k, label, hint]) => h("label", { key: k, style: { display: "flex", flexDirection: "column", gap: "3px" } },
              h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-primary,#e6e9ef)" } },
                h("input", {
                  type: "number", min: 4, max: 400, step: 2,
                  defaultValue: Number(cfg[k] ?? 40),
                  disabled: saving || cfg.gateCheck === false,
                  style: { width: "68px", padding: "2px 6px", fontSize: "13px" },
                  onBlur: (e) => {
                    const v = Math.max(4, Math.min(400, Math.round(Number(e.target.value) || 40)));
                    setCfg({ ...cfg, [k]: v }); void save({ [k]: v });
                  },
                }),
                h("span", null, label),
              ),
              sub(hint),
            )),
          ),
        ),
        // ④ 运行透视卡
        // [2026-09-21 老大反馈] 按钮必须在内容上方：原写法把展开内容误传成 optCard 的 right（标题右侧槽），
        // 导致按钮被压到内容下面，切换后要往下滚才能再切。现把 按钮条+内容 一并塞进 children，按钮永远在上。
        optCard("运行透视", "最近一次优化对比与生效提示词。", "#f5a623",
          h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
            h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
              h("button", { type: "button", style: btnSm, onClick: () => { setView(view === "last" ? "" : "last"); load(); } }, view === "last" ? "收起最近一次" : "看最近一次优化"),
              h("button", { type: "button", style: btnSm, onClick: () => { setView(view === "prompt" ? "" : "prompt"); load(); } }, view === "prompt" ? "收起提示词" : "看生效的提示词"),
              info && info.profileCached ? h("span", { style: dim }, "画像缓存 " + (() => {
                // [2026-09-21] TTL 拉到 24h 后按 s/分钟/小时 显示，避免出现「画像缓存 86400s」
                const age = Number(info.profileAgeMs) || 0;
                if (age < 60_000) return Math.round(age / 1000) + "s";
                if (age < 3_600_000) return Math.round(age / 60_000) + "分钟";
                return (age / 3_600_000).toFixed(1) + "小时";
              })() + "（24h 内有效）") : null,
            ),
            view ? h("div", null, renderView()) : null,
          ),
        ),
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
      // [本地改造 2026-09-24 老大] 在线 API 的密钥与地址属敏感位：一格一把锁，点 🔒 只解锁这一格。
      // 与语音页同写法（React state + ref 立即读），不依赖任何全局开关。
      const [vUnlocked, setVUnlockedState] = useState({});
      const vUnlockedRef = useRef({});
      const setVUnlocked = (lockKey, on) => { const next = { ...vUnlockedRef.current, [lockKey]: on }; vUnlockedRef.current = next; setVUnlockedState(next); };
      const isLocked = (lockKey) => vUnlockedRef.current[lockKey] !== true;
      const lockBtn = (lockKey) => h("button", {
        type: "button",
        title: isLocked(lockKey) ? "点一下解锁这一格（只放开这一格）" : "点一下把这一格锁回去",
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); setVUnlocked(lockKey, isLocked(lockKey)); },
        style: { border: "none", background: "transparent", cursor: "pointer", fontSize: "13px", lineHeight: "1", padding: "2px 4px", color: "inherit", flex: "none" },
      }, isLocked(lockKey) ? "🔒" : "🔓");
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
          lockBtn("secret:" + keyName),
          h("input", {
            disabled: isLocked("secret:" + keyName),
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
        // [本地改造 2026-09-24 老大] 这一大段说明改成折叠（默认收起）：卡片里堆十几行字太烦人。
        // 用原生 details/summary，不占状态、不需重渲染。
        h("details", { style: { fontSize: "12px", lineHeight: 1.9, color: "var(--dsw-alias-label-secondary,#9aa3ad)", background: "rgba(128,128,128,.05)", border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "8px", padding: "10px 12px" } },
          h("summary", { style: { cursor: "pointer", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6e9ef)", fontSize: "12.5px" } }, "识图工具说明 / 本地识图一键安装指引（点开展开）"),
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
            vField("API 地址（填到 /v1）", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", {
              disabled: isLocked("vision.baseUrl"),
              value: config.vision?.baseUrl ?? "",
              onChange: (e) => setVision({ baseUrl: e.target.value }, true),
              placeholder: visionIsOnline ? "https://api.siliconflow.cn/v1" : "http://127.0.0.1:11434/v1",
              style: { ...vInput, flex: 1 },
            }), lockBtn("vision.baseUrl"))),
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
                  vField("回退·API 地址", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", {
                    disabled: isLocked("vision.fallback.baseUrl"),
                    value: config.vision?.fallback?.baseUrl ?? "",
                    onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), baseUrl: e.target.value } }, true),
                    placeholder: "http://127.0.0.1:11434/v1",
                    style: { ...vInput, flex: 1 },
                  }), lockBtn("vision.fallback.baseUrl"))),
                  vField("回退·模型", h("input", {
                    value: config.vision?.fallback?.model ?? "",
                    onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), model: e.target.value } }, true),
                    placeholder: "qwen3-vl:4b-instruct",
                    style: vInput,
                  })),
                  (((config.vision?.fallback?.provider ?? "") || (visionIsOnline ? "local" : "online")) === "online")
                    ? vField("回退·API Key", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", {
                        disabled: isLocked("vision.fallback.apiKey"),
                        type: "password",
                        value: config.vision?.fallback?.apiKey ?? "",
                        onChange: (e) => setVision({ fallback: { ...(config.vision?.fallback ?? {}), apiKey: e.target.value } }, true),
                        placeholder: "sk-...",
                        style: { ...vInput, flex: 1 },
                      }), lockBtn("vision.fallback.apiKey")))
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

    // ── [2026-09-26 正规化搬迁] 插件页 bundle 配置页（侧边栏「插件」→ 本插件卡片 → 详情页）。
    //    官方 ui-plugin-manager 的 plugins.bundle.config slot（keyed，key=bundle 包名），
    //    渲染在组合包详情页"描述与行列表之间"，view 只会是 'page'（slot-contract.ts:94）。
    //    7 个分区页内 tab 切换；各分区组件零 props 自包含，本身一字不动。
    //    搬迁过渡期：设置页 settings.section 7 个注册暂留（同一组件双入口共存），
    //    老大验收本入口可用后，第二阶段删掉那 7 个注册。
    function PluginBundleConfigPage() {
      const TABS = [
        ["voice", "语音服务", VoiceSettingsSection],
        ["vision", "图片识别", VisionSettingsSection],
        ["persona", "全局人设", PersonaSection],
        ["mcp", "MCP 服务器", McpSection],
        ["skills", "Skill 管理", SkillsSection],
        ["prompt-optimize", "提示词优化", PromptOptimizeSection],
        ["decision-model", "决策模型", DecisionModelSection],
      ];
      const [tabId, setTabId] = useState("voice");
      const active = TABS.find((tb) => tb[0] === tabId) || TABS[0];
      const ActiveComp = active[2];
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
          TABS.map((tb) => h("button", {
            key: tb[0],
            type: "button",
            onClick: () => setTabId(tb[0]),
            style: {
              padding: "5px 12px", borderRadius: "999px", cursor: "pointer", fontSize: "12.5px",
              border: tb[0] === active[0] ? "1px solid rgba(120,160,255,0.55)" : "1px solid rgba(255,255,255,0.14)",
              background: tb[0] === active[0] ? "rgba(120,160,255,0.16)" : "transparent",
              color: tb[0] === active[0] ? "#cdd9ff" : "rgba(255,255,255,0.62)",
            },
          }, tb[1]))),
        h(ActiveComp, {}));
    }
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
      const [capsOpen, setCapsOpen] = useState(false); // [2026-09-24 老大] 语音能力自检默认收起，别占地方
      useEffect(() => {
        fetch("/voice/capabilities").then((r) => r.json()).then((d) => {
          if (d?.ok) setCaps(d.capabilities);
        }).catch(() => { /* 检测失败不阻塞设置页 */ });
      }, []);
      // [本地改造 2026-08-21] 服务商卡片折叠状态（去复选框后由折叠控制显隐，默认展开）
      const [openCards, setOpenCards] = useState({ edge: true, xiaomi: true, local: true, ali: true, audio8: true });
      const toggleCard = (key) => setOpenCards((s) => ({ ...s, [key]: !s[key] }));
      const [previewing, setPreviewing] = useState(null); // 正在试听的标识：engine / emotion:key / style:key
      // [本地改造 2026-09-24 老大：不要偷懒的全局锁] 全局锁把下拉/开关/试听一起掐死，而且并没能
      // 防住配置丢失（真凶是整份写回，已由宿主端 saveVoiceConfig 防冲保护堵住）。现在只锁"填了会丢"
      // 的敏感位：密钥 / 本地服务地址 / 本地命令 / 在线 API 地址，并且一格一把锁，单独解锁单独改。
      const [unlocked, setUnlockedState] = useState({});
      const unlockedRef = useRef({});
      const setUnlocked = (lockKey, on) => { const next = { ...unlockedRef.current, [lockKey]: on }; unlockedRef.current = next; setUnlockedState(next); };
      const isLocked = (lockKey) => unlockedRef.current[lockKey] !== true;
      const lockBtn = (lockKey) => h("button", {
        type: "button",
        title: isLocked(lockKey) ? "解锁后才能改这一项" : "已解锁，点一下锁回去",
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); setUnlocked(lockKey, isLocked(lockKey)); },
        style: { background: "transparent", border: "none", cursor: "pointer", fontSize: "12.5px", padding: "0 2px", flex: "none", opacity: isLocked(lockKey) ? "0.8" : "1" },
      }, isLocked(lockKey) ? "🔒" : "🔓");
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
          lockBtn("secret:" + keyName),
          h("input", { disabled: isLocked("secret:" + keyName),
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
        // [本地改造 2026-09-24 老大] 删掉全局写入总闸：敏感位靠各自 disabled 拦住（锁着的输入框发不出
        // onChange），下拉/开关/试听不再被牵连。防丢配置由宿主端 saveVoiceConfig 防冲保护负责。
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

      return h("div", { className: "vk-voice-panel", style: { display: "flex", flexDirection: "column", gap: "14px", padding: "16px", width: "100%", boxSizing: "border-box" } },
        // [2026-09-19] 锁定态灰显样式（disabled 控件统一降透明度 + 禁用光标）
        h("style", null, ".vk-voice-panel input:disabled, .vk-voice-panel select:disabled, .vk-voice-panel textarea:disabled { opacity: .55; cursor: not-allowed; }"),
        // [本地改造 2026-09-24 老大] 「🔒 修改配置」全局开关已废（下拉/开关被一起锁住是偷懒做法），
        // 换成一句说明；需要保护的格子各自带锁。
        h("div", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-tertiary,#6b7384)" } }, "带 🔒 的格子（密钥 / 本地服务地址 / 本地命令 / API 地址）需单独点锁才能改；其余项随时可改。"),
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
        // [2026-08-21] 语音能力状态面板 → [2026-09-24 老大：占地方，且"插件自带语音输入"已被官方追上] 收成一行，点开才展开
        caps !== null ? h("div", { style: { border: "1px solid var(--dsw-alias-border-l1,#333a45)", borderRadius: "10px", padding: "6px 12px", display: "flex", flexDirection: "column", gap: "6px", background: "rgba(128,128,128,.05)", fontSize: "12.5px", lineHeight: "1.5" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h("button", { type: "button", onClick: () => setCapsOpen(!capsOpen), style: { cursor: "pointer", fontSize: "12px", fontWeight: 600, opacity: .85, background: "transparent", color: "inherit", border: "none", padding: 0 } },
              (capsOpen ? "▾ " : "▸ ") + "语音能力自检"),
            h("span", { style: { marginLeft: "auto", opacity: .7, fontSize: "11.5px" } },
              caps.voiceContentContract === true ? "语音可原样直发模型" : "语音会先自动转成文字")),
          capsOpen ? [
            h("div", { key: "c1", style: { display: "flex", alignItems: "center", gap: "6px" } },
              h("span", { style: { color: "#3ecf8e" } }, "✅"), " 按住说话（录音 → 转成文字 → 发出）",
              h("span", { style: { marginLeft: "auto", opacity: .7 } }, "本机由插件提供 · 官方新版也有同款，升级后要二选一")),
            h("div", { key: "c2", style: { display: "flex", alignItems: "center", gap: "6px" } },
              h("span", { style: { color: "#3ecf8e" } }, "✅"), " 语音气泡（聊天的语音条，点开能听）", h("span", { style: { marginLeft: "auto", opacity: .7 } }, "插件内置")),
            caps.voiceContentContract === true
              ? h("div", { key: "c3", style: { display: "flex", alignItems: "center", gap: "6px" } },
                  h("span", { style: { color: "#3ecf8e" } }, "✅"), " 语音原样发给模型（不先转成文字）", h("span", { style: { marginLeft: "auto", opacity: .7 } }, "这台机器的 dsh 支持"))
              : h("div", { key: "c3", style: { display: "flex", alignItems: "center", gap: "6px" } },
                  h("span", { style: { color: "#e5a53a" } }, "⚠️"), " 语音原样发给模型（不先转成文字）", h("span", { style: { marginLeft: "auto", opacity: .7 } }, "不支持，会自动先转成文字再发")),
            h("div", { key: "c4", style: { fontSize: "11.5px", opacity: .65, marginTop: "2px" } },
              "上面这三行是现场问程序得到的结果，不是写死的话术。"),
          ] : null,
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
              (eng.asr.mode ?? "service") === "service" ? vField("本地服务地址", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", { disabled: isLocked("asr.url"), value: eng.asr.url ?? "", onChange: (e) => setEngine("asr", { url: e.target.value }, true), placeholder: "http://127.0.0.1:18790", style: { ...vInput, flex: 1 } }), lockBtn("asr.url"))) : null,
              (eng.asr.mode ?? "service") === "cmd" ? vField("本地命令", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", { disabled: isLocked("asr.cmd"), value: eng.asr.cmd ?? "", onChange: (e) => setEngine("asr", { cmd: e.target.value }, true), placeholder: "sherpa-onnx-offline.exe --tokens=... --sense-voice-model=... --num-threads=4", style: { ...vInput, flex: 1 } }), lockBtn("asr.cmd"))) : null,
              (eng.asr.mode ?? "service") === "api" ? [
                secretField("API Key", "asr", eng.asr.apiKey ?? "", (e) => setEngine("asr", { apiKey: e.target.value }, true), "sk-..."),
                vField("API 地址", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", { disabled: isLocked("asr.apiBaseUrl"), value: eng.asr.apiBaseUrl ?? "", onChange: (e) => setEngine("asr", { apiBaseUrl: e.target.value }, true), placeholder: "https://api.openai.com/v1", style: { ...vInput, flex: 1 } }), lockBtn("asr.apiBaseUrl"))),
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
        // [本地改造 2026-09-24 老大：默认引擎是日常开关，不该跟着「🔒 修改配置」锁] 这一项随时可切，其余仍要解锁
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
              vField("常驻服务地址", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", { disabled: isLocked("audio8.url"), value: eng.audio8?.url ?? "http://127.0.0.1:18795", onChange: (e) => setEngine("audio8", { url: e.target.value }, true), placeholder: "http://127.0.0.1:18795", style: { ...vInput, flex: 1 } }), lockBtn("audio8.url"))),
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
              vField("本地命令（每次调用启动进程）", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", { disabled: isLocked("local.cmd"), value: eng.local.cmd ?? "", onChange: (e) => setEngine("local", { cmd: e.target.value }, true), placeholder: "如 node <插件目录>\\local-tts.mjs（安装脚本会自动填好）", style: { ...vInput, flex: 1 } }), lockBtn("local.cmd"))),
              vField("HTTP 服务地址（常驻模式）", h("span", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", { disabled: isLocked("local.url"), value: eng.local.url ?? "", onChange: (e) => setEngine("local", { url: e.target.value }, true), placeholder: "如 http://127.0.0.1:5000/tts（POST {text} 返回音频）", style: { ...vInput, flex: 1 } }), lockBtn("local.url"))),
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

    // [2026-09-26 案1收尾] 「复制转写」独立组件已删：语音卡渲染权已搬入本插件
    // （VoiceCardBar 自带内置复制钮），官方 voice-actions 挂点同步还原零改动。

    // [2026-09-20] 追加 uiConversation 声明注入：该服务是 fiber 拓扑代理属性，ctx.get 全局商店读不到
    // （实测 __dshVideo.svc="missing" 而 slots 正常——外部插件必须走 inject 声明）。
    // [2026-09-21] documentPreviews：官方侧栏文档预览注册表（ui-sidebar-documentpreview 提供），
    // 用它注册视频渲染器——侧栏文件树双击视频也能播（配套核心 stream 加载模式）。
    // ── [2026-09-24] 消息撤回 + 历史删除（前端注入层）─────────────────────
    // 为什么走 DOM 注入：官方给助手消息留了动作槽，用户消息行没有挂点；插件不能
    // import 别的插件的组件。这里只做三件事：给自己发的每条消息挂一个垃圾桶、把
    // 服务端认定"已作废"的行整行收掉、给侧边栏每段历史挂一个删除。真删动作全在服务端
    // （/retro-* 路由，见 lib/retro-delete.js），前端不装样子：已作废清单每次从会话
    // 日志现算，刷新、换手机看结果都一样。
    const RETRO = {
      started: false,
      observer: null,
      deleted: new Map(), // sessionId -> Set<seq>（已作废）
      deletedIds: new Map(), // sessionId -> Set<MessageId>（前端只拿得到 id 的那些行靠它收）
      deletedTurns: new Map(), // sessionId -> Set<轮号>：工具卡是 turn-process 行，key 不是消息 id，只能按轮收
      deletedTexts: new Map(), // sessionId -> 已作废用户消息的原文（去空白），按内容收行用
      deletedPairs: new Map(), // sessionId -> ["轮号|原文前80字"]：服务端成对回，跨设备都收得住
      domReported: false, // 探针每页只报一次
      occ: new Map(), // 本轮扫描里「同轮同文字」出现过几次，给重复行编号
      loading: new Set(), // 正在拉清单的会话，防重复请求
    }

    /** 同一轮里内容完全相同的第几行（插话连着发两句一样的，得能分开）。 */
    function retroClip(raw, max) { const one = String(raw ?? "").replace(/\s+/g, " ").trim(); return one.length <= max ? one : one.slice(0, Math.max(1, max - 1)).trimEnd() + "…" }
    function retroOccurrence(key) {
      const n = RETRO.occ.get(key) ?? 0
      RETRO.occ.set(key, n + 1)
      return n
    }

    /** 调服务端撤回/删除接口。 */
    function retroApi(path, body) {
      return fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json().catch(() => ({ ok: false, error: "服务没应答" })))
    }

    /** 右上角短提示（不抢焦点，2.8 秒自己走）。 */
    function retroToast(text, bad) {
      try {
        let box = document.getElementById("dsh-retro-toast")
        if (box === null) {
          box = document.createElement("div")
          box.id = "dsh-retro-toast"
          box.style.cssText = "position:fixed;right:18px;top:54px;z-index:99999;max-width:340px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none"
          document.body.appendChild(box)
        }
        box.textContent = text
        box.style.background = bad ? "#b3261e" : "#1f6feb"
        box.style.display = "block"
        clearTimeout(retroToast._t)
        retroToast._t = setTimeout(() => { box.style.display = "none" }, 2800)
      } catch { /* 提示发不出去不影响主流程 */ }
    }

    /**
     * 当前打开的是哪段历史。多路取，任一命中即可 —— 老实现只认
     * `[data-session-id][aria-selected="true"]` 一种标法：侧栏收起/懒加载时 DOM 里根本没有行，
     * 或者官方用的是 aria-current（ui-workspace 行两种都有），就会误报"认不出当前是哪段会话"。
     * ① aria-selected 的选中行；② 行上带 selected 类名（产物里 clsx 是这么标选中的）；
     * ③ aria-current 的选中行；④ 页面上只有一行带 data-session-id 时用它；
     * ⑤ **页面自己发过的请求里带的 sessionId**（如 /api/changes.summary?sessionId=…）——
     *    侧栏收起、URL 不带号时唯一可靠的来源，取时间最近那条；只读浏览器资源计时表，不改任何请求；
     * ⑥ 地址栏里的 session-<uuid>。
     */
    function retroCurrentSessionId() {
      const pick = (sel, onlyOne) => {
        const rows = Array.from(document.querySelectorAll(sel))
        if (onlyOne === true && rows.length !== 1) return ""
        const hit = rows.find((el) => el.offsetParent !== null) ?? rows[0]
        return hit === undefined ? "" : String(hit.getAttribute("data-session-id") ?? "")
      }
      const byDom = pick('[data-session-id][aria-selected="true"]')
        || pick('[data-session-id][class*="selected"]')
        || pick('[data-session-id][aria-current="page"]')
        || pick('[data-session-id][aria-current]')
        || pick('[data-session-id]', true)
      if (byDom !== "") return byDom
      // ⑤ 最近一条带 sessionId 的请求 = 页面当前正在读的会话。
      try {
        const hits = []
        for (const entry of performance.getEntriesByType("resource") ?? []) {
          const m = String(entry?.name ?? "").match(/[?&]sessionId=([^&#]+)/)
          if (m !== null) hits.push([Number(entry.startTime) || 0, decodeURIComponent(m[1])])
        }
        hits.sort((a, b) => b[0] - a[0])
        if (hits.length > 0 && /^session-[0-9a-f-]{30,40}$/i.test(hits[0][1])) return hits[0][1]
      } catch { /* 读不到资源计时表就往下走 */ }
      try {
        const m = String(location.href).match(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
        if (m !== null) return m[0]
      } catch { /* 读不到地址栏就算了 */ }
      // 全落空时留条控制台线索，下次他贴 F12 我就能直接看出是哪一路没命中，不用再猜。
      try {
        console.warn("[dsh-retro] 认会话失败：侧栏行数=" + document.querySelectorAll("[data-session-id]").length
          + "，选中行=" + document.querySelectorAll('[data-session-id][aria-selected="true"]').length
          + "，资源表里带 sessionId 的请求=" + (performance.getEntriesByType("resource") ?? [])
            .filter((e) => /[?&]sessionId=/.test(String(e?.name ?? ""))).length)
      } catch { /* 控制台不通不影响主流程 */ }
      return undefined
    }

    /** 拉一次"这段会话哪些消息已作废"，同会话只拉一次。 */
    function retroLoadDeleted(sessionId) {
      if (sessionId === undefined || sessionId === "" || RETRO.deleted.has(sessionId) || RETRO.loading.has(sessionId)) return
      RETRO.loading.add(sessionId)
      retroApi("/retro-deleted?sessionId=" + encodeURIComponent(sessionId))
        .then((j) => {
          RETRO.deleted.set(sessionId, new Set(Array.isArray(j?.seqs) ? j.seqs.map(Number) : []))
          RETRO.deletedIds.set(sessionId, new Set(Array.isArray(j?.ids) ? j.ids.map(String) : []))
          RETRO.deletedTurns.set(sessionId, new Set(Array.isArray(j?.turns) ? j.turns.map(Number) : []))
          RETRO.deletedTexts.set(sessionId, Array.isArray(j?.texts) ? j.texts.map(String) : [])
          RETRO.deletedPairs.set(sessionId, Array.isArray(j?.pairs) ? j.pairs.map(String) : [])
        })
        .catch(() => { RETRO.deleted.set(sessionId, new Set()) })
        .then(() => { RETRO.loading.delete(sessionId); retroScan() })
    }

    /** 一次性注入样式：按钮常态半透明、悬停行/悬停气泡才显全。 */
    function retroStyles() {
      if (document.getElementById("dsh-retro-style") !== null) return
      const s = document.createElement("style")
      s.id = "dsh-retro-style"
      s.textContent = [
        ".dsh-retro-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:26px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa3ad);cursor:pointer;opacity:.45;transition:opacity .12s,background .12s}",
        ".dsh-retro-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:#e5484d}",
        "[data-session-id]{position:relative}",
        ".dsh-retro-mask{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px}",
        ".dsh-retro-card{max-width:460px;width:100%;background:var(--dsw-alias-bg-raised,#1c2128);color:var(--dsw-alias-label-primary,#e6e9ef);border:1px solid var(--dsw-alias-border-l1,#333a45);border-radius:14px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}",
        ".dsh-retro-card h3{margin:0 0 8px;font-size:15px}",
        ".dsh-retro-quote{margin:0 0 12px;padding:8px 10px;border-left:3px solid #e5484d;background:rgba(128,128,128,.1);border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}",
        ".dsh-retro-note{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9aa3ad);margin:0 0 12px}",
        ".dsh-retro-row{display:flex;align-items:center;gap:8px;font-size:13px;margin:0 0 14px;cursor:pointer}",
        ".dsh-retro-btns{display:flex;justify-content:flex-end;gap:8px}",
        ".dsh-retro-go{padding:7px 16px;border-radius:9px;border:1px solid #e5484d;background:#e5484d;color:#fff;font-size:13px;cursor:pointer}",
        ".dsh-retro-cancel{padding:7px 16px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,#333a45);background:transparent;color:inherit;font-size:13px;cursor:pointer}",
      ].join("")
      document.head.appendChild(s)
    }

    // 图标必须是真 DOM 片段（不是 React 元素）：垃圾桶挂进官方渲染出的行，
    // 拿 React 元素 cloneNode 会在第一次挂载就抛错，整轮扫描死在半路。
    const RETRO_ICON_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 4.5h10M6.5 3h3M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M6.6 6.8v4.4M9.4 6.8v4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

    /** 弹确认框。resolve({ok, alsoStop})；老大定的：模型正在处理时才问要不要一起停。 */
    function retroAsk({ title, quote, note, stopOption, replyOption, readonly }) {
      return new Promise((resolve) => {
        const mask = document.createElement("div")
        mask.className = "dsh-retro-mask"
        let stop = false
        let alsoReply = false
        const close = (ok) => {
          document.removeEventListener("keydown", onKey)
          mask.remove()
          resolve({ ok, alsoStop: stop, alsoReply })
        }
        const onKey = (e) => { if (e.key === "Escape") close(false) }
        const card = document.createElement("div")
        card.className = "dsh-retro-card"
        const h3 = document.createElement("h3"); h3.textContent = title
        card.appendChild(h3)
        if (quote !== undefined) {
          const q = document.createElement("div"); q.className = "dsh-retro-quote"; q.textContent = quote
          card.appendChild(q)
        }
        // [本地改造 2026-09-25 老大「提示太长懒得看完」] 正文只留一句大白话，长说明折进「为什么」，
        // 想看再点，不想看直接按删除。
        if (note !== undefined && note !== "") {
          const n = document.createElement("p"); n.className = "dsh-retro-note"; n.textContent = note
          card.appendChild(n)
        }
        if (stopOption) {
          const lab = document.createElement("label"); lab.className = "dsh-retro-row"
          const cb = document.createElement("input"); cb.type = "checkbox"
          cb.onchange = () => { stop = cb.checked === true }
          const sp = document.createElement("span"); sp.textContent = "同时停止回答"
          lab.append(cb, sp)
          card.appendChild(lab)
        }
        // [本地改造 2026-09-24 老大点名] 原来只说"删这条"，没给"连模型的回话一起删"的选项。
        if (replyOption) {
          const lab2 = document.createElement("label"); lab2.className = "dsh-retro-row"
          const cb2 = document.createElement("input"); cb2.type = "checkbox"
          cb2.onchange = () => { alsoReply = cb2.checked === true }
          const sp2 = document.createElement("span"); sp2.textContent = "同时删除它的回复"
          lab2.append(cb2, sp2)
          card.appendChild(lab2)
        }
        const btns = document.createElement("div"); btns.className = "dsh-retro-btns"
        const cancel = document.createElement("button"); cancel.className = "dsh-retro-cancel"; cancel.textContent = "取消"
        cancel.onclick = () => close(false)
        const okBtn = document.createElement("button"); okBtn.className = "dsh-retro-go"; okBtn.textContent = "删除"
        okBtn.onclick = () => close(true)
        if (readonly === true) { cancel.textContent = "知道了"; cancel.className = "dsh-retro-go"; btns.append(cancel) } else { btns.append(cancel, okBtn) }
        card.appendChild(btns)
        mask.appendChild(card)
        mask.onmousedown = (e) => { if (e.target === mask) close(false) }
        document.addEventListener("keydown", onKey)
        document.body.appendChild(mask)
        setTimeout(() => { try { okBtn.focus() } catch { /* 抢焦点失败就算了 */ } }, 0)
      })
    }

    /** 往一个容器里塞按钮（同容器同类只塞一次，绝不重复触发 DOM 变动）。 */
    function retroMountBtn(host, key, label, onClick, extraClass) {
      if (host.querySelector(":scope > [data-retro='" + key + "']") !== null) return
      const b = document.createElement("button")
      b.type = "button"
      b.className = "dsh-retro-btn" + (extraClass !== undefined ? " " + extraClass : "")
      b.setAttribute("data-retro", key)
      b.title = label
      b.setAttribute("aria-label", label)
      b.insertAdjacentHTML("beforeend", RETRO_ICON_SVG)
      b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); onClick() }
      host.appendChild(b)
    }

    // 弹窗按档说话：删之前先问后台"这条现在算哪一档"，别拿"从记忆里抹掉"
    // 去吓唬一条模型压根没看到的消息，也别摆一个点了没用的"同时停下"勾。
    const RETRO_STAGES = {
      queue: { title: "这条还没发出去，确定删除？" },
      running: { title: "这条模型正在回复，确定删除？", stop: true },
      done: { title: "这条消息模型已回复，确定删除？", reply: true },
      compacted: { title: "这条没在模型的上下文里，确定删除？", reply: true },
      windowed: { title: "这条没在模型的上下文里，确定删除？", reply: true },
      'not-message': { title: "这条的状态认不准，确定删除？", reply: true },
      unknown: { title: "这条的状态认不准，确定删除？", reply: true },
      mismatch: { title: "内容对不上，没敢删", readonly: true },
      retracted: { title: "这条已经删过了", readonly: true },
    }

    /** 删一条自己发的消息：先问档位，再按档出文案。 */
    // [本地改造 2026-09-25 探针实证「刷新后复活、AI 回话收不掉」总根] 界面 key 尾巴是
    // input-message<uuid> —— 那是输入框提交 id，跟日志里的消息 id 不是一个 namespace（实测两边 uuid 交集 0），
    // 所以按 id 收行永远命中不了。能跨刷新稳定复现的身份只有「轮号 + 这行的正文」，本地存一份照旧收。
    const RETRO_PAIRS = {
      key: "dsh-retro-gone-pairs:v1",
      list() { try { return JSON.parse(localStorage.getItem(this.key) ?? "[]") } catch { return [] } },
      has(p) { try { return this.list().includes(p) } catch { return false } },
      add(p) { try { const a = this.list(); if (!a.includes(p)) { a.push(p); localStorage.setItem(this.key, JSON.stringify(a.slice(-400))) } } catch { /* 隐私模式存不下就算了 */ } },
    }
    const retroPairOf = (turn, norm) => (turn === undefined || norm === "" ? "" : String(turn) + "|" + String(norm).slice(0, 80))
    async function retroDeleteMessage(sessionId, addr, preview, pair) {
      const q = ["sessionId=" + encodeURIComponent(sessionId)]
      if (addr.pending === true) q.push("pending=1")
      if (addr.seq !== undefined) q.push("seq=" + addr.seq)
      if (addr.mid !== undefined) q.push("mid=" + encodeURIComponent(addr.mid))
      if (addr.turn !== undefined) q.push("turn=" + addr.turn + "&occurrence=" + (addr.occurrence ?? 0))
      if (addr.messageId !== undefined) q.push("messageId=" + encodeURIComponent(addr.messageId))
      // 带上这行的文字给服务端核对：对不上就报 mismatch，避免认错行删掉别条。
      if (preview !== "") q.push("text=" + encodeURIComponent(preview))
      // 排队行客观上还没进日志，服务端认不认得到都不该改变判断：直接按「还没发出去」这一档走。
      // 否则宿主端出任何岔子（比如那处先用后声明的崩溃）都会被 .catch 吞成空档位，
      // 把弹窗推到「状态未知」——而那一档带「同时删除它的回复」勾选，等于对着一条没发出去的话问要不要删回话。
      const st = addr.pending === true ? { stage: "queue" } : await retroApi("/retro-stage?" + q.join("&")).catch(() => ({}))
      const stage = RETRO_STAGES[st?.stage] ?? RETRO_STAGES.unknown
      const ans = await retroAsk({ title: stage.title, quote: preview, stopOption: stage.stop, replyOption: stage.reply, readonly: stage.readonly })
      if (!ans.ok) return
      const j = await retroApi("/retro-message-delete", {
        sessionId, pending: addr.pending === true, seq: addr.seq, mid: addr.mid, turn: addr.turn, occurrence: addr.occurrence, messageId: addr.messageId, alsoStop: ans.alsoStop, alsoReply: ans.alsoReply === true, text: preview,
      })
      if (j?.ok !== true) { retroToast("没删成：" + (j?.error ?? "服务没答话"), true); return }
      // 落一份「轮号|正文」，刷新后服务端清单再准也得靠它对上界面行（id 两套体系对不上）
      if (pair !== undefined && pair !== "") RETRO_PAIRS.add(pair)
      if (addr.seq !== undefined) {
        const set = RETRO.deleted.get(sessionId) ?? new Set()
        set.add(Number(addr.seq))
        RETRO.deleted.set(sessionId, set)
      }
      // 回话行/工具行的 id 只有服务端知道，删完不重拉清单就收不掉那些行。
      RETRO.deleted.delete(sessionId)
      RETRO.deletedIds.delete(sessionId)
      RETRO.deletedTurns.delete(sessionId)
      RETRO.deletedTexts.delete(sessionId)
      RETRO.deletedPairs.delete(sessionId)
      retroLoadDeleted(sessionId)
      // 服务端认到的 seq 可能比前端的多（前端只给得出 id 或轮号时），一并记账才能当场收行。
      const resolved = Number(j?.seq)
      if (Number.isSafeInteger(resolved) && resolved >= 1 && addr.seq === undefined) {
        const set = RETRO.deleted.get(sessionId) ?? new Set()
        set.add(resolved)
        RETRO.deleted.set(sessionId, set)
      }
      if (addr.mid !== undefined) {
        const ids = RETRO.deletedIds.get(sessionId) ?? new Set()
        ids.add(String(addr.mid))
        RETRO.deletedIds.set(sessionId, ids)
      }
      const voided = Array.isArray(j?.voided) ? j.voided.length : 1
      // 服务端说目标那条其实没作废成（之前删过 / 早掉出表面）就照实讲，别糊一句"已删除"。
      if (j?.targetVoided === false) { retroToast((j.targetReason === "already" ? "这条之前删过了" : "这条模型早就不带了") + (voided > 0 ? "，回话已删" : ""), true) } else
      retroToast(j.mode === "queue" ? "已删除（这条没发出去）"
        : (voided > 1 ? "已删除这条和它的回复" : "已删除") + (j?.stopped === true ? "，已停止回答" : ""))
      retroScan()
    }

    /** 删整段历史。 */
    async function retroDeleteSession(sessionId, title) {
      const ans = await retroAsk({
        title: "删除这段历史？",
        quote: title,
        note: "整段移进回收站，7 天内可恢复。",
        more: "整段对话会从列表里消失、模型再也调不到，日志文件移进回收站，7 天内可恢复，过期自动清掉。",
      })
      if (!ans.ok) return
      const j = await retroApi("/retro-session-delete", { sessionId })
      if (j?.ok !== true) { retroToast("没删成：" + (j?.error ?? "服务没答话"), true); return }
      retroToast("已移进回收站，7 天内可恢复")
      setTimeout(() => { try { location.reload() } catch { /* 刷不动就手动刷 */ } }, 1000)
    }

    /** 一次扫描：气泡挂垃圾桶 + 已作废的收行 + 侧边栏挂删除。所有 DOM 写入都带条件，防观察器自激。 */
    function retroScan() {
      if (typeof document === "undefined" || document.body === null) return
      retroStyles()
      const sessionId = retroCurrentSessionId()
      if (sessionId !== undefined) retroLoadDeleted(sessionId)
      const gone = (sessionId !== undefined ? RETRO.deleted.get(sessionId) : undefined) ?? new Set()
      const goneIds = (sessionId !== undefined ? RETRO.deletedIds.get(sessionId) : undefined) ?? new Set()
      const deadTurns = (sessionId !== undefined ? RETRO.deletedTurns.get(sessionId) : undefined) ?? new Set()
      const goneTexts = (sessionId !== undefined ? RETRO.deletedTexts.get(sessionId) : undefined) ?? []
      const allPairs = [...((sessionId !== undefined ? RETRO.deletedPairs.get(sessionId) : undefined) ?? []), ...RETRO_PAIRS.list()]
      // [本地改造 2026-09-25 探针实证「刷新后复活」总根] 界面行 key 是「13:input-message<uuid>」，
      // 尾巴带 input-message 前缀；服务端 /retro-deleted 回的 id 是裸 uuid —— 两边直接比永远不相等。
      const retroUuid = (s) => { const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(String(s ?? "")); return m !== null ? m[0] : String(s ?? "") }
      const goneAny = (x) => goneIds.has(x) || goneIds.has(retroUuid(x))

      for (const row of document.querySelectorAll("[data-chat-flow-kind='user'],[data-chat-flow-kind='steering']")) {
        // [本地改造 2026-09-24 老大实测「弹窗说的全是错的、点删除还报错」后更正总根]
        // 原实现读 data-message-seq —— 官方代码里根本没有这个属性（全仓搜零命中），getAttribute 恒 null，
        // 而 Number(null) === 0 又算「安全整数」，于是每条消息挂的按钮都带着 seq=0：
        // 弹窗报的是整段会话第一条事件的档位，删除瞄的也是它，跟老大点的那条毫无关系。
        // 现解析官方真实属性 data-chat-node-key（ChatNodeSeat.tsx:154，形如「命名空间:类型:序号」）
        // 末尾的序号，并把这行文字一并送服务端核对；解析不出来就干脆不挂按钮——宁可不给删，不能删错行。
        const host = row.closest("[data-chat-node-key]") ?? row
        const keyAttr = String(host.getAttribute("data-chat-node-key") ?? "")
        // [本地改造 2026-09-25 老大实测「按钮直接没了」] 末尾那一段可能是序号，也可能是日志里的
        // MessageId（uuid，官方 MessageBase.id 是跨边界稳定身份）—— 两种都收，不再赌格式；
        // 万一 key 完全没用，还有官方 data-chat-turn 的轮号 + 这行文字兜底，服务端按轮号+文字认条。
        const tail = keyAttr.slice(keyAttr.lastIndexOf(":") + 1)
        const addr = /^\d+$/.test(tail) ? { seq: Number(tail) } : tail !== "" ? { mid: tail } : {}
        const turnNum = Number(host.getAttribute("data-chat-turn") ?? "")
        addr.turn = Number.isSafeInteger(turnNum) && turnNum >= 0 ? turnNum : undefined
        const text = retroClip(host.innerText ?? "", 120)
        const occ = retroOccurrence(String(addr.turn) + "|" + text.slice(0, 60))
        addr.occurrence = occ
        // 三样属性都拿不到也照挂按钮：服务端还能靠「这行文字在整段会话里唯一」认条；
        // 真认不出就回 mismatch 拒删，不会碰错内容。
        let rowId = "x" + occ
        if (addr.seq !== undefined) rowId = "s" + addr.seq
        else if (addr.mid !== undefined) rowId = "i" + addr.mid
        else if (addr.turn !== undefined) rowId = "t" + addr.turn + "-" + occ
        const rowNorm = String(host.innerText ?? "").replace(/\s+/g, "")
        // 原文够长就按包含收（行里还混着时间、图片占位这些额外字），短消息必须整行等值才收，
        // 免得「继续」这种两字消息把别的行一起带走。
        const goneByText = rowNorm.length >= 6 && goneTexts.some((t) => t.length >= 12 ? rowNorm.includes(t) : rowNorm === t)
        const pair = retroPairOf(addr.turn, rowNorm)
        // 一条「轮号|原文」只有两个来源：服务端成对回的（跨设备有效）+ 本机删除时记的（会话没在服务端
        // 打开时兜底）。轮号对不上直接否，原文长就按前缀（行里还拖着时间/图片占位），短消息必须整行等值。
        let pairHit = false
        if (rowNorm.length >= 6) {
          for (const p of allPairs) {
            const bar = p.indexOf("|")
            if (bar < 0) continue
            const pTurn = p.slice(0, bar); const pTxt = p.slice(bar + 1)
            if (pTxt.length < 6) continue
            if (String(addr.turn ?? "") !== pTurn) continue
            if (pTxt.length >= 12 ? rowNorm.startsWith(pTxt) : rowNorm === pTxt) { pairHit = true; break }
          }
        }
        if (pairHit || goneByText || (addr.seq !== undefined && gone.has(addr.seq)) || (addr.mid !== undefined && goneAny(addr.mid))) {
          // 整行收掉，顺手摘掉本行垃圾桶（行是隐藏的，按钮留着只是脏节点）
          const stale = host.querySelector("[data-retro='msg-" + rowId + "']")
          if (stale !== null) stale.remove()
          if (host.style.display !== "none") host.style.display = "none"
          continue
        }
        if (host.style.display === "none") host.style.display = ""
        const seat = host.querySelector("[class*='actions']") ?? host
        retroMountBtn(seat, "msg-" + rowId, "删除这条", () => {
          // 会话 id 必须点的时候现取：扫描那一刻侧栏可能还没渲染出行，锁进闭包就永久是 undefined。
          const sid = retroCurrentSessionId()
          if (sid === undefined) { retroToast("认不出这是哪段会话（刷新一下页面，或展开左侧历史列表再点）", true); return }
          void retroDeleteMessage(sid, addr, text, pair)
        })
      }

      // [本地改造 2026-09-25 老大点名] 勾了「同时删除它的回复」就要连没正文的工具记录一起收掉。
      // 工具调用与结果在日志里是表面节点（assistant/message、tool/result），作废后模型早就不带了；
      // 但官方界面仍按节点渲染，所以这里按作废清单把它们也收掉 —— 只改显示，不动任何数据。
      // 只收我们自己收过的行（dataset 打标），官方因别的原因藏起来的行不碰，免得给它复明。
      for (const host of document.querySelectorAll("[data-chat-node-key]")) {
        const kind = String(host.getAttribute("data-chat-flow-kind") ?? "")
        if (kind === "user" || kind === "steering") continue
        const kAttr = String(host.getAttribute("data-chat-node-key") ?? "")
        const tail = kAttr.slice(kAttr.lastIndexOf(":") + 1)
        if (tail === "") continue
        const procTurn = Number(host.getAttribute("data-chat-turn") ?? "")
        const dead = (/^\d+$/.test(tail) ? gone.has(Number(tail)) : goneAny(tail))
          || (Number.isSafeInteger(procTurn) && procTurn >= 0 && deadTurns.has(procTurn))
        if (dead) {
          if (host.style.display !== "none") { host.style.display = "none"; host.dataset.retroHidden = "1" }
        } else if (host.dataset.retroHidden === "1") {
          host.style.display = ""
          delete host.dataset.retroHidden
        }
      }

      // 还在队列里、模型没看到的消息：官方只给了个待处理气泡，没有可寻址身份，
      // 核心补 data-pending-id 后这里才能挂上"删除"——走的是队列真删那条分支。
      // [本地改造 2026-09-25 老大抓到核心 bug] 刚发出、模型还没看到的那条挂 data-pending-steering
      // （官方 MessageItem: "data-pending-steering": pending || void 0）。老代码找的是 data-pending-id
      // —— 那属性官方从来没有，所以这个按钮一次都没挂上，"发出去之前抽回"等于没做。
      for (const host of document.querySelectorAll("[data-pending-steering]")) {
        const ptext = retroClip(host.innerText ?? "", 160)
        if (ptext === "") continue
        const pkey = "pend-" + (ptext.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").slice(0, 20) || "x")
        const seat = host.querySelector("[class*='actions']") ?? host
        retroMountBtn(seat, pkey, "删除这条（还没发出去）", () => {
          const sid = retroCurrentSessionId()
          if (sid === undefined) { retroToast("认不出这是哪段会话（刷新一下页面，或展开左侧历史列表再点）", true); return }
          void retroDeleteMessage(sid, { pending: true }, ptext)
        })
      }

      if (!RETRO.domReported && sessionId !== undefined) {
        // 空报不锁：第一次扫描常早于消息渲染，锁了就永远拿不到真实身份
        const dump = []
        for (const probeRow of document.querySelectorAll("[data-chat-flow-kind='user'],[data-chat-flow-kind='steering']")) {
          const ph = probeRow.closest("[data-chat-node-key]") ?? probeRow
          dump.push(String(ph.getAttribute("data-chat-node-key") ?? "").slice(-40))
          if (dump.length >= 5) break
        }
        // 空数组也报：报不出来本身就是答案（页面还在跑旧 bundle，或选择器没命中）
        void retroApi("/retro-dom", { sessionId, dump: [{ ver: "probe-4", sid: String(sessionId ?? "none").slice(-13), rows: dump.length, keys: dump, gone: [...gone].slice(0, 6), ids: [...goneIds].map((x) => String(x).slice(0, 18)).slice(0, 5), txt: goneTexts.length, turns: [...deadTurns].slice(0, 6), pairs: RETRO_PAIRS.list().length }] })
        if (dump.length > 0) RETRO.domReported = true
      }

      // [本地改造 2026-09-24 老大] 侧栏会话行的「删除这段历史」按钮已摘掉：那一列本来就有系统的
      // 归档功能，常驻按钮既重复又容易被当成归档误点。单条消息的撤回/抽回（上面两处）按老大要求保留。
      // 路由 /retro-session-delete 与回收站仍在宿主端（函数 retroDeleteSession 留着），要恢复只需
      // 重新挂这个按钮，或改挂到右键菜单。
    }

    let retroQueued = false
    function retroKick() {
      if (retroQueued) return
      retroQueued = true
      requestAnimationFrame(() => { retroQueued = false; try { retroScan() } catch { /* 单帧失败不影响下次 */ } })
    }

    function startRetroDeleteUi() {
      if (RETRO.started || typeof document === "undefined" || typeof MutationObserver === "undefined") return
      RETRO.started = true
      const boot = () => {
        if (document.body === null) { setTimeout(boot, 200); return }
        retroStyles()
        try {
          RETRO.observer = new MutationObserver(retroKick)
          RETRO.observer.observe(document.body, { childList: true, subtree: true })
        } catch { /* 观察器起不来就不自动挂，手动扫描仍可用 */ }
        retroKick()
        // 已作废清单只在首次进会话时拉，切会话/翻页靠这里兜底（rAF 太密，2 秒一次够）
        RETRO.timer = setInterval(retroKick, 2000)
      }
      boot()
    }

    function stopRetroDeleteUi() {
      try { RETRO.observer?.disconnect() } catch { /* 已经没了 */ }
      clearInterval(RETRO.timer)
      RETRO.observer = null
      RETRO.started = false
    }

    const inject = ["slots", "uiConversation", "documentPreviews"];

    function apply(ctx) {
      // [2026-09-25] 整体防护：任一注册抛异常不把插件标成 failed
      const __safeEffect = (label, fn) => {
        try { return ctx.effect(fn, label); }
        catch (e) { try { console.error("[dsh-input-tools] effect " + label + " 失败:", e); } catch { /* ignore */ } return () => {}; }
      };
      try {
        const getConnection = () => ctx.get("connection");
        const getModels = () => ctx.get("modelDirectories");
      // [2026-09-24] 消息撤回 + 历史删除入口（纯 DOM 注入，见上方 RETRO 段）
      ctx.effect(() => {
        startRetroDeleteUi()
        return () => { stopRetroDeleteUi() }
      });
      // [2026-09-21] 侧栏文件树视频预览注册：documentPreviews 声明 stream 定义 + keyed 渲染器。
      // inject 里的 "documentPreviews" 保证本效果等官方注册表服务激活后才跑。
      ctx.effect(() => {
        if (!ctx.documentPreviews || typeof ctx.documentPreviews.register !== "function") return;
        const disposers = [];
        try {
          disposers.push(ctx.documentPreviews.register({
            id: SIDEBAR_VIDEO_ID,
            extensions: SIDEBAR_VIDEO_EXT,
            binaryExtensions: SIDEBAR_VIDEO_EXT,
            priority: "extension",
            title: () => "视频预览",
            loading: "stream",
            wrap: false,
          }));
        } catch (e) { try { console.error("[dsh-video] documentPreviews 注册失败:", e); } catch { /* ignore */ } }
        try {
          disposers.push(ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register(
            { name: "sidebar.right.tab.document", key: SIDEBAR_VIDEO_ID }, SidebarVideoBody,
          )));
        } catch (e) { try { console.error("[dsh-video] sidebar.video 渲染器注册失败:", e); } catch { /* ignore */ } }
        return () => { disposers.forEach((d) => { try { d(); } catch { /* 已失效 */ } }); };
      });
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
      // [2026-09-25 修] 用户消息里的视频附件 → 就地换成预览图（右侧，竖屏按原比例）。
      // 不再另出 user-video 节点，避免同一视频重复；AI 侧 video/reply 单独靠左。
      ctx.effect(() => {
        const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
        if (!document.getElementById("dsh-video-align")) {
          const st = document.createElement("style");
          st.id = "dsh-video-align";
          st.textContent = [
            '[data-video-reply-row="ai"]{width:100%!important;max-width:100%!important;display:flex!important;justify-content:flex-start!important;align-items:flex-start!important;align-self:flex-start!important;margin-left:0!important;margin-right:auto!important;}',
            '[data-video-reply-row="user"]{width:100%!important;max-width:100%!important;display:flex!important;justify-content:flex-end!important;align-items:flex-end!important;align-self:flex-end!important;margin-left:auto!important;margin-right:0!important;}',
            '[data-video-side="ai"]{align-self:flex-start!important;margin-left:0!important;margin-right:auto!important;align-items:flex-start!important;}',
            '[data-video-side="user"]{align-self:flex-end!important;margin-left:auto!important;margin-right:0!important;align-items:flex-end!important;}',
            '[data-user-video-preview]{display:flex;flex-direction:column;align-items:flex-end;cursor:zoom-in;max-width:100%;}',
            '[data-user-video-preview] .vbox{position:relative;display:block;border-radius:12px;overflow:hidden;background:#000;max-height:240px;}',
            '[data-user-video-preview] video{display:block;max-height:240px;width:auto;height:auto;object-fit:cover;}',
          ].join("\n");
          document.head.appendChild(st);
        }
        // 放出被误藏的 chip，再升级成预览
        // 从 React fiber / 属性里抠 attachmentId（match 表没填上时的兜底）
        const attachmentIdFromDom = (el) => {
          try {
            const map = window.__dshVideoNameToId;
            const title = el.getAttribute("title") ?? "";
            const hit = map && (map.get(title) || map.get(title.toLowerCase()));
            if (hit) return hit;
            for (const key of Object.keys(el)) {
              if (!key.startsWith("__reactFiber") && !key.startsWith("__reactInternalInstance")) continue;
              let fiber = el[key];
              for (let i = 0; i < 10 && fiber; i++) {
                const p = fiber.memoizedProps || fiber.pendingProps;
                if (p && typeof p === "object") {
                  const att = p.attachment || p.file || (p.image && p.image.attachment) || null;
                  const nested = att && att.file && typeof att.file === "object" ? att.file : att;
                  if (nested && typeof nested.attachmentId === "string") return nested.attachmentId;
                }
                fiber = fiber.return;
              }
            }
          } catch { /* ignore */ }
          return null;
        };
        const upgradeCard = (el) => {
          if (el.dataset.videoChipUpgraded === "1") return;
          const title = el.getAttribute("title") ?? "";
          if (!VIDEO_EXT.test(title)) return;
          const id = attachmentIdFromDom(el);
          if (!id) return;
          el.dataset.videoChipUpgraded = "1";
          el.style.display = "";
          delete el.dataset.videoChipHidden;
          try {
            const map = window.__dshVideoNameToId || (window.__dshVideoNameToId = new Map());
            map.set(title, id); map.set(title.toLowerCase(), id);
          } catch { /* ignore */ }
          const src = "/video-media?attachmentId=" + encodeURIComponent(id);
          const wrap = document.createElement("div");
          wrap.setAttribute("data-user-video-preview", "");
          wrap.setAttribute("title", title);
          wrap.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;cursor:zoom-in;max-width:100%;";
          const box = document.createElement("div");
          box.className = "vbox";
          box.style.cssText = "position:relative;display:block;border-radius:12px;overflow:hidden;background:#000;";
          const v = document.createElement("video");
          v.src = src; v.muted = true; v.playsInline = true; v.preload = "metadata";
          // 竖屏视频按原比例显示（等 metadata 回来再定高宽）
          v.style.cssText = "display:block;max-height:240px;width:auto;height:auto;max-width:280px;object-fit:contain;background:#000;";
          v.onloadedmetadata = () => {
            const vw = v.videoWidth || 9, vh = v.videoHeight || 16;
            const ratio = Math.min(4, Math.max(0.25, vw / vh));
            let bw, bh;
            if (ratio >= 1) { bw = 240; bh = Math.max(60, Math.round(240 / ratio)); }
            else { bh = 240; bw = Math.max(60, Math.round(240 * ratio)); }
            v.style.width = bw + "px"; v.style.height = bh + "px";
            box.style.width = bw + "px"; box.style.height = bh + "px";
          };
          const play = document.createElement("span");
          play.textContent = "▶";
          play.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:40px;height:40px;line-height:40px;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;font-size:16px;text-align:center;pointer-events:none;";
          box.appendChild(v); box.appendChild(play);
          wrap.appendChild(box);
          wrap.addEventListener("click", () => { openPresentedMediaOverlay(src, title); });
          el.replaceWith(wrap);
        };
        document.querySelectorAll('[class*="fileCard"][title]').forEach(upgradeCard);
        const mo = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.addedNodes) {
              if (n.nodeType !== 1) continue;
              if (n.matches && n.matches('[class*="fileCard"][title]')) upgradeCard(n);
              else if (n.querySelectorAll) n.querySelectorAll('[class*="fileCard"][title]').forEach(upgradeCard);
            }
          }
        });
        mo.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("click", (ev) => {
          if (!(ev.target instanceof Element)) return;
          const card = ev.target.closest('[class*="fileCard"][title]');
          if (card === null) return;
          const title = card.getAttribute("title") ?? "";
          if (!VIDEO_EXT.test(title)) return;
          const id = attachmentIdFromDom(card);
          if (!id) return;
          ev.preventDefault();
          ev.stopPropagation();
          openPresentedMediaOverlay(videoSrcOf(id), title);
        }, true);
        return () => { mo.disconnect(); };
      }, "dsh-input-tools: video-filecard-lightbox");
      ctx.effect(() => {
        // [2026-09-25] 统一防护：任一 slot 注册抛异常不拖垮整条 effect
        const safeInject = (slotName, factory) => {
          try { return ctx.slots.inject(slotName, factory); }
          catch (e) {
            try { console.error("[dsh-input-tools] slot inject " + slotName + " 失败:", e); } catch { /* ignore */ }
            return () => {};
          }
        };
        const disposers = [
          // [2026-09-20] 视频消息：conversation node + keyed chat 渲染器。
          // 自检标记挂 window.__dshVideo：哪层断了看哪个字段（禁止静默吞错）。
          (() => {
            try {
              const uic = ctx.uiConversation || (typeof ctx.get === "function" ? ctx.get("uiConversation") : null);
              window.__dshVideo = window.__dshVideo || {};
              if (!uic || !uic.events) { window.__dshVideo.svc = "missing"; return () => {}; }
              const d = uic.events.register(videoReplyDefinition);
              window.__dshVideo.svc = "ok";
              window.__dshVideo.node1 = typeof d === "function" ? "registered" : String(d);
              return typeof d === "function" ? d : () => {};
            } catch (e) {
              window.__dshVideo = window.__dshVideo || {};
              window.__dshVideo.node1 = "err:" + (e && e.message ? e.message : String(e));
              console.error("[dsh-video] videoReplyDefinition 注册失败:", e);
              return () => {};
            }
          })(),
          (() => {
            try {
              const uic = ctx.uiConversation || (typeof ctx.get === "function" ? ctx.get("uiConversation") : null);
              if (!uic || !uic.events) return () => {};
              // AI 侧收到的用户视频（inbox 插入）→ 左对齐预览
              const d = uic.events.register(inboxVideoDefinition);
              window.__dshVideo = window.__dshVideo || {};
              window.__dshVideo.node2 = typeof d === "function" ? "registered" : String(d);
              return typeof d === "function" ? d : () => {};
            } catch (e) {
              window.__dshVideo = window.__dshVideo || {};
              window.__dshVideo.node2 = "err:" + (e && e.message ? e.message : String(e));
              console.error("[dsh-video] inboxVideoDefinition 注册失败:", e);
              return () => {};
            }
          })(),
          (() => {
            try {
              window.__dshVideo = window.__dshVideo || {};
              window.__dshVideo.inject1 = "called";
              return safeInject("conversation.chat.node", () => {
                window.__dshVideo.renderer1 = "registered";
                return ctx.slots.register({ name: "conversation.chat.node", key: "video-reply", locale: "conversation" }, VideoReplyNodeView);
              });
            } catch (e) {
              window.__dshVideo.renderer1 = "err:" + (e && e.message ? e.message : String(e));
              console.error("[dsh-video] chat.node video renderer 注册失败:", e);
              return () => {};
            }
          })(),
          (() => {
            try {
              return safeInject("conversation.chat.node", () => ctx.slots.register({
                name: "conversation.chat.node", key: "user-video", locale: "conversation",
              }, UserVideoNodeView));
            } catch (e) {
              try { window.__dshVideo = window.__dshVideo || {}; window.__dshVideo.renderer2 = "err:" + (e && e.message ? e.message : String(e)); } catch { /* ignore */ }
              console.error("[dsh-video] chat.node user-video renderer 注册失败:", e);
              return () => {};
            }
          })(),
          // 附件槽：priority:-1 覆盖官方（lowest renders；官方默认 0 不冲突）
          safeInject("conversation.input.attachments", () => ctx.slots.register({
            name: "conversation.input.attachments",
            id: "composer-attachments-overlay",
            priority: -1,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId }),
          }, ComposerAttachmentsOverlay)),
          safeInject("conversation.input.left", () => ctx.slots.register({
            name: "conversation.input.left",
            id: "composer-left",
            order: 10,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId }),
          }, ToolbarLeft)),
          safeInject("conversation.input.right", () => ctx.slots.register({
            name: "conversation.input.right",
            id: "composer-balance",
            order: -10,
            locale: "conversation",
            inject: (sessionId) => ({ connection: getConnection(), sessionId, getModelStore: () => {
              try { const models = getModels(); if (!models) return undefined; return models.directoryFor(sessionId).store; }
              catch { return undefined; }
            } }),
          }, BalanceMeter)),
          // [2026-09-26 正规化搬迁] 插件页卡片内配置入口：官方 plugins.bundle.config slot。
          // key 必须是 bundle 包名（config-ledger 按它建"配置"入口）；注册随 browser 半侧同生死，
          // 行被关闭 → 浏览器半侧消失 → 本配置页一起消失（官方 README:104 语义，符合预期）。
          safeInject("plugins.bundle.config", () => ctx.slots.register({
            name: "plugins.bundle.config",
            key: "@oadank/dsh-input-tools",
          }, () => h(PluginBundleConfigPage, {}))),
          // [2026-09-26 零改动化] AI 语音/图片回复条：node 定义 + keyed 渲染器（照 video-reply 先例）。
          (() => {
            try {
              const uic = ctx.uiConversation || (typeof ctx.get === "function" ? ctx.get("uiConversation") : null);
              window.__dshMedia = window.__dshMedia || {};
              if (!uic || !uic.events) { window.__dshMedia.nodes = "svc-missing"; return () => {}; }
              const d1 = uic.events.register(voiceReplyDefinition);
              const d2 = uic.events.register(imageReplyDefinition);
              window.__dshMedia.nodes = "ok";
              return () => {
                try { if (typeof d1 === "function") d1(); } catch { /* 忽略 */ }
                try { if (typeof d2 === "function") d2(); } catch { /* 忽略 */ }
              };
            } catch (e) {
              window.__dshMedia = window.__dshMedia || {};
              window.__dshMedia.nodes = "err:" + (e && e.message ? e.message : String(e));
              console.error("[dsh-media] voice/image node 注册失败:", e);
              return () => {};
            }
          })(),
          safeInject("conversation.chat.node", () => ctx.slots.register(
            { name: "conversation.chat.node", key: "voice-reply", locale: "conversation" }, VoiceReplyRow)),
          safeInject("conversation.chat.node", () => ctx.slots.register(
            { name: "conversation.chat.node", key: "image-reply", locale: "conversation" }, ImageReplyRow)),
          // [2026-09-26 搬迁收尾] 设置页 7 个 settings.section 旧注册已删除：
          // 语音服务/图片识别/全局人设/MCP/Skill/提示词优化/决策模型 的唯一入口 = 插件页卡片详情。
          // [2026-09-26 案1收尾] conversation.chat.voice-actions 注册已删（挂点孤儿，
          // 复制钮已内置于 VoiceCardBar；官方 MessageIconActions 同批还原零改动）。
          // [2026-09-25 老大定稿 /de 副驾] 注册进官方命令口 commandUi：composer 的「+」菜单与敲 "/"
          // 打开的是同一个菜单（官方 ui-commands README 明写），所以不造按钮，/de 自然出现在 + 里。
          // 🔴 只在服务真读得到时注册，绝不为了拿到它去改 exports.inject —— 声明一个不存在的名字
          // 会让整条 fiber 永远 PENDING，⚡/语音/图片会跟着一起没了。
          (() => {
            // [2026-09-25 修 /de 上线后消失] 原来第一句就读 ctx.commandUi：官方 AGENTS.md 明写
            // 属性代理是拓扑敏感的，没声明的服务名可能**直接抛**，那会把整条 disposers 数组连带炸掉
            // —— ⚡/语音/图片/设置分区会一起没了。现在 ctx.get 优先、整体裹 try，最坏只是 /de 不注册。
            let commandUi = null;
            try {
              commandUi = (typeof ctx.get === "function" ? ctx.get("commandUi") : null) || ctx.commandUi || null;
            } catch (err) {
              try { console.warn("[dsh-de] 读 commandUi 抛错: " + (err && err.message ? err.message : err)); } catch { /* 忽略 */ }
              return () => {};
            }
            if (!commandUi || typeof commandUi.register !== "function") {
              try { console.warn("[dsh-de] commandUi 服务读不到，/de 未注册（下一步：加进 exports.inject 声明注入）"); } catch { /* 忽略 */ }
              return () => {};
            }
            let dispose = null;
            try {
              dispose = commandUi.register({
                name: "de",
                label: () => "副驾候选",
                description: () => "读本会话全量上下文，给 3 条回复候选（只填入输入框，绝不发送）",
                available: () => true,
                ui: {
                  kind: "popupSelect",
                  options: async (session) => {
                    // [2026-09-25 老大加令] 全文可见：官方命令弹窗的行是 nowrap+ellipsis
                    // （packages/client/ui-commands/src/client/PopupSelectView.module.css:63-65），
                    // 我不截断也会被它吞成「…」—— 所以注入一段样式改回可换行，并把 24 条读到 60 条。
                    // [2026-09-25 老大实测「叫停/推荐/收窄那些文本被压缩得看不见」]
                    // 官方行是 nowrap+ellipsis（PopupSelectView.module.css .labelText:63-65、.detail:84-86），
                    // 正文一长、元信息一长就各自被吞成「…」；上一版我用全局 [role=listbox] 覆盖，
                    // 会把别的命令弹窗一起改掉。这版：认出含「拟用 」的 listbox 单独打 dsh-de-pop 类，
                    // 整行改成竖排两行（正文一行、角色/拟用/风险/量级/上下文一行），谁也不许省略。
                    try {
                      if (!window.__dshDeStyle) {
                        const st = document.createElement("style");
                        st.id = "dsh-de-wrap";
                        st.textContent = '.dsh-de-pop [class*="row"]{flex-wrap:wrap;align-items:flex-start;row-gap:2px;height:auto!important;min-height:0!important;}'
                          + '.dsh-de-pop [class*="label"]{flex:1 1 100%;min-width:0;align-items:flex-start;}'
                          + '.dsh-de-pop [class*="labelText"]{white-space:normal!important;text-overflow:clip!important;overflow:visible!important;line-height:1.45;}'
                          + '.dsh-de-pop [class*="detail"]{flex:1 1 100%;white-space:normal!important;text-overflow:clip!important;overflow:visible!important;line-height:1.35;}'
                          + '.dsh-de-pop [class*="badge"]{font-size:10px;line-height:12px;align-self:center;}'
                          // 🔴 [2026-09-25 老大截图：弹窗下面空一大片] 元凶就是这行上一版的写法：
                          // `div:has(.dsh-de-pop)` 是**后代**选择器，会命中弹窗外面每一层容器，
                          // 把外层一起撑高 → 卡片底下多出一大片空的圆角区。只准命中"直接父级"。
                          + 'div:has(> [role="listbox"].dsh-de-pop){max-height:min(60vh,520px)!important;}';
                        document.head.appendChild(st);
                        const mark = () => {
                          const lbs = document.querySelectorAll('[role="listbox"]');
                          for (let k = 0; k < lbs.length; k++) {
                            const lb = lbs[k];
                            const txt = lb.textContent || "";
                            if (txt.indexOf("拟用 ") >= 0 && txt.indexOf("上下文 ") >= 0) lb.classList.add("dsh-de-pop");
                          }
                        };
                        mark();
                        const mo = new MutationObserver(mark);
                        mo.observe(document.body, { childList: true, subtree: true });
                        window.__dshDeStyle = { st: st, mo: mo };
                      }
                    } catch { /* 样式注入失败不拦候选 */ }
                    const sidStr = String((session && session.sessionId) || "");
                    // 🔴 [2026-09-25 老大报的 bug：手机电脑都有] 弹窗一点别处/切走窗口就关（官方行为，
                    // 不是我们写的），回来重开时旧代码又整批重跑一遍 → 三条内容变了，等于没法选。
                    // 3 分钟内重开直接给**同一批**，并在行尾标是几秒前生成的，让他知道没重跑。
                    const cached = window.__dshDeCache;
                    if (cached && cached.sid === sidStr && Array.isArray(cached.opts) && cached.opts.length && Date.now() - cached.at < 180000) {
                      const age = Math.max(1, Math.round((Date.now() - cached.at) / 1000));
                      return cached.opts.map((o) => Object.assign({}, o, { detail: o.detail + "｜同一批 · " + age + " 秒前生成（切走再回来不重跑）" }));
                    }
                    const r = await fetch("/copilot-analyze", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        sessionId: String((session && session.sessionId) || ""),
                        // [2026-09-25 老大] 「拉最近 50 条太多，10-15 条够了」——与飞书侧 de.historyTurns 对齐
                        contextTurns: 15,
                        counterpart: "ai",
                      }),
                    });
                    const j = await r.json().catch(() => null);
                    if (!r.ok || !j || j.ok === false) {
                      throw new Error((j && (j.error || (j.probe && (j.probe.reason || ((j.probe.tried || []).join(" ｜ ")))))) || ("副驾调用失败 HTTP " + r.status));
                    }
                    const list = Array.isArray(j.candidates) ? j.candidates : [];
                    if (list.length === 0) throw new Error("副驾没给出候选（判断或起草模型没返回）");
                    const cx = j.context || {};
                    // 上下文厚度直接印在每一行上：够不够支撑判断你自己看得见，不用信我嘴说。
                    const thick = "上下文 " + (cx.rows ?? "?") + "条/" + (cx.chars ?? 0) + "字"
                      + "｜记忆" + (cx.memoryLines ?? 0) + "条" + (cx.hasProfile ? "·画像有" : "·无画像")
                      + (cx.openmemDisabled ? "（openmem 已关）" : cx.openmemDegraded ? "（openmem 没通）" : "");
                    const opts = list.map((c, i) => {
                      const t = String((c && c.text) || "").replace(/[​⁠]/g, " ").replace(/\s+/g, " ").trim();
                      return {
                        id: t,
                        // 🔴 全文进 label，一个字符都不删（"看不到全文就没法判断用不用"）
                        label: t,
                        // [2026-09-26 老大选 C] 撤掉「拟用 XX%」「风险 mid」「量级 large」「(方案A)」这些内部词标签：
                        // 百分比是决策模型在**只喂了候选前 120 字、八维判断一个字没喂**的情况下硬凑的分布，
                        // 没有预测力，还把猜的数伪装成数据。三条并列，顺序不代表推荐，他自己挑。
                        // 只留上下文厚度这一项 —— 那是可核对的事实（几条几字、有没有画像），不是模型的意见。
                        detail: thick,
                        badge: undefined,
                        active: i === 0,
                      };
                    });
                    window.__dshDeCache = { sid: sidStr, at: Date.now(), opts: opts };
                    return opts;
                  },
                  // 只做一件事：把选中那条写进输入框，光标留给你。回车、发送、剪贴板都不是它该干的。
                  onSelect: async (option) => {
                    const text = String((option && option.id) || "");
                    if (text === "") return;
                    if (typeof sharedComposerFill !== "function") throw new Error("输入框还没就绪，稍等一下再敲 /de");
                    const ok = await sharedComposerFill(text);
                    if (!ok) {
                      const saved = await copyClipboardSafe(text);
                      console.warn("[dsh-de] 写入输入框没生效，" + (saved ? "已放剪贴板，你去输入框 Ctrl+V" : "剪贴板也没写成，请手动复制"));
                    }
                  },
                },
              });
            } catch (err) {
              try { console.warn("[dsh-de] 注册 /de 失败: " + (err && err.message ? err.message : err)); } catch { /* 忽略 */ }
            }
            return typeof dispose === "function" ? dispose : () => {};
          })(),
        ];
        return () => { for (const d of disposers) d(); };
      }, "dsh-input-tools: toolbar");
      } catch (e) {
        try { console.error("[dsh-input-tools] apply catch:", e && e.message ? e.message : e); } catch { /* ignore */ }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
