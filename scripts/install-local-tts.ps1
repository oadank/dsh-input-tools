# ============================================================
# dsh-input-tools 本地 TTS 一键安装脚本（Windows）—— Hojo-TTS-Light-40M
#
# 装什么：
#   1. Hojo-TTS-Light-40M 权重 4 个 + tokenizer/config（约 240MB，从 HuggingFace 拉）
#   2. 专用瘦 venv（只装 onnxruntime / onnx / numpy / tokenizers / soundfile，约 170MB）
#   3. 常驻 HTTP 服务 server.py（127.0.0.1:18792，nssm 托管，开机自启）
#   4. 自动自检：/health + 真合成一段 mp3（不出声算失败）
#
# 🔴 与旧版（MeloTTS + sherpa-onnx）的区别：
#   旧版装 sherpa-onnx 二进制 + MeloTTS VITS 模型，走「本地命令 node local-tts.mjs <文本> → stdout mp3」；
#   本版跑常驻服务，走「本地 TTS 地址 http://127.0.0.1:18792/tts」——模型常驻内存，出声更快、无冷启动。
#   本脚本不再下载 sherpa-onnx / MeloTTS；残留的 models\melo 只提示、不自动删（它和 ASR 的 sensevoice 同树，别误伤）。
#
# 安装位置（按顺序探测，命中即复用；都可用 -InstallDir 覆盖）：
#   1) -InstallDir 显式指定
#   2) %USERPROFILE%\.dsh\hojo-tts      （本插件资产默认家）
#   3) C:\D\opt\hojo-tts-light          （lecoo 既有安装）
#   4) D:\opt\hojo-tts-light            （XDN 既有安装）
#
# 用法（普通 PowerShell 即可；注册服务那步会自动弹 UAC）：
#   powershell -ExecutionPolicy Bypass -File install-local-tts.ps1
#   powershell -ExecutionPolicy Bypass -File install-local-tts.ps1 -InstallDir D:\opt\hojo-tts-light
#   powershell -ExecutionPolicy Bypass -File install-local-tts.ps1 -SkipService      # 只装文件，不碰服务
#   powershell -ExecutionPolicy Bypass -File install-local-tts.ps1 -Force           # 权重/venv 重做
# ============================================================
[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [switch]$SkipService,
  [switch]$Force,
  [switch]$ElevatedRun
)

$ErrorActionPreference = "Stop"
$Service = "dsh-local-tts"
$Port = 18792
$HFRepo = "HojoAI/Hojo-TTS-Light-40M"
$HFHosts = @("https://huggingface.co", "https://hf-mirror.com")
$PluginScripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcDir = Join-Path $PluginScripts "hojo-tts"

# 权重清单：文件名 = 最小合格字节数（防半截文件/HTML 错误页）
$Weights = [ordered]@{
  "Hojo-TTS-Light-40M-llm.onnx"        = 55000000
  "Hojo-TTS-Light-40M-fine_local.onnx" = 22000000
  "Hojo-TTS-Light-40M-decoder.onnx"    = 100000000
  "Hojo-TTS-Light-40M-voice.npz"       = 30000000
  "config.json"                        = 500
  "tokenizer.json"                     = 1000000
  "tokenizer_config.json"              = 100
}
$PipPkgs = @("onnxruntime", "onnx", "numpy", "tokenizers", "soundfile")

function Log([string]$m, [string]$c = "Gray") { Write-Host $m -ForegroundColor $c }

# ---------- 下载（断点续传；HF 主站失败自动切镜像） ----------
function Download-HF {
  param([string]$Name, [string]$Dest)
  foreach ($host_ in $HFHosts) {
    $url = "$host_/$HFRepo/resolve/main/$Name"
    for ($try = 1; $try -le 5; $try++) {
      Log "  下载 $Name （$host_ 第 $try 次）" Yellow
      $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
      $err = cmd /c "curl.exe -fL -C - --retry 3 --retry-delay 2 --connect-timeout 20 -o `"$Dest`" `"$url`" 2>&1"
      $code = $LASTEXITCODE
      $ErrorActionPreference = $prev
      if ($code -eq 0) { return $true }
      Log "  中断（exit=$code $($err | Select-Object -Last 1)），5 秒后重试" Yellow
      Start-Sleep -Seconds 5
    }
  }
  return $false
}

