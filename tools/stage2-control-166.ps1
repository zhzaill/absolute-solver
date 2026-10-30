param(
    [string] $Server = '192.168.1.166',
    [string] $User = 'zhzaill',
    [string] $Password = $env:STAGE2_PASSWORD,
    [string] $HostKey = 'SHA256:mi6ruODDjDlZBosOGrVIAJ4UFTIGPYRP11eH4cNLh+M',
    [ValidateSet('start','stop','status','host')]
    [string] $Action = 'status'
)

# Runs the isolated stage2 stack on the target host through a scheduled task, so
# the processes survive the SSH session that started them. The production Hub
# (v0.2.1 on 18100) is never referenced here.

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Password)) { throw 'Pass -Password or set STAGE2_PASSWORD; no credential is stored in this script.' }

function Invoke-Remote {
    param([string] $Script)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    return & plink -batch -hostkey $HostKey -pw $Password "$User@$Server" "powershell -NoProfile -EncodedCommand $encoded" 2>&1
}

$stage = 'E:\Absolute-Solver\stage2'
$taskName = 'AbsoluteSolverStage2Stack'

if ($Action -eq 'start') {
    Write-Host '=== Registering detached stage2 runner (scheduled task) ===' -ForegroundColor Cyan
    # OpenSSH terminates the whole process tree when the session closes, so the
    # stack is launched by a scheduled task rather than as a child of this shell.
    $runner = @'
$ErrorActionPreference = 'Stop'
$stage = 'E:\Absolute-Solver\stage2'
$secrets = Import-Clixml (Join-Path $stage 'stage2-secrets.xml')
function Plain([Security.SecureString] $v) { $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($v); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) } }

# Stop only previous stack members. The runner's own command line also contains
# "stage2", so it must exclude itself or it kills the shell it is running in.
$self = $PID
Get-CimInstance Win32_Process |
  Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*stage2*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

$env:SOLVER_HUB_LISTEN = '192.168.1.166:18201'
$env:SOLVER_TRACE = Join-Path $stage 'hub-stage2.jsonl'
$env:SOLVER_MEMORY_DB = ':memory:'
$env:SOLVER_PRESENCE_TOKEN = Plain $secrets.Hub
$env:SOLVER_PRESENCE_HOSTS = 'solver-host-166'
$env:SOLVER_TTS_URL = ''
$env:SOLVER_ASR_URL = ''
$env:SOLVER_LLM_URL = ''
$env:SOLVER_CORTICO_MONITOR_URL = ''
$env:SOLVER_ROBOTICS_WORLD_URL = ''
$env:ELECTRON_RUN_AS_NODE = '1'
# The Hub binds the LAN address (so the Coo machine can reach it), which means
# loopback is not served. Local components must therefore address it by that
# same LAN address, not 127.0.0.1.
$env:SOLVER_HUB_HTTP = 'http://192.168.1.166:18201'
$env:SOLVER_AGENT_TOKEN = Plain $secrets.Agent
$env:SOLVER_HOST_ID = 'solver-host-166'
$env:SOLVER_SOURCE_INSTANCE = 'cortico'
$env:SOLVER_TTS_UPSTREAM = 'http://127.0.0.1:18080'
# The agent is the most sensitive hop (it holds the upstream key), so it stays
# loopback-only. Only the broker, which requires its own bearer token, is
# reachable from the Coo machine.
$env:SOLVER_AGENT_PORT = '18082'
$env:SOLVER_AGENT_HOST = '127.0.0.1'
$env:SOLVER_BROKER_TOKEN = Plain $secrets.Broker
$env:SOLVER_BROKER_PORT = '18084'
$env:SOLVER_BROKER_HOST = '0.0.0.0'
$env:SOLVER_AGENT_URL = 'http://127.0.0.1:18082'

