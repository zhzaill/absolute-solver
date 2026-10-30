param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('hub', 'gateway', 'agent', 'broker')]
    [string] $Role
)

$ErrorActionPreference = 'Stop'
$stage = 'E:\Absolute-Solver\stage2'
$secrets = Import-Clixml (Join-Path $stage 'stage2-secrets.xml')

function ConvertFrom-Secure([Security.SecureString] $value) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$hubToken = ConvertFrom-Secure $secrets.Hub
$agentToken = ConvertFrom-Secure $secrets.Agent
$brokerToken = ConvertFrom-Secure $secrets.Broker
$ttsKey = ConvertFrom-Secure $secrets.Tts

switch ($Role) {
    'hub' {
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
        & (Join-Path $stage 'absolute-solver-hub.exe')
    }
    'gateway' {
        $env:TTS_CONFIG = Join-Path $stage 'tts-stage2-config.json'
        $env:GPTSOVITS_HOME = 'E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50'
        & 'E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50\runtime\python.exe' 'E:\GPT-SoVITS\gateway\gateway.py'
    }
    'agent' {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $env:SOLVER_HUB_HTTP = 'http://127.0.0.1:18201'
        $env:SOLVER_PRESENCE_TOKEN = $hubToken
        $env:SOLVER_AGENT_TOKEN = $agentToken
        $env:SOLVER_HOST_ID = 'solver-server-stage2'
        $env:SOLVER_SOURCE_INSTANCE = 'cortico'
        $env:SOLVER_TTS_UPSTREAM = 'http://127.0.0.1:18083'
        $env:SOLVER_TTS_API_KEY = $ttsKey
        $env:SOLVER_AGENT_PORT = '18082'
        & 'E:\Coo-0.2.10-20261025\Coopanion.exe' (Join-Path $stage 'access-agent.mjs')
    }
    'broker' {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $env:SOLVER_HUB_HTTP = 'http://127.0.0.1:18201'
        $env:SOLVER_PRESENCE_TOKEN = $hubToken
        $env:SOLVER_BROKER_TOKEN = $brokerToken
        $env:SOLVER_AGENT_TOKEN = $agentToken
        $env:SOLVER_BROKER_PORT = '18084'
        $env:SOLVER_AGENT_URL = 'http://127.0.0.1:18082'
        & 'E:\Coo-0.2.10-20261025\Coopanion.exe' (Join-Path $stage 'coo-access-broker.mjs')
    }
}