# ---------- 0. 定位安装目录 ----------
if ($InstallDir -eq "") {
  foreach ($c in @("$env:USERPROFILE\.dsh\hojo-tts", "C:\D\opt\hojo-tts-light", "D:\opt\hojo-tts-light")) {
    if (Test-Path (Join-Path $c "models-40m\Hojo-TTS-Light-40M-llm.onnx")) { $InstallDir = $c; break }
  }
  if ($InstallDir -eq "") { $InstallDir = "$env:USERPROFILE\.dsh\hojo-tts" }
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
Log "==== dsh 本地 TTS 一键安装（Hojo-TTS-Light-40M）====" Cyan
Log "安装目录: $InstallDir"

$ErrLog = Join-Path $env:TEMP "hojo-install-err.log"
trap {
  $msg = "`n[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] 安装失败（行 $($_.InvocationInfo.ScriptLineNumber)）:`n$_`n"
  Add-Content -Path $ErrLog -Value $msg -ErrorAction SilentlyContinue
  Write-Host $msg -ForegroundColor Red
  exit 1
}

$ModelsDir = Join-Path $InstallDir "models-40m"
$VenvDir = Join-Path $InstallDir ".venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
$LogsDir = Join-Path $InstallDir "logs"
$TmpDir = Join-Path $InstallDir "tmp"
foreach ($d in @($InstallDir, $ModelsDir, $LogsDir, $TmpDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---------- 1. ffmpeg（wav → mp3） ----------
Log "`n[1/6] 检查 ffmpeg..." Yellow
$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegCmd) {
  Log "  未找到 ffmpeg，尝试 winget 安装..." Yellow
  try {
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  } catch { }
}
if (-not $ffmpegCmd) { Log "  ❌ 没有 ffmpeg，无法转 mp3。请先装 ffmpeg 并加入 PATH（或设 FFMPEG 环境变量指向 exe）" Red; exit 1 }
$FfmpegExe = $ffmpegCmd.Source
Log "  ffmpeg: $FfmpegExe" Green

# ---------- 2. 权重 ----------
Log "`n[2/6] 检查 Hojo 40M 权重（$HFRepo）..." Yellow
foreach ($f in $Weights.Keys) {
  $p = Join-Path $ModelsDir $f
  $min = $Weights[$f]
  $ok = (Test-Path $p) -and ((Get-Item $p).Length -ge $min)
  if ($ok -and -not $Force) { Log ("  ok   {0,-40} {1,12:N0} B" -f $f, (Get-Item $p).Length) Green; continue }
  if (-not $ok -and (Test-Path $p)) { Log ("  半截/异常的旧文件，重下: $f") Yellow; Remove-Item $p -Force }
  if (-not (Download-HF -Name $f -Dest $p)) { Log "  ❌ $f 下载失败（HF 主站与镜像都不通）。检查网络/代理后重跑本脚本" Red; exit 1 }
  if ((Get-Item $p).Length -lt $min) { Log "  ❌ $f 大小不足（$((Get-Item $p).Length) < $min），删除后请重跑" Red; Remove-Item $p -Force; exit 1 }
  Log ("  下载完成 {0,-40} {1,12:N0} B" -f $f, (Get-Item $p).Length) Green
}

# ---------- 3. 瘦 venv ----------
Log "`n[3/6] 准备 Python venv（只装 $($PipPkgs -join ' / ')）..." Yellow
if (-not (Test-Path $VenvPy)) {
  # 🔴 逐个"试跑"找可用 Python，别只看 Get-Command：`py` 启动器在某些调用姿势下直接
  #   "Program 'py' failed to run: The operation attempted is not supported"（2026-10-05 实机踩中）。
  $cands = @(
    @{ Exe = "python";      Pre = @() },
    @{ Exe = "python3";     Pre = @() },
    @{ Exe = "py";          Pre = @("-3.12") },
    @{ Exe = "py";          Pre = @("-3.11") },
    @{ Exe = "py";          Pre = @("-3") },
    @{ Exe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"; Pre = @() },
    @{ Exe = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"; Pre = @() },
    @{ Exe = "C:\Python312\python.exe"; Pre = @() }
  )
  $sysExe = $null; $sysPre = @()
  foreach ($c in $cands) {
    if (-not (Get-Command $c.Exe -ErrorAction SilentlyContinue) -and -not (Test-Path $c.Exe)) { continue }
    $pre = $c.Pre
    try {
      $ver = & $c.Exe @pre -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0 -and "$ver" -match '^3\.(\d+)$' -and [int]$Matches[1] -ge 10) { $sysExe = $c.Exe; $sysPre = $pre; break }
    } catch { }
  }
  if (-not $sysExe) { Log "  ❌ 找不到可用的 Python 3.10+（python.org 版要勾 Add to PATH）" Red; exit 1 }
  Log "  用 $sysExe $($sysPre -join ' ') 建 venv -> $VenvDir"
  & $sysExe @sysPre -m venv $VenvDir
}
if (-not (Test-Path $VenvPy)) { Log "  ❌ venv 创建失败：$VenvPy 不存在" Red; exit 1 }
try {
  $vver = & $VenvPy -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
  Log "  venv python: $VenvPy ($vver)" Green
} catch { }

$needInstall = $true
try {
  $have = & $VenvPy -c "import importlib.util as u,sys;print(all(u.find_spec(m) for m in ['onnxruntime','onnx','numpy','tokenizers','soundfile']))" 2>$null
  if ($have -match "True" -and -not $Force) { $needInstall = $false }
} catch { }
if ($needInstall) {
  Log "  安装依赖（约 170MB，首次较慢）..."
  $indexes = @("https://pypi.tuna.tsinghua.edu.cn/simple", "https://pypi.org/simple")
  $okPip = $false
  foreach ($idx in $indexes) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $VenvPy -m pip install --no-cache-dir --upgrade pip -i $idx *> $null
    & $VenvPy -m pip install --no-cache-dir -i $idx @PipPkgs *> $null
    $pipCode = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($pipCode -eq 0) { $okPip = $true; break }
    Log "  源 $idx 失败（exit=$pipCode），换下一个" Yellow
  }
  if (-not $okPip) { Log "  ❌ 依赖安装失败，检查网络/代理后重跑" Red; exit 1 }
} else {
  Log "  依赖已齐，跳过" Green
}
$venvMB = [math]::Round(((Get-ChildItem $VenvDir -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 1)
Log "  venv 体积: $venvMB MB" Green

# ---------- 4. 服务端代码（从插件包拷进安装目录，自包含） ----------
Log "`n[4/6] 拷入服务端代码..." Yellow
foreach ($f in @("server.py", "onnx_model.py", "set-voice-config.py", "LICENSE-Hojo-TTS-Light-40M.txt")) {
  $src = Join-Path $SrcDir $f
  if (-not (Test-Path $src)) { Log "  ❌ 插件包内缺少 scripts\hojo-tts\$f —— 插件版本太旧，请更新插件" Red; exit 1 }
  Copy-Item $src (Join-Path $InstallDir $f) -Force
  Log "  $f -> $InstallDir" Green
}

# ---------- 5. 自检：先用临时实例验（不碰正式端口/服务） ----------
Log "`n[5/6] 自检（临时实例，端口 18780）..." Yellow
$env:PYTHONUTF8 = "1"
# 自检用的临时端口（HOJO_SELFTEST_PORT 可覆盖，便于并行/端口被占时避让）
$tmpPort = if ($env:HOJO_SELFTEST_PORT) { [int]$env:HOJO_SELFTEST_PORT } else { 18780 }
$oldPort = $env:PORT
$env:PORT = "$tmpPort"
$proc = Start-Process -FilePath $VenvPy -ArgumentList (Join-Path $InstallDir "server.py") -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogsDir "selftest-out.log") -RedirectStandardError (Join-Path $LogsDir "selftest-err.log")
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  try { $h = Invoke-RestMethod "http://127.0.0.1:$tmpPort/health" -TimeoutSec 3; if ($h.status -eq "ok") { $ready = $true; break } } catch { }
}
$testOk = $false
$testBytes = 0
if ($ready) {
  try {
    $body = [Text.Encoding]::UTF8.GetBytes('{"text":"本地语音服务自检，能出声就成。"}')
    # -UseBasicParsing 必须加：PS 5.1 默认拉 IE COM 解析响应，对二进制(audio/mpeg)会抛 NullReferenceException
    $r = Invoke-WebRequest "http://127.0.0.1:$tmpPort/tts" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 180 -UseBasicParsing
    $testBytes = $r.RawContentLength
    $testOk = ($r.StatusCode -eq 200) -and ($r.Headers["Content-Type"] -like "audio/mpeg*") -and ($testBytes -gt 8000)
  } catch { Log "  合成失败: $($_.Exception.Message)" Red }
}
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
$env:PORT = $oldPort
if (-not $testOk) {
  Log "  ❌ 自检不过（health=$ready bytes=$testBytes）。看日志：$LogsDir\selftest-out.log / selftest-err.log" Red
  Get-Content (Join-Path $LogsDir "selftest-err.log") -Tail 12 -ErrorAction SilentlyContinue
  exit 1
}
Log "  ✅ 自检通过：health ok，合成 $testBytes 字节 mp3" Green

# ---------- 6. 常驻服务（nssm） ----------
if ($SkipService) {
  Log "`n[6/6] -SkipService：跳过服务注册。手起服务：" Yellow
  Log "  set PORT=$Port && `"$VenvPy`" `"$InstallDir\server.py`"" Cyan
} else {
  Log "`n[6/6] 注册/刷新常驻服务 $Service（需要管理员，会弹 UAC）..." Yellow
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if (-not $nssm) { foreach ($p in @("C:\Windows\System32\nssm.exe", "C:\D\opt\nssm\nssm.exe")) { if (Test-Path $p) { $nssm = $p; break } } }
  if (-not $nssm) { Log "  ❌ 找不到 nssm.exe。装 nssm 后重跑，或加 -SkipService 手工起服务" Red; exit 1 }

  $elev = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $elev) {
    # 非提升：把服务注册写成子脚本，弹 UAC 跑，transcript 落盘后再读（提升窗口本进程看不见）
    $runner = Join-Path $TmpDir "_elevated-service.ps1"
    $transcript = Join-Path $LogsDir "elevated-service.log"
    $svcPs = @"
Start-Transcript -Path "$transcript" -Force
`$ErrorActionPreference = 'Continue'
& "$nssm" status $Service *> `$null 2>&1
if (`$LASTEXITCODE -eq 0) {
  & "$nssm" set $Service Application "$VenvPy"
  & "$nssm" set $Service AppParameters "`"$InstallDir\server.py`""
} else {
  & "$nssm" install $Service "$VenvPy" "`"$InstallDir\server.py`""
}
& "$nssm" set $Service AppDirectory "$InstallDir"
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters" -Name AppEnvironmentExtra -PropertyType MultiString -Value @("PYTHONUTF8=1","HOJO_MODELS=$ModelsDir","FFMPEG=$FfmpegExe") -Force | Out-Null
& "$nssm" set $Service AppStdout "$LogsDir\service-out.log"
& "$nssm" set $Service AppStderr "$LogsDir\service-err.log"
& "$nssm" set $Service Start SERVICE_AUTO_START
& "$nssm" set $Service DisplayName "dsh local TTS (Hojo-TTS-Light-40M, $Port)"
& "$nssm" restart $Service
Start-Sleep -Seconds 3
& "$nssm" status $Service
Stop-Transcript
"@
    # 带 BOM 写：提升窗口是 Windows PowerShell 5.1，无 BOM 的 UTF-8 会被当 ANSI 读（中文注释乱码）
    [System.IO.File]::WriteAllText($runner, $svcPs, (New-Object System.Text.UTF8Encoding($true)))
    Log "  弹 UAC 中，请在弹窗点「是」..." Yellow
    Start-Process powershell -Verb RunAs -Wait -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$runner`"")
    if (Test-Path $transcript) { Log "  --- 提升窗口回执 ---" DarkGray; Get-Content $transcript -Tail 12 }
  } else {
    $exists = $false
    & $nssm status $Service *> $null 2>&1; if ($LASTEXITCODE -eq 0) { $exists = $true }
    if ($exists) {
      & $nssm set $Service Application $VenvPy
      & $nssm set $Service AppParameters "`"$InstallDir\server.py`""
    } else {
      & $nssm install $Service $VenvPy "`"$InstallDir\server.py`""
    }
    & $nssm set $Service AppDirectory $InstallDir
    New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters" -Name AppEnvironmentExtra -PropertyType MultiString -Value @("PYTHONUTF8=1","HOJO_MODELS=$ModelsDir","FFMPEG=$FfmpegExe") -Force | Out-Null
    & $nssm set $Service AppStdout "$LogsDir\service-out.log"
    & $nssm set $Service AppStderr "$LogsDir\service-err.log"
    & $nssm set $Service Start SERVICE_AUTO_START
    & $nssm restart $Service
  }

  Log "  等服务起来（模型加载约 3~10 秒）..." Yellow
  $svcOk = $false
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    try { $h2 = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3; if ($h2.status -eq "ok") { $svcOk = $true; break } } catch { }
  }
  if (-not $svcOk) { Log "  ❌ 服务没起来或模型没加载完。看：$LogsDir\service-out.log / service-err.log" Red; exit 1 }
  try {
    $b2 = [Text.Encoding]::UTF8.GetBytes('{"text":"常驻服务自检，本地语音已经就绪。"}')
    $r2 = Invoke-WebRequest "http://127.0.0.1:$Port/tts" -Method POST -ContentType "application/json" -Body $b2 -TimeoutSec 180 -UseBasicParsing
    Log "  ✅ 服务自检通过：HTTP $($r2.StatusCode)，$($r2.RawContentLength) 字节 mp3" Green
  } catch { Log "  ❌ 服务在跑但合成失败：$($_.Exception.Message)" Red; exit 1 }
}

