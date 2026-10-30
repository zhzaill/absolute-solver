param(
    [string] $Server = '192.168.1.166',
    [string] $User = 'zhzaill',
    [string] $Password = $env:STAGE2_PASSWORD,
    [string] $HostKey = 'SHA256:mi6ruODDjDlZBosOGrVIAJ4UFTIGPYRP11eH4cNLh+M',
    [string] $LocalRoot = 'D:\11\Projects\Absolute Solver',
    [switch] $DryRun,
    [switch] $Start
)

# Deploys an ISOLATED stage2 stack onto the LAN target host (192.168.1.166).
# It never touches the production v0.2.1 Hub on 192.168.1.166:18100.
# Everything it creates lives under E:\Absolute-Solver\stage2 and uses ports
# 18201 (hub) / 18082 (agent) / 18084 (broker), none of which are in production use.

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Password)) { throw 'Pass -Password or set STAGE2_PASSWORD; no credential is stored in this script.' }

function Invoke-Remote {
    param([string] $Script, [string] $Label = '')
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    $out = & plink -batch -hostkey $HostKey -pw $Password "$User@$Server" "powershell -NoProfile -EncodedCommand $encoded" 2>&1
    if ($Label) { Write-Host "--- $Label" -ForegroundColor DarkGray }
    return $out
}
function Send-File {
    param([string] $Local, [string] $Remote)
    $out = & pscp -batch -hostkey $HostKey -pw $Password $Local "${User}@${Server}:$Remote" 2>&1
    return $out
}

$hubExe = Join-Path $LocalRoot 'target\release\absolute-solver-hub.exe'
$hostExe = Join-Path $LocalRoot 'desktop\tauri-host\target\release\absolute-solver-host.exe'
$agentJs = Join-Path $LocalRoot 'tools\access-agent.mjs'
$brokerJs = Join-Path $LocalRoot 'tools\coo-access-broker.mjs'

foreach ($f in @($hubExe, $hostExe, $agentJs, $brokerJs)) {
    if (-not (Test-Path $f)) { throw "missing local artifact: $f" }
}

$stage = 'E:\Absolute-Solver\stage2'
$summary = [ordered]@{}

Write-Host '=== Preflight ===' -ForegroundColor Cyan
$pre = Invoke-Remote @'
$ports = @(18201, 18082, 18084)
$busy = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in $ports } | Select-Object LocalAddress,LocalPort,OwningProcess
"busy_ports=" + (($busy | ForEach-Object { "$($_.LocalPort)" }) -join ',')
"coopanion=" + (Test-Path 'E:\Coo-0.2.10-20261025\Coopanion.exe')
"stage_exists=" + (Test-Path 'E:\Absolute-Solver\stage2')
'@ 'ports / runtime'
$pre | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
$summary.preflight = ($pre -join ' ')

if ($DryRun) {
    Write-Host 'DRY RUN: no changes made.' -ForegroundColor Yellow
    $summary | ConvertTo-Json
    exit 0
}

Write-Host '=== Create isolated stage2 dir ===' -ForegroundColor Cyan
Invoke-Remote "New-Item -ItemType Directory -Force -Path '$stage' | Out-Null; 'ok'" | Out-Null

Write-Host '=== Upload binaries and adapters ===' -ForegroundColor Cyan
$uploads = @(
    @{ local = $hubExe;   remote = "$stage/absolute-solver-hub.exe" },
    @{ local = $hostExe;  remote = "$stage/absolute-solver-host.exe" },
    @{ local = $agentJs;  remote = "$stage/access-agent.mjs" },
    @{ local = $brokerJs; remote = "$stage/coo-access-broker.mjs" }
)
foreach ($u in $uploads) {
    Write-Host "  -> $(Split-Path $u.local -Leaf)" -ForegroundColor Gray
    Send-File -Local $u.local -Remote $u.remote | Out-Null
}

Write-Host '=== Verify hashes ===' -ForegroundColor Cyan
$localHashes = @{
    hub = (Get-FileHash $hubExe -Algorithm SHA256).Hash
    host = (Get-FileHash $hostExe -Algorithm SHA256).Hash
    agent = (Get-FileHash $agentJs -Algorithm SHA256).Hash
    broker = (Get-FileHash $brokerJs -Algorithm SHA256).Hash
}
$remoteHashesRaw = Invoke-Remote @"
@{
  hub = (Get-FileHash '$stage\absolute-solver-hub.exe' -Algorithm SHA256).Hash
  host = (Get-FileHash '$stage\absolute-solver-host.exe' -Algorithm SHA256).Hash
  agent = (Get-FileHash '$stage\access-agent.mjs' -Algorithm SHA256).Hash
  broker = (Get-FileHash '$stage\coo-access-broker.mjs' -Algorithm SHA256).Hash
} | ConvertTo-Json -Compress
"@
$remoteHashes = ($remoteHashesRaw -join '') | ConvertFrom-Json
$hashOk = $true
foreach ($k in @('hub','host','agent','broker')) {
    $same = $localHashes[$k] -eq $remoteHashes.$k
    if (-not $same) { $hashOk = $false }
    Write-Host ("  {0,-7} {1}" -f $k, ($(if ($same) { 'match' } else { 'MISMATCH' }))) -ForegroundColor $(if ($same) { 'Green' } else { 'Red' })
}
if (-not $hashOk) { throw 'upload hash mismatch' }
$summary.hashes = 'all match'

