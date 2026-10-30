$ErrorActionPreference = 'Stop'

$stage = 'E:\Absolute-Solver\stage2'
$secretFile = Join-Path $stage 'stage2-secrets.xml'
$secrets = Import-Clixml $secretFile

function ConvertFrom-Secure([Security.SecureString] $value) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$hubToken = ConvertFrom-Secure $secrets.Hub
$agentToken = ConvertFrom-Secure $secrets.Agent
$brokerToken = ConvertFrom-Secure $secrets.Broker
$ttsKey = ConvertFrom-Secure $secrets.Tts

Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'Coopanion.exe' -and $_.CommandLine -like '*access-agent.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'Coopanion.exe' -and $_.CommandLine -like '*coo-access-broker.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process -Name 'absolute-solver-host' -ErrorAction SilentlyContinue | Stop-Process -Force

$env:SOLVER_HUB_LISTEN = '127.0.0.1:18201'
$env:SOLVER_TRACE = Join-Path $stage 'hub-stage2.jsonl'
$env:SOLVER_MEMORY_DB = ':memory:'
$env:SOLVER_PRESENCE_TOKEN = $hubToken
$env:SOLVER_PRESENCE_HOSTS = 'solver-server-stage2'
$env:SOLVER_TTS_URL = ''
$env:SOLVER_ASR_URL = ''
$env:SOLVER_LLM_URL = ''
$env:SOLVER_CORTICO_MONITOR_URL = ''
$env:SOLVER_ROBOTICS_WORLD_URL = ''
$hub = Start-Process -FilePath (Join-Path $stage 'absolute-solver-hub.exe') -WorkingDirectory $stage -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $stage 'hub-stage2.stdout.log') `
    -RedirectStandardError (Join-Path $stage 'hub-stage2.stderr.log')

Start-Sleep -Seconds 2
$env:TTS_CONFIG = Join-Path $stage 'tts-stage2-config.json'
$env:GPTSOVITS_HOME = 'E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50'
$gateway = Start-Process -FilePath 'E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50\runtime\python.exe' `
    -ArgumentList @('E:\GPT-SoVITS\gateway\gateway.py') -WorkingDirectory 'E:\GPT-SoVITS\gateway' `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stage 'gateway-stage2.stdout.log') `
    -RedirectStandardError (Join-Path $stage 'gateway-stage2.stderr.log')

$env:ELECTRON_RUN_AS_NODE = '1'
$env:SOLVER_HUB_HTTP = 'http://127.0.0.1:18201'
$env:SOLVER_PRESENCE_TOKEN = $hubToken
$env:SOLVER_AGENT_TOKEN = $agentToken
$env:SOLVER_HOST_ID = 'solver-server-stage2'
$env:SOLVER_SOURCE_INSTANCE = 'cortico'
$env:SOLVER_TTS_UPSTREAM = 'http://127.0.0.1:18083'
$env:SOLVER_TTS_API_KEY = $ttsKey
$env:SOLVER_AGENT_PORT = '18082'
$agent = Start-Process -FilePath 'E:\Coo-0.2.10-20261025\Coopanion.exe' `
    -ArgumentList @((Join-Path $stage 'access-agent.mjs')) -WorkingDirectory $stage -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $stage 'agent-stage2.stdout.log') `
    -RedirectStandardError (Join-Path $stage 'agent-stage2.stderr.log')

$env:SOLVER_BROKER_TOKEN = $brokerToken
$env:SOLVER_BROKER_PORT = '18084'
$env:SOLVER_AGENT_URL = 'http://127.0.0.1:18082'
$broker = Start-Process -FilePath 'E:\Coo-0.2.10-20261025\Coopanion.exe' `
    -ArgumentList @((Join-Path $stage 'coo-access-broker.mjs')) -WorkingDirectory $stage -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $stage 'broker-stage2.stdout.log') `
    -RedirectStandardError (Join-Path $stage 'broker-stage2.stderr.log')

$configDir = 'C:\Users\zhzaill\AppData\Roaming\net.absolutesolver.host'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$hostConfig = '{"hostId":"solver-server-stage2","hubWsUrl":"ws://127.0.0.1:18201/ws","policy":"notify"}'
[IO.File]::WriteAllText((Join-Path $configDir 'host.json'), $hostConfig, [Text.UTF8Encoding]::new($false))

$taskName = 'AbsoluteSolverStage2Host'
schtasks.exe /delete /tn $taskName /f 2>$null | Out-Null
schtasks.exe /create /tn $taskName /tr 'E:\Absolute-Solver\stage2\start-host.cmd' /sc once /st 23:59 /it /f 2>$null | Out-Null
schtasks.exe /run /tn $taskName 2>$null | Out-Null

Start-Sleep -Seconds 6
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 18083, 18201, 18082, 18084 } |
    Select-Object LocalAddress, LocalPort, OwningProcess
$hubStatus = try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18201/state' -TimeoutSec 3).StatusCode } catch { 0 }
$ttsStatus = try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18083/healthz' -TimeoutSec 3).StatusCode } catch { 0 }

[pscustomobject]@{
    hubPid = $hub.Id
    hubHttp = $hubStatus
    gatewayPid = $gateway.Id
    gatewayHttp = $ttsStatus
    agentPid = $agent.Id
    brokerPid = $broker.Id
    host = @(Get-Process -Name 'absolute-solver-host' -ErrorAction SilentlyContinue | Select-Object Id, SessionId)
    ports = @($ports)
} | ConvertTo-Json -Depth 5
