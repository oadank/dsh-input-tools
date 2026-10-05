#!/usr/bin/env python3
"""把 dsh-input-tools 的「本地 TTS」指向本机 Hojo 常驻服务（供 install-local-tts.ps1 调用）。

用法：python set-voice-config.py <voice-config.json 路径> <http://127.0.0.1:18792/tts>

设计要点
  * 插件的 loadVoiceConfig() 按 **文件 mtime** 实时重读（index.js:261）⇒ 外部改这份 JSON 立即生效，不用重启。
  * 只动 engines.local 两个键，其余原样保留（indent=2 / ensure_ascii=False，与插件自身写盘风格一致，无 BOM）。
  * cmd 只在**它确实指向已废弃的 local-tts.mjs** 时才清空——用户自己写的别的本地命令不动（新版 url 失败会回落 cmd）。
"""

import json
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("用法: set-voice-config.py <voice-config.json> <url>")
        return 2
    path, url = sys.argv[1], sys.argv[2]
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    engines = data.setdefault("engines", {})
    local = engines.setdefault("local", {})
    old_url = local.get("url", "")
    old_cmd = local.get("cmd", "")
    local["url"] = url
    if isinstance(old_cmd, str) and "local-tts.mjs" in old_cmd:
        local["cmd"] = ""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"url: {old_url!r} -> {local['url']!r}; cmd: {old_cmd!r} -> {local['cmd']!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
