param(
    [string] $Server = '192.168.1.166',
    [string] $User = 'zhzaill',
    [string] $Password = $env:STAGE2_PASSWORD,
    [string] $HostKey = 'SHA256:mi6ruODDjDlZBosOGrVIAJ4UFTIGPYRP11eH4cNLh+M'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Password)) { throw 'Pass -Password or set STAGE2_PASSWORD; no credential is stored in this script.' }

function Invoke-Remote {
    param([string] $Script)
    $bytes = [Text.Encoding]::Unicode.GetBytes($Script)
    $encoded = [Convert]::ToBase64String($bytes)
    $output = & plink -batch -hostkey $HostKey -pw $Password "$User@$Server" "powershell -NoProfile -EncodedCommand $encoded" 2>&1
    return $output
}

Write-Host '=== 1. Host identity ==='
Invoke-Remote 'hostname; (Get-CimInstance Win32_OperatingSystem).Caption' | Out-String -Width 120

Write-Host '=== 2. Existing stage/production dirs ==='
Invoke-Remote @'
foreach ($p in @('E:\Absolute-Solver','E:\Absolute-Solver\stage2')) {
  if (Test-Path $p) {
    Write-Output "--- $p"
    Get-ChildItem $p -File | Select-Object -First 25 | ForEach-Object { "{0,-46} {1,10}" -f $_.Name, $_.Length }
  } else { Write-Output "--- $p MISSING" }
}
'@ | Out-String -Width 120

Write-Host '=== 3. Running solver processes ==='
Invoke-Remote @'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'absolute-solver|Coopanion|python' } |
  Select-Object ProcessId, Name, @{n='Cmd';e={$_.CommandLine.Substring(0,[Math]::Min(110,$_.CommandLine.Length))}} |
  Format-Table -AutoSize | Out-String -Width 160
'@ | Out-String -Width 170

Write-Host '=== 4. Listening ports of interest ==='
Invoke-Remote @'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 22,18100,18080,18081,18082,18083,18084,18111,7797,9880,9881 } |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Sort-Object LocalPort | Format-Table -AutoSize | Out-String
'@ | Out-String -Width 120
