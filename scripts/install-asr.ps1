# ============================================================
# dsh-host-voice ASR 一键安装脚本（Windows）
# 安装内容：
#   1. sherpa-onnx（含 sherpa-onnx-offline.exe 非流式识别）
#   2. SenseVoice 中英日韩粤模型（int8）
#   3. ffmpeg（无则用 winget 安装）
#   4. 注册 nssm 服务 asr（端口 18790，开机自启）
#
# 安装位置（2026-08-22 改）：默认装到**独立目录**，不装插件包目录——
#   插件包（npm 安装的 profile 副本）会随升级/重装被覆盖，
#   模型放里面会丢。默认顺序：
#     1) -InstallDir 参数显式指定（最高优先）
#     2) 检测已有 sherpa-onnx（之前装过则复用）：~\.dsh\sherpa-onnx / C:\D\opt\sherpa-onnx / D:\opt\deepseek-harness\asr
#     3) 以上都没有 → ~\.dsh\sherpa-onnx（dsh 数据目录，跨升级保留）
# 用法：以管理员身份打开 PowerShell，执行：
#   powershell -ExecutionPolicy Bypass -File "<脚本路径>\install-asr.ps1"
# 可选参数：-Port 18790（自定义端口）；-InstallDir "D:\opt\my-sherpa"（自定义安装目录）
# ============================================================
param(
  [int]$Port = 18790,
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
$Version = "v1.13.6"

# ---- 0. 确定安装目录（独立目录，不装插件包内）----
if ($InstallDir -eq "") {
  foreach ($c in @("$env:USERPROFILE\.dsh\sherpa-onnx", "C:\D\opt\sherpa-onnx", "D:\opt\deepseek-harness\asr")) {
    if (Test-Path (Join-Path $c "bin")) { $InstallDir = $c; break }
  }
  if ($InstallDir -eq "") { $InstallDir = Join-Path $env:USERPROFILE ".dsh\sherpa-onnx" }
}

Write-Host "==== dsh ASR 一键安装 ====" -ForegroundColor Cyan
Write-Host "安装目录:   $InstallDir"
Write-Host "  （独立目录，不随插件升级/重装被覆盖）" -ForegroundColor DarkGray
Write-Host "服务端口:   $Port"

# ---- 0b. 幂等保护：已完整安装则直接退出（不下载、不注册、不碰任何现有配置）----
$exeExists = Test-Path "$InstallDir\bin\sherpa-onnx-offline.exe"
$modelExists = Test-Path "$InstallDir\models\sensevoice-int8\model.int8.onnx"
$serviceHealthy = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
  $serviceHealthy = ($r.StatusCode -eq 200)
} catch { }

if ($exeExists -and $modelExists -and $serviceHealthy) {
  Write-Host "`n检测到本机已完整安装 sherpa-onnx + SenseVoice 模型，且端口 $Port 服务健康。" -ForegroundColor Green
  Write-Host "无需重复安装，脚本已跳过所有操作（不会改动现有文件和服务）。" -ForegroundColor Green
  exit 0
}
if ($exeExists -and $modelExists) {
  Write-Host "`n检测到 sherpa-onnx 与模型已存在，但端口 $Port 服务未运行。" -ForegroundColor Yellow
  Write-Host "将尝试为你注册并启动 nssm 服务（asr）。" -ForegroundColor Yellow
}
if ($serviceHealthy) {
  Write-Host "`n检测到端口 $Port 服务健康，但文件不完整——将补齐缺失文件。" -ForegroundColor Yellow
}

# ---- 1. 创建目录 ----
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\models" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\bin" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\tmp" | Out-Null

