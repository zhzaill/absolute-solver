# 录音台启动器：起 ASR 隧道 -> 起录音台 -> 打开页面。
# 关掉这个窗口就关掉麦克风。
# 用法：.\record-console.ps1 [-Device 0] [-NoBrowser]

param(
    [int]$Device = -1,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { chcp 65001 > $null } catch { }

$root = $PSScriptRoot
$exe = Join-Path $root 'target\debug\absolute-solver-mic-monitor.exe'
$plink = 'C:\Program Files\PuTTY\plink.exe'
$hostKey = if ($env:SOLVER_SSH_HOSTKEY) { $env:SOLVER_SSH_HOSTKEY } else { '' }
$hubHost = if ($env:SOLVER_SSH_HOST) { $env:SOLVER_SSH_HOST } else { '127.0.0.1' }
$sshUser = if ($env:SOLVER_SSH_USER) { $env:SOLVER_SSH_USER } else { 'solver' }
$sshKey = $env:SOLVER_SSH_KEY
$page = 'http://127.0.0.1:18899/'
$tunnelPort = 19881
$asrPort = 9881

function Test-Port($port, $target = '127.0.0.1', $timeoutMs = 400) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($target, $port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($timeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

Write-Host ''
Write-Host '  绝对解答 · 录音台' -ForegroundColor Cyan
Write-Host '  ----------------------' -ForegroundColor DarkCyan
Write-Host '  关掉这个窗口 = 关掉麦克风' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path $exe)) {
    Write-Host "找不到 $exe" -ForegroundColor Red
    Write-Host '先编译：cargo build --bin absolute-solver-mic-monitor' -ForegroundColor Yellow
    exit 1
}

if (-not $sshKey -or -not $hostKey) {
    Write-Host '未设置 SOLVER_SSH_KEY/SOLVER_SSH_HOSTKEY；跳过远程 ASR 隧道。' -ForegroundColor Yellow
}

$env:SOLVER_ASR_URL = "http://127.0.0.1:$tunnelPort"
$env:SOLVER_RECORD_DIR = 'D:\11\Logs\asr'
if ($Device -ge 0) { $env:SOLVER_CAPTURE_DEVICE = "$Device" }

# 已在运行就直接开页面
if (Test-Port 18899) {
    Write-Host '录音台已经在运行。' -ForegroundColor Yellow
    if (-not $NoBrowser) { Start-Process $page }
    Start-Sleep -Seconds 2
    exit 0
}

$tunnel = $null
if (-not (Test-Port $tunnelPort)) {
    $serverUp = Test-Port 22 $hubHost 900
    if ($serverUp -and (Test-Path $plink) -and $sshKey -and $hostKey) {
        Write-Host "建立 ASR 隧道 127.0.0.1:$tunnelPort -> ${hubHost}:$asrPort ..." -ForegroundColor DarkGray
        $tunnel = Start-Process -FilePath $plink -ArgumentList @(
            '-ssh', '-batch', '-hostkey', $hostKey, '-i', $sshKey,
            '-L', "${tunnelPort}:127.0.0.1:${asrPort}", '-N', "${sshUser}@$hubHost"
        ) -PassThru -WindowStyle Hidden
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 250
            if (Test-Port $tunnelPort) { break }
        }
        if (Test-Port $tunnelPort) {
            Write-Host 'ASR 隧道已建立。' -ForegroundColor DarkGray
        } else {
            Write-Host 'ASR 隧道没起来（服务器可能休眠）。波形和电平仍然可用，识别会失败。' -ForegroundColor Yellow
        }
    } else {
        Write-Host "服务器 $hubHost 不可达（休眠/关机）。波形和电平仍可用，识别会失败。" -ForegroundColor Yellow
    }
}

Write-Host "启动录音台 $exe" -ForegroundColor DarkGray
$monitor = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -NoNewWindow

if (-not $NoBrowser) {
    Start-Sleep -Milliseconds 1200
    Start-Process $page
}

try {
    Wait-Process -Id $monitor.Id
} finally {
    if ($tunnel -and -not $tunnel.HasExited) {
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
        Write-Host 'ASR 隧道已关闭。' -ForegroundColor DarkGray
    }
}