# ---------- 6b. 写插件配置：把「本地 TTS」地址指到本服务 ----------
# 插件的 loadVoiceConfig() 按文件 mtime 实时重读（index.js:261）⇒ 外部改这份 JSON **立即生效、无需重启**。
# 只动 engines.local；cmd 仅在它指向已废弃的 local-tts.mjs 时才清空，用户自己写的别的本地命令不动。
$vc = Join-Path $env:USERPROFILE ".dsh\voice-config.json"
if (Test-Path $vc) {
  try {
    Copy-Item $vc "$vc.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
    $cfgOut = & $VenvPy (Join-Path $InstallDir "set-voice-config.py") $vc "http://127.0.0.1:$Port/tts" 2>&1
    Log "  已写 voice-config.json: $cfgOut" Green
    $j = Get-Content $vc -Raw | ConvertFrom-Json
    Log ("  回读 local.url={0}   local.cmd='{1}'" -f $j.engines.local.url, $j.engines.local.cmd) Green
  } catch {
    Log "  ⚠️ voice-config 自动写入失败（不影响服务本身）：$($_.Exception.Message)" Yellow
    Log "     请手动到 设置 → 语音服务 → 本地 TTS → 地址填 http://127.0.0.1:$Port/tts" Yellow
  }
} else {
  Log "  未找到 voice-config.json（插件还没跑过设置页）→ 装完手动把地址填成 http://127.0.0.1:$Port/tts" Yellow
}

# ---------- 收尾 ----------
$oldMelo = @("$env:USERPROFILE\.dsh\sherpa-onnx\models\melo", "C:\D\opt\sherpa-onnx\models\melo", "D:\opt\deepseek-harness\asr\models\melo")
$found = @()
foreach ($m in $oldMelo) { if (Test-Path $m) { $found += $m } }

Log "`n==== 安装完成 ====" Cyan
Log "权重+venv： $InstallDir"
Log "服务日志  ： $LogsDir\service-out.log"
Log ""
Log "本机插件配置已自动指向： http://127.0.0.1:$Port/tts" Green
Log "  （设置 → 语音服务 → 本地 TTS 可核对；「本地命令」保持留空）" DarkGray
if ($found.Count -gt 0) {
  Log ""
  Log "⚠️ 检测到旧 MeloTTS 残留（不再被本插件使用，确认没别的程序在用后可删）：" Yellow
  foreach ($m in $found) { Log "   $m" Yellow }
  Log "   删除命令（别删整个 sherpa-onnx，ASR 的 sensevoice-int8 模型还在用）：" DarkGray
  Log "   Remove-Item -Recurse -Force `"$($found[0])`"" DarkGray
}