# ---- 1b. 下载/解压工具函数（2026-08-21 增强：断点续传 + 完整性校验 + 损坏自动重试）----
# 之前 XDN 实测：GitHub 大文件下载中断 → 只下了 42.7MB/230MB → tar 报 Truncated → 脚本抛错退出，
# 用户只看到"跑到最后报错"毫无提示。现在 curl -C - 断点续传 + 解压后校验，损坏文件自动删除重下。
# ⚠️ PowerShell 坑：$ErrorActionPreference=Stop 时 curl/tar 写 stderr（进度/警告）会抛 NativeCommandError
# 中断脚本（0.3.5 实测踩中）。因此所有原生命令用 cmd /c 包装 + 2>nul 吞 stderr + 临时放宽 EAP，
# 只依据 $LASTEXITCODE 判断成败。
# [BUG-3 修复 2026-08-23]：①curl 加 -f（HTTP 错误即非零退出），去掉 -s 的双重静默保留可诊断输出进变量；
#   ②弱网 exit 56 时不再误判（$LASTEXITCODE 为准，-s 时 curl 也可能 0）；③解压前先 tar -tjf 探完整性，
#   探目录成功才算完整，失败删除重下；④重试 3→5 次。
function Download-Resume {
  param([string]$Url, [string]$OutFile)
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    Write-Host "  下载（第 $attempt 次尝试）: $Url" -ForegroundColor Yellow
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    # 不用 -s：错误信息保留（但要吞 stderr 防止 NativeCommandError，用 2>&1 捕获到变量）
    $errOut = cmd /c "curl.exe -fL -C - --retry 3 --retry-delay 2 --connect-timeout 20 -o `"$OutFile`" `"$Url`" 2>&1"
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($code -eq 0) { return $true }
    if ($code -eq 33) {
      # curl 33 = 服务器不支持续传，可能文件已完整（200 全量下载过）——校验一下
      if (Test-Path $OutFile) {
        $prevEAP2 = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        cmd /c "tar -tjf `"$OutFile`" 2>nul" | Out-Null
        $probe = $LASTEXITCODE; $ErrorActionPreference = $prevEAP2
        if ($probe -eq 0) { return $true }
      }
    }
    Write-Host "  下载中断（exit=$code，$($errOut | Select-Object -Last 1)），5 秒后重试..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
  }
  return $false
}
function Expand-TarBz2 {
  param([string]$Archive, [string]$Dest, [int]$Strip = 0)
  # [BUG-3 修复] 解压前先探完整性：tar -tjf 能列出目录才算完整，避免"下载中断但被当成功 → 解压必败"
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  cmd /c "tar -tjf `"$Archive`" 2>nul" | Out-Null
  $probe = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($probe -ne 0) {
    Write-Host "  压缩包不完整（tar 探目录失败）：$Archive" -ForegroundColor Red
    Remove-Item -Force $Archive -ErrorAction SilentlyContinue
    return $false
  }
  $tmpDir = Join-Path $Dest ".extract-tmp"
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $stripArgs = ""
  if ($Strip -gt 0) { $stripArgs = "--strip-components=$Strip" }
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  cmd /c "tar -xjf `"$Archive`" -C `"$tmpDir`" $stripArgs 2>nul"
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($code -ne 0) {
    Write-Host "  解压失败：压缩包损坏或不完整（$Archive）" -ForegroundColor Red
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    Remove-Item -Force $Archive -ErrorAction SilentlyContinue
    return $false
  }
  Get-ChildItem $tmpDir | Move-Item -Destination $Dest -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  return $true
}

# ---- 2. 检查 ffmpeg（ASR 转码必需）----
Write-Host "`n[1/4] 检查 ffmpeg..." -ForegroundColor Yellow
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  Write-Host "  未找到 ffmpeg，尝试 winget 安装（首次安装需同意条款）..." -ForegroundColor Yellow
  try {
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
  } catch {
    Write-Host "  winget 安装失败，请手动安装 ffmpeg 并加入 PATH" -ForegroundColor Red
    exit 1
  }
}
Write-Host "  ffmpeg: $($ffmpeg.Source)" -ForegroundColor Green

# ---- 3. 下载 sherpa-onnx ----
Write-Host "`n[2/4] 下载 sherpa-onnx $Version ..." -ForegroundColor Yellow
$pkgUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/$Version/sherpa-onnx-$Version-win-x64-shared-MD-Release.tar.bz2"
$pkgFile = "$InstallDir\tmp\sherpa-onnx.tar.bz2"
if (-not (Test-Path "$InstallDir\bin\sherpa-onnx-offline.exe")) {
  if (-not (Download-Resume $pkgUrl $pkgFile)) {
    Write-Host "  sherpa-onnx 下载失败（网络不稳定）。请检查网络后重跑本脚本" -ForegroundColor Red
    exit 1
  }
  Write-Host "  解压..."
  if (-not (Expand-TarBz2 $pkgFile "$InstallDir\tmp")) {
    Write-Host "  sherpa-onnx 压缩包损坏已删除，请重跑本脚本自动重新下载" -ForegroundColor Red
    exit 1
  }
  # 解压后目录结构：sherpa-onnx-v1.13.6-win-x64-shared-MD-Release/ 内含 bin/ lib/
  $extracted = Get-ChildItem "$InstallDir\tmp" -Directory | Where-Object { $_.Name -like "sherpa-onnx-*win*" } | Select-Object -First 1
  if ($extracted) {
    Copy-Item "$($extracted.FullName)\bin\*" "$InstallDir\bin\" -Force
    Copy-Item "$($extracted.FullName)\lib\*" "$InstallDir\lib\" -Force -ErrorAction SilentlyContinue
    Write-Host "  sherpa-onnx 解压完成" -ForegroundColor Green
  } else {
    Write-Host "  解压目录未找到，检查 tmp 目录" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "  sherpa-onnx 已存在，跳过下载" -ForegroundColor Green
}

# ---- 4. 下载 SenseVoice 模型（断点续传 + 完整性校验）----
Write-Host "`n[3/4] 下载 SenseVoice int8 模型..." -ForegroundColor Yellow
$modelDir = "$InstallDir\models\sensevoice-int8"
$modelUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2"
$modelFile = "$InstallDir\tmp\sensevoice.tar.bz2"
if (-not (Test-Path "$modelDir\model.int8.onnx")) {
  if (-not (Download-Resume $modelUrl $modelFile)) {
    Write-Host "  SenseVoice 模型下载失败（网络不稳定）。请检查网络后重跑本脚本" -ForegroundColor Red
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
  Write-Host "  解压模型..."
  if (-not (Expand-TarBz2 $modelFile $modelDir 1)) {
    Write-Host "  模型压缩包损坏已删除，请重跑本脚本自动重新下载" -ForegroundColor Red
    exit 1
  }
  if (-not (Test-Path "$modelDir\model.int8.onnx")) {
    Write-Host "  解压后未找到 model.int8.onnx（压缩包异常），已清理。请重跑本脚本" -ForegroundColor Red
    Remove-Item -Recurse -Force $modelDir -ErrorAction SilentlyContinue
    Remove-Item -Force $modelFile -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host "  模型解压完成" -ForegroundColor Green
} else {
  Write-Host "  模型已存在，跳过下载" -ForegroundColor Green
}

# ---- 5. 写 ASR 服务脚本 ----
Write-Host "`n[4/4] 写入 ASR 服务并注册 nssm..." -ForegroundColor Yellow
# ⚠️ 中文用户名路径（C:\Users\阿丹）P0 修复：sherpa-onnx 用 ANSI/GBK 解析命令行参数，
# 绝对路径含中文会变乱码（status=4294967295）。铁律——**进程先 chdir 到安装目录，所有参数用相对路径**；
# 输入音频若在中文路径，先 copyFileSync 到 tmp/（ASCII 相对路径）再调用 sherpa。
$serviceScript = @"
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { existsSync, copyFileSync, unlinkSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const PORT = Number(process.env.ASR_SERVICE_PORT || $Port);
// [中文路径修复] 常量只存相对位置，进程 chdir 后使用；不把绝对路径传给 sherpa
const SHERPA_REL = 'bin/sherpa-onnx-offline.exe';
const MODEL_DIR_REL = 'models/sensevoice-int8';
const TMP_REL = 'tmp';
let ROOT = process.env.ASR_ROOT || process.cwd();
if (!existsSync(ROOT)) ROOT = process.cwd();
try { process.chdir(ROOT); } catch (e) { console.error('[ASR] chdir 失败: ' + e.message); }
const SHERPA = SHERPA_REL;
const MODEL_DIR = MODEL_DIR_REL;
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/transcribe') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let tmpAudio = null;
      try {
        const { audioPath } = JSON.parse(body);
        if (!audioPath || !existsSync(audioPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid audio path' }));
          return;
        }
        // [中文路径修复] 输入音频可能位于中文路径——拷贝到 ASCII 相对 tmp/ 再调用
        mkdirSync(join(ROOT, TMP_REL), { recursive: true });
        tmpAudio = TMP_REL + '/asr-in-' + process.pid + '-' + Date.now() + '.wav';
        copyFileSync(audioPath, join(ROOT, tmpAudio));
        const r = spawnSync(SHERPA, [
          '--tokens=' + MODEL_DIR + '/tokens.txt',
          '--sense-voice-model=' + MODEL_DIR + '/model.int8.onnx',
          '--num-threads=4', tmpAudio,
        ], { windowsHide: true, timeout: 30000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        const all = (r.stdout || '') + '\n' + (r.stderr || '');
        if (r.status !== 0) {
          // [诊断增强] stderr 前 200 字符带进响应，设置页可直接看到原因（之前全吞）
          const head = (r.stderr || '').slice(0, 200);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sherpa exit ' + r.status, detail: head }));
          return;
        }
        const m = all.match(/"text"\s*:\s*"([^"]*)"/);
        const text = (m && m[1]) ? m[1] : '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
      } finally {
        if (tmpAudio) { try { unlinkSync(join(ROOT, tmpAudio)); } catch (_) { /* 清理失败忽略 */ } }
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404); res.end();
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('[ASR] listening on 127.0.0.1:' + PORT));
"@
# 服务脚本用 .cjs：插件包 package.json 声明了 "type":"module"，.js 会被当 ESM 解析导致 require 报错
# （2026-08-21 XDN 实测：asr-service.js 抛 ReferenceError: require is not defined）
$serviceFile = "$InstallDir\asr-service.cjs"
# [中文路径修复] BOM 不要加（node 按 UTF-8 读 .cjs，BOM 会报错）；PowerShell 5.1 写 UTF8 时带 BOM，
# 用 UTF8 参数即可（PS5.1 的 UTF8 是带 BOM 的 UTF-8，node 对 .cjs BOM 容忍，但保险起见用无 BOM 写入）。
# PS 5.1 没有 -Encoding utf8NoBOM，用 .NET 写：
[System.IO.File]::WriteAllText($serviceFile, $serviceScript, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  ASR 服务脚本: $serviceFile" -ForegroundColor Green

# ---- 6. 注册 nssm 服务 ----
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
  Write-Host "  未找到 nssm，请先安装 nssm（winget install nssm 或从 nssm.cc 下载）" -ForegroundColor Red
  exit 1
}
$nodeExe = (Get-Command node).Source
# [BUG-6 修复] nssm stop/remove 在服务不存在时写 stderr，EAP=Stop 下抛 NativeCommandError 中断脚本，
# 首次安装必崩（实测卡在 [4/4]）。先检测存在再操作，并临时放宽 EAP 用 $LASTEXITCODE 判成败。
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
if (Get-Service asr -ErrorAction SilentlyContinue) {
  nssm stop asr 2>$null | Out-Null
  nssm remove asr confirm 2>$null | Out-Null
}
$ErrorActionPreference = $prevEAP
nssm install asr "$nodeExe" "$serviceFile" | Out-Null
nssm set asr AppDirectory "$InstallDir" | Out-Null
# [中文路径修复] ASR_ROOT 让服务进程知道安装根目录（nssm cwd 可能不是 InstallDir），chdir 用
nssm set asr AppEnvironmentExtra "ASR_SERVICE_PORT=$Port" "ASR_ROOT=$InstallDir" | Out-Null
nssm set asr Start SERVICE_AUTO_START | Out-Null
nssm set asr AppStdout "$InstallDir\asr-stdout.log" | Out-Null
nssm set asr AppStderr "$InstallDir\asr-stderr.log" | Out-Null
nssm start asr | Out-Null
Start-Sleep -Seconds 2

# ---- 7. 验证 ----
Write-Host "`n==== 安装完成，验证服务 ====" -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
  Write-Host "  ASR 服务健康: $($health.status)" -ForegroundColor Green
} catch {
  Write-Host "  服务未响应，请查看 $InstallDir\asr-stderr.log" -ForegroundColor Red
}
Write-Host "`n请到 dsh 设置 → 语音服务 → ASR，点「检测已安装」自动填入地址 http://127.0.0.1:$Port" -ForegroundColor Cyan