Start-Process -FilePath (Join-Path $stage 'absolute-solver-hub.exe') -WorkingDirectory $stage -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $stage 'hub.stdout.log') -RedirectStandardError (Join-Path $stage 'hub.stderr.log')
Start-Sleep -Seconds 2
Start-Process -FilePath 'E:\Coo-0.2.10-20261025\Coopanion.exe' -ArgumentList @((Join-Path $stage 'access-agent.mjs')) -WorkingDirectory $stage -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $stage 'agent.stdout.log') -RedirectStandardError (Join-Path $stage 'agent.stderr.log')
Start-Process -FilePath 'E:\Coo-0.2.10-20261025\Coopanion.exe' -ArgumentList @((Join-Path $stage 'coo-access-broker.mjs')) -WorkingDirectory $stage -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $stage 'broker.stdout.log') -RedirectStandardError (Join-Path $stage 'broker.stderr.log')

# The task scheduler reaps the whole tree when the task's own script exits, so
# this runner must stay resident for the children to survive.
while ($true) { Start-Sleep -Seconds 30 }
'@
    $runnerEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($runner))
    # Keep the remote command line short: upload the runner as a file instead of
    # inlining its base64 into the command.
    $runnerLocal = Join-Path $env:TEMP 'stage2-run-stack.ps1'
    [IO.File]::WriteAllText($runnerLocal, $runner, [Text.UTF8Encoding]::new($false))
    & pscp -batch -hostkey $HostKey -pw $Password $runnerLocal "${User}@${Server}:$stage/run-stack.ps1" 2>&1 | Out-Null

    $setup = @"
`$task = '$taskName'
schtasks.exe /create /tn `$task /tr "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $stage\run-stack.ps1" /sc once /st 23:59 /rl HIGHEST /f | Out-Null
schtasks.exe /run /tn `$task | Out-Null
Start-Sleep -Seconds 9
`$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { `$_.LocalPort -in 18201,18082,18084 } | Select-Object LocalPort,OwningProcess | Sort-Object LocalPort
'listening=' + ((`$ports | ForEach-Object { `$_.LocalPort }) -join ',')
try { `$r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18201/state' -TimeoutSec 4; 'state=' + `$r.StatusCode } catch { 'state=ERR' }
"@
    $out = Invoke-Remote $setup
    $out | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}

if ($Action -eq 'stop') {
    $out = Invoke-Remote @"
schtasks.exe /end /tn '$taskName' 2>`$null | Out-Null
Get-CimInstance Win32_Process | Where-Object { `$_.CommandLine -like '*stage2*' } |
  ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
'stopped'
"@
    $out | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}

if ($Action -eq 'status' -or $Action -eq 'host') {
    $script = @'
$stage = 'E:\Absolute-Solver\stage2'
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 18201,18082,18084 } | Select-Object LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort
"listening=" + (($ports | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ',')
try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18201/state' -TimeoutSec 3; "GET /state = $($r.StatusCode)" } catch { "GET /state = ERR" }
try { $r = Invoke-WebRequest -UseBasicParsing -Method POST -Uri 'http://127.0.0.1:18201/access/request' -ContentType 'application/json' -Body '{}' -TimeoutSec 3; "POST /access/request = $($r.StatusCode)" }
catch { "POST /access/request = " + $(if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { 'ERR' }) }
"host_exe=" + (Test-Path (Join-Path $stage 'absolute-solver-host.exe'))
"host_running=" + ((Get-Process -Name 'absolute-solver-host' -ErrorAction SilentlyContinue | Measure-Object).Count)
'@
    if ($Action -eq 'host') {
        $script += @'
$cfg = 'C:\Users\zhzaill\AppData\Roaming\net.absolutesolver.host\host.json'
New-Item -ItemType Directory -Force -Path (Split-Path $cfg) | Out-Null
$json = '{"hostId":"solver-host-166","hubWsUrl":"ws://192.168.1.166:18201/ws","projectionUrl":"http://192.168.1.178:18111","policy":"notify"}'
[IO.File]::WriteAllText($cfg, $json, [Text.UTF8Encoding]::new($false))
$env:SOLVER_HOST_CONFIG_PATH = $cfg
$p = Start-Process -FilePath (Join-Path $stage 'absolute-solver-host.exe') -WindowStyle Normal -PassThru
Start-Sleep -Seconds 4
"host_pid=$($p.Id) running=" + ((Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Measure-Object).Count)
'@
    }
    $out = Invoke-Remote $script
    $out | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}
