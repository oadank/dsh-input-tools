#!/usr/bin/env python3
"""Hojo-TTS-Light-40M 本地 HTTP TTS 常驻服务（dsh-input-tools 内置本地 TTS）。

契约（与 dsh-input-tools「本地 TTS」地址模式一致）：
  POST /tts   {"text": "..."}  -> 200 audio/mpeg | 400 text required | 500 message
  GET  /health                 -> 200 JSON {status, engine, voice, models_dir, split_threshold}
  其它路径                      -> 404

设计要点
  * 只用 40M 预置音色（无克隆接口）。
  * 模型常驻进程内存，不随请求重载。
  * 长文本按句拆段合成再拼（避免 Token-LM 长序列尾部漂移/乱码）：
      总长 >= HOJO_SPLIT_CHARS 且多句 -> 拆；单段上限 HOJO_CHUNK_MAX；段间静音 HOJO_GAP_MS
      拆过的长段用更紧的采样（HOJO_TEMP_LONG / HOJO_REP_LONG），每段记录 stop=eos|max_tokens，
      非 eos 自动用 HOJO_TEMP_RETRY 重试一次。
  * 依赖极简：numpy + onnxruntime + onnx + tokenizers + soundfile（+ 系统 ffmpeg 转 mp3）。
    推理代码 onnx_model.py 与上游 HojoAI/Hojo-TTS-Light 逐字节一致，见同目录 LICENSE-Hojo-TTS-Light-40M.txt。

路径解析（按顺序，命中即用；都可用环境变量覆盖）
  HOJO_MODELS   直接指定权重目录（含 4 个权重文件 + tokenizer/config）
  否则依次探测：
    1) %USERPROFILE%\\.dsh\\hojo-tts\\models-40m      （插件安装脚本默认家）
    2) C:\\D\\opt\\hojo-tts-light\\models-40m          （lecoo 既有安装）
    3) D:\\opt\\hojo-tts-light\\models-40m             （XDN 既有安装）
  FFMPEG        指定 ffmpeg.exe；否则用 PATH 里的 ffmpeg
  PORT / HOST / HOJO_VOICE / HOJO_VOLUME / HOJO_SPLIT_CHARS / HOJO_CHUNK_MAX / HOJO_GAP_MS
  HOJO_TEMP_LONG / HOJO_TEMP_RETRY / HOJO_REP_LONG
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _resolve_models_dir() -> Path:
    env = os.environ.get("HOJO_MODELS", "").strip()
    if env:
        return Path(env)
    home = os.environ.get("USERPROFILE") or str(Path.home())
    for cand in (
        Path(home) / ".dsh" / "hojo-tts" / "models-40m",
        Path(r"C:\D\opt\hojo-tts-light\models-40m"),
        Path(r"D:\opt\hojo-tts-light\models-40m"),
    ):
        if (cand / "Hojo-TTS-Light-40M-llm.onnx").is_file():
            return cand
    return Path(home) / ".dsh" / "hojo-tts" / "models-40m"


MODELS = _resolve_models_dir()
CODE = HERE  # onnx_model.py 与本文件同目录

PORT = int(os.environ.get("PORT", "18792"))
HOST = os.environ.get("HOJO_HOST", "127.0.0.1")
DEFAULT_VOICE = os.environ.get("HOJO_VOICE", "hojo_zh_f_01")
VOLUME = float(os.environ.get("HOJO_VOLUME", "1.0"))
SPLIT_THRESHOLD = int(os.environ.get("HOJO_SPLIT_CHARS", "50"))
CHUNK_MAX_CHARS = int(os.environ.get("HOJO_CHUNK_MAX", "60"))
GAP_MS = int(os.environ.get("HOJO_GAP_MS", "80"))
MAX_BODY = 1024 * 1024

TEMP_LONG = float(os.environ.get("HOJO_TEMP_LONG", "0.65"))
TEMP_RETRY = float(os.environ.get("HOJO_TEMP_RETRY", "0.5"))
REP_LONG = float(os.environ.get("HOJO_REP_LONG", "1.15"))

def _resolve_ffmpeg() -> str:
    """定位 ffmpeg。

    🔴 服务以 LocalSystem 身份跑时，PATH 里没有用户级的 winget Links，且 USERPROFILE
      指向 C:\\Windows\\system32\\config\\systemprofile —— 只认 PATH 或只看"当前用户目录"
      都会 FileNotFoundError:[WinError 2]（2026-10-05 实机踩中两次）。
      顺序：FFMPEG 环境变量 -> PATH -> 已知固定位置 -> 各用户 profile 的 winget/scoop 位置。
    """
    import shutil

    env = (os.environ.get("FFMPEG") or "").strip()
    if env and (Path(env).is_file() or shutil.which(env)):
        return env
    w = shutil.which("ffmpeg")
    if w:
        return w

    cands: list[Path] = []
    home = (os.environ.get("USERPROFILE") or "").strip()
    if home:
        cands.append(Path(home) / "AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe")
    cands += [
        Path(r"C:\D\opt\ffmpeg\bin\ffmpeg.exe"),
        Path(r"D:\opt\ffmpeg\bin\ffmpeg.exe"),
        Path(r"C:\ffmpeg\bin\ffmpeg.exe"),
        Path(r"D:\ffmpeg\bin\ffmpeg.exe"),
        Path(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe"),
    ]
    for drive in ("C:", "D:"):
        root = Path(drive + "\\")
        for pat in (
            "Users/*/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe",
            "Users/*/scoop/shims/ffmpeg.exe",
        ):
            try:
                cands.extend(root.glob(pat))
            except (OSError, ValueError):
                pass
    for c in cands:
        try:
            if c.is_file():
                return str(c)
        except OSError:
            pass
    return env or "ffmpeg"


FFMPEG = _resolve_ffmpeg()

if str(CODE) not in sys.path:
    sys.path.insert(0, str(CODE))

_lock = threading.Lock()
_tts = None
_load_error: str | None = None


def get_tts():
    global _tts, _load_error
    if _tts is not None:
        return _tts
    with _lock:
        if _tts is not None:
            return _tts
        t0 = time.time()
        from onnx_model import HojoTTSLightOnnx

        _tts = HojoTTSLightOnnx(str(MODELS))
        print(f"hojo model loaded in {time.time() - t0:.2f}s from {MODELS}", flush=True)
        return _tts


def split_sentences(text: str) -> list[str]:
    """Split into speakable chunks; never returns empty list."""
    parts = [p.strip() for p in re.split(r"(?<=[。！？；!?;])", text) if p and p.strip()]
    out: list[str] = []
    for part in parts:
        if len(part) <= CHUNK_MAX_CHARS:
            out.append(part)
            continue
        subs = [s for s in re.split(r"(?<=[，,、])", part) if s]
        buf = ""
        for s in subs:
            if buf and len(buf) + len(s) > CHUNK_MAX_CHARS:
                out.append(buf.strip())
                buf = s
            else:
                buf += s
        if buf.strip():
            out.append(buf.strip())
    if not out:
        out = [text.strip()]
    return out


def _generate_chunk(tts, text: str, *, seed: int, temperature: float, repetition_penalty: float):
    """Return (wav1d, stop, n_tokens) where stop is 'eos' | 'max_tokens'."""
    import numpy as np
    from onnx_model import build_speaker_prompt, wav_from_mag_phase

    np.random.seed(seed)
    prompt = build_speaker_prompt(text)
    input_ids = tts.tokenizer(prompt, add_special_tokens=True, return_tensors="np")[
        "input_ids"
    ].astype(np.int64)
    speaker_embeds = tts.voices.get_speaker_embeds(DEFAULT_VOICE)
    speaker_vec = tts.voices.get_speaker_vec(DEFAULT_VOICE)

    max_new = 2048
    min_new = 10
    generated, last_hidden = tts._generate_coarse_tokens(
        input_ids,
        speaker_embeds,
        max_new_tokens=max_new,
        min_new_tokens=min_new,
        temperature=temperature,
        top_p=0.95,
        repetition_penalty=repetition_penalty,
    )
    stop = "eos" if bool(np.any(generated == tts.speech_end_id)) else "max_tokens"
    bits = tts._bits_from_coarse(input_ids, generated, last_hidden, speaker_vec)
    mag, phase = tts.codec_decode.run(None, {"bits": bits})
    wav = wav_from_mag_phase(mag, phase, tts.istft)
    return np.asarray(wav, dtype=np.float32).reshape(-1), stop, len(generated)


def synthesize_wav(text: str):
    """Synthesize full text (split if needed). Returns (wav, log_fields)."""
    import numpy as np

    tts = get_tts()
    text = text.strip()
    chunks_all = split_sentences(text)
    do_split = len(text) >= SPLIT_THRESHOLD and len(chunks_all) > 1
    chunks = chunks_all if do_split else [text]
    sr = int(getattr(tts, "sample_rate", 24000))
    gap = np.zeros(int(sr * GAP_MS / 1000), dtype=np.float32)

    t0 = time.time()
    parts: list[np.ndarray] = []
    stops: list[str] = []
    retries = 0
    with _lock:
        for i, chunk in enumerate(chunks):
            longish = len(chunk) >= SPLIT_THRESHOLD or do_split
            temp = TEMP_LONG if longish else 0.8
            rep = REP_LONG if longish else 1.1
            seed = 42 + i
            wav, stop, ntok = _generate_chunk(
                tts, chunk, seed=seed, temperature=temp, repetition_penalty=rep
            )
            if stop != "eos":
                retries += 1
                print(
                    f"warn stop={stop} chunk#{i} chars={len(chunk)} tokens={ntok} — retry T={TEMP_RETRY}",
                    flush=True,
                )
                wav, stop, ntok = _generate_chunk(
                    tts, chunk, seed=seed, temperature=TEMP_RETRY, repetition_penalty=max(rep, 1.2)
                )
            stops.append(stop)
            parts.append(wav.astype(np.float32, copy=False))
            if i < len(chunks) - 1:
                parts.append(gap)
            print(
                f"  chunk#{i}/{len(chunks)} chars={len(chunk)} stop={stop} tokens={ntok} "
                f"audio={len(wav)/sr:.2f}s",
                flush=True,
            )
    elapsed = time.time() - t0
    wav = np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)
    if VOLUME and abs(VOLUME - 1.0) > 1e-6:
        wav = np.clip(wav * VOLUME, -1.0, 1.0).astype(np.float32)
    audio_s = len(wav) / max(sr, 1)
    meta = {
        "chunks": len(chunks),
        "split": do_split,
        "stops": stops,
        "retries": retries,
        "audio_s": round(audio_s, 2),
        "wall_s": round(elapsed, 2),
        "rtf": round(elapsed / max(audio_s, 1e-9), 3),
        "sr": sr,
    }
    return wav, meta


def encode_mp3(wav, sr: int) -> bytes:
    import soundfile as sf

    td = tempfile.mkdtemp(prefix="hojo-tts-")
    wav_path = Path(td) / "out.wav"
    mp3_path = Path(td) / "out.mp3"
    try:
        sf.write(str(wav_path), wav, sr, subtype="PCM_16")
        import subprocess

        try:
            subprocess.run(
                [
                    FFMPEG,
                    "-y",
                    "-i",
                    str(wav_path),
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "128k",
                    str(mp3_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except FileNotFoundError as e:
            raise RuntimeError(
                f"ffmpeg 不可用（当前解析值: {FFMPEG!r}）：请在服务环境变量里设 FFMPEG=<ffmpeg.exe 完整路径>，"
                "或把 ffmpeg 所在目录加入系统 PATH。"
            ) from e
        return mp3_path.read_bytes()
    finally:
        try:
            wav_path.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            mp3_path.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            Path(td).rmdir()
        except OSError:
            pass


def synthesize_mp3(text: str) -> bytes:
    wav, meta = synthesize_wav(text)
    mp3 = encode_mp3(wav, meta["sr"])
    print(
        f"synth chars={len(text)} chunks={meta['chunks']} split={meta['split']} "
        f"stops={','.join(meta['stops'])} retries={meta['retries']} "
        f"audio={meta['audio_s']}s wall={meta['wall_s']}s rtf={meta['rtf']}",
        flush=True,
    )
    if any(s != "eos" for s in meta["stops"]):
        print(f"WARN non-eos after retry: {meta['stops']}", flush=True)
    return mp3


class Handler(BaseHTTPRequestHandler):
    server_version = "hojo-tts40/1.2"

    def log_message(self, fmt: str, *args) -> None:
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            payload = json.dumps(
                {
                    "status": "ok" if _tts is not None else "starting",
                    "engine": "hojo-tts-light-40m",
                    "voice": DEFAULT_VOICE,
                    "models_dir": str(MODELS),
                    "split_threshold": SPLIT_THRESHOLD,
                }
            ).encode()
            self._send(200, payload, "application/json")
            return
        self._send(404, b"not found", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/tts":
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send(400, b"text required", "text/plain; charset=utf-8")
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
            text = (payload.get("text") or "").strip() if isinstance(payload, dict) else ""
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, b"text required", "text/plain; charset=utf-8")
            return
        if not text:
            self._send(400, b"text required", "text/plain; charset=utf-8")
            return
        try:
            audio = synthesize_mp3(text)
            if not audio:
                raise RuntimeError("empty audio")
            self._send(200, audio, "audio/mpeg")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            msg = str(e).encode("utf-8", errors="replace") or b"synthesis failed"
            self._send(500, msg, "text/plain; charset=utf-8")


def preload() -> None:
    global _load_error
    try:
        get_tts()
    except Exception as e:  # noqa: BLE001
        _load_error = str(e)
        traceback.print_exc()


def main() -> None:
    if not (MODELS / "Hojo-TTS-Light-40M-llm.onnx").is_file():
        raise SystemExit(f"missing Hojo 40M weights: {MODELS}")
    if not (CODE / "onnx_model.py").is_file():
        raise SystemExit(f"missing onnx_model.py next to server.py: {CODE}")
    threading.Thread(target=preload, daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"hojo-tts40 listening on {HOST}:{PORT} voice={DEFAULT_VOICE} "
        f"split>={SPLIT_THRESHOLD} chunk_max={CHUNK_MAX_CHARS} models={MODELS}",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