# Secrets are generated once on the target and stored DPAPI-encrypted for that
# machine+user only. They are never written to a .cmd, never sent back here.
Write-Host '=== Provision secrets (DPAPI, target-local) ===' -ForegroundColor Cyan
$secretOut = Invoke-Remote @'
$path = 'E:\Absolute-Solver\stage2\stage2-secrets.xml'
if (-not (Test-Path $path)) {
  function New-Token { [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })) }
  $secrets = [pscustomobject]@{
    Hub    = ConvertTo-SecureString (New-Token) -AsPlainText -Force
    Agent  = ConvertTo-SecureString (New-Token) -AsPlainText -Force
    Broker = ConvertTo-SecureString (New-Token) -AsPlainText -Force
  }
  $secrets | Export-Clixml $path
  'created'
} else { 'existing' }
'@ 'secrets'
$secretOut | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
$summary.secrets = ($secretOut -join ' ')

Write-Host '=== Write stage2 launcher ===' -ForegroundColor Cyan
$launcher = @'
@echo off
REM Isolated stage2 stack for the two-machine access acceptance.
REM Production Hub (v0.2.1 on 18100) is deliberately untouched.
setlocal
set STAGE=E:\Absolute-Solver\stage2
set SOLVER_HUB_LISTEN=127.0.0.1:18201
set SOLVER_TRACE=%STAGE%\hub-stage2.jsonl
set SOLVER_MEMORY_DB=:memory:
set SOLVER_PRESENCE_HOSTS=solver-host-166
set SOLVER_TTS_URL=
set SOLVER_ASR_URL=
set SOLVER_LLM_URL=
set SOLVER_CORTICO_MONITOR_URL=
set SOLVER_ROBOTICS_WORLD_URL=
powershell -NoProfile -ExecutionPolicy Bypass -File "%STAGE%\stage2-service-run.ps1" -Role hub
'@
$launcherEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($launcher))
Invoke-Remote "[IO.File]::WriteAllBytes('$stage\start-hub.cmd', [Convert]::FromBase64String('$launcherEncoded')); 'ok'" | Out-Null

# The service runner is too large for a command line, so upload it as a file.
Send-File -Local (Join-Path $LocalRoot 'tools\stage2-service-run.ps1') -Remote "$stage/stage2-service-run.ps1" | Out-Null
Send-File -Local (Join-Path $LocalRoot 'tools\stage2-isolated-start.ps1') -Remote "$stage/stage2-isolated-start.ps1" | Out-Null

Write-Host '=== Summary ===' -ForegroundColor Cyan
$summary | ConvertTo-Json

if ($Start) {
    Write-Host '=== Starting isolated Hub (18201) ===' -ForegroundColor Cyan
    Invoke-Remote @'
$stage = 'E:\Absolute-Solver\stage2'
$secrets = Import-Clixml (Join-Path $stage 'stage2-secrets.xml')
function Plain([Security.SecureString] $v) { $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($v); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) } }
$env:SOLVER_HUB_LISTEN = '127.0.0.1:18201'
$env:SOLVER_TRACE = Join-Path $stage 'hub-stage2.jsonl'
$env:SOLVER_MEMORY_DB = ':memory:'
$env:SOLVER_PRESENCE_TOKEN = Plain $secrets.Hub
$env:SOLVER_PRESENCE_HOSTS = 'solver-host-166'
$env:SOLVER_TTS_URL = ''
$env:SOLVER_ASR_URL = ''
$env:SOLVER_LLM_URL = ''
$env:SOLVER_CORTICO_MONITOR_URL = ''
$env:SOLVER_ROBOTICS_WORLD_URL = ''
$p = Start-Process -FilePath (Join-Path $stage 'absolute-solver-hub.exe') -WorkingDirectory $stage -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stage 'hub.stdout.log') -RedirectStandardError (Join-Path $stage 'hub.stderr.log')
Start-Sleep -Seconds 3
$probe = try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18201/state' -TimeoutSec 3).StatusCode } catch { 0 }
"hub_pid=$($p.Id) state_http=$probe"
'@ 'hub start' | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}
