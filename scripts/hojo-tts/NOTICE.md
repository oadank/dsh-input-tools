# 第三方代码归属（NOTICE）

## Hojo-TTS-Light-40M

- 权重（`models-40m/` 内的 4 个 onnx/npz + tokenizer/config）：HuggingFace `HojoAI/Hojo-TTS-Light-40M`
  安装脚本从 `https://huggingface.co/HojoAI/Hojo-TTS-Light-40M/resolve/main/<文件名>` 拉取（失败自动切 `hf-mirror.com`）。权重**不入库**，随装随下。
- 推理代码 `onnx_model.py`：上游 GitHub `HojoAI/Hojo-TTS-Light` 的 `Hojo-TTS-Light-40M/onnx_model.py`，
  **逐字节未改**（2026-10-05 校验 SHA256 `C3761B388F03F9019B76F3BF3A0099AF8DD5371F5C2D7F703147B4975D00D0EA`）。
- 许可证：Apache License 2.0，全文见同目录 `LICENSE-Hojo-TTS-Light-40M.txt`（随代码一同分发）。

## 本插件自有的部分

- `server.py`（HTTP 常驻服务包装：拆句/重试/采样策略/ffmpeg 兜底探测）由本插件作者编写，不属上游。
- 音色：仅使用上游预置音色库（`Hojo-TTS-Light-40M-voice.npz`），无克隆功能。
