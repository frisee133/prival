$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Set-Location -LiteralPath $projectDir
$pgCtl = Join-Path $PSScriptRoot 'bin/postgres/bin/pg_ctl.exe'
$pgDir = Join-Path $PSScriptRoot 'db'
function Test-LocalPort([int]$Port, [string]$Address='127.0.0.1') {
    $socket = [Net.Sockets.TcpClient]::new()
    try {
        $connecting = $socket.BeginConnect($Address, $Port, $null, $null)
        if (!$connecting.AsyncWaitHandle.WaitOne(750)) { return $false }
        $socket.EndConnect($connecting)
        return $true
    }
    catch { return $false }
    finally { $socket.Dispose() }
}
if (!(Test-LocalPort 15432)) {
    & $pgCtl start -D $pgDir -l (Join-Path $PSScriptRoot 'pg.log') -o '-p 15432 -h 127.0.0.1' -w
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL не запустился' }
}
function Start-LocalService([int]$Port, [string]$Exe, [string]$Arguments, [string]$LogName, [string]$Address='127.0.0.1') {
    if (Test-LocalPort $Port $Address) { return }
    $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot "$LogName-out.log") -RedirectStandardError (Join-Path $PSScriptRoot "$LogName-err.log")
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-LocalPort $Port $Address) { return }
        $process.Refresh()
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    throw "Сервис $LogName не открыл порт $Port. Проверьте .local/$LogName-err.log"
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($node) { $node.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
$env:APP_UPSTREAM='127.0.0.1:18080'
$env:SFU_UPSTREAM='127.0.0.1:17881'
Start-LocalService 17881 (Join-Path $PSScriptRoot 'bin/livekit-server.exe') '--config .local/preview-lk.yaml' 'preview-lk'
Start-LocalService 18080 $nodePath '--env-file=.local/preview.env dist/server/index.js' 'preview-api'
Start-LocalService 17880 (Join-Path $PSScriptRoot 'bin/caddy.exe') 'run --config .local/Caddyfile --adapter caddyfile' 'preview-gateway'
$result = Invoke-RestMethod 'http://127.0.0.1:18080/api/health' -TimeoutSec 8
if (!$result.ok) { throw 'Ошибка проверки API' }
Write-Output 'Привал доступен по адресу http://127.0.0.1:18080'

$vpnAddress = (Get-NetIPAddress -InterfaceAlias 'Radmin VPN' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
if ($vpnAddress -eq '26.69.72.39') {
    $env:PRIVATE_IP=$vpnAddress
    $env:PRIVATE_PORT='18443'
    $env:XDG_DATA_HOME=Join-Path $PSScriptRoot 'private-ca'
    $savedAppData=$env:APPDATA
    try {
        $env:APPDATA=$env:XDG_DATA_HOME
        Start-LocalService 18443 (Join-Path $PSScriptRoot 'bin/caddy.exe') 'run --config deploy/Caddyfile.private --adapter caddyfile' 'private-gateway' $vpnAddress
    } finally { $env:APPDATA=$savedAppData }
    Write-Output "Ссылка для общей Radmin VPN: https://${vpnAddress}:18443"
    $leaf = Join-Path $PSScriptRoot "private-ca/caddy/certificates/local/$vpnAddress/$vpnAddress.crt"
    $ca = Join-Path $PSScriptRoot 'Привал-VPN-CA.crt'
    & $nodePath 'scripts/check-turn-certificate.mjs' $vpnAddress $leaf $ca *> (Join-Path $PSScriptRoot 'turn-certificate.log')
    $tlsStatus = $LASTEXITCODE
    if ($tlsStatus -eq 3) {
        $listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 17881
        $service = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if ($service.ExecutablePath -ne (Resolve-Path (Join-Path $PSScriptRoot 'bin/livekit-server.exe')).Path -or $service.CommandLine -notlike '*--config .local/preview-lk.yaml*') { throw 'Невозможно обновить сертификат: порт SFU занят другим процессом' }
        Write-Host 'Обновляю сертификат TURN в LiveKit...'
        $stopping = Get-Process -Id $service.ProcessId
        $null = $stopping.Handle
        Stop-Process -Id $service.ProcessId
        if (!$stopping.WaitForExit(5000)) { throw 'LiveKit не завершился за 5 секунд' }
        Start-LocalService 17881 (Join-Path $PSScriptRoot 'bin/livekit-server.exe') '--config .local/preview-lk.yaml' 'preview-lk'
        & $nodePath 'scripts/check-turn-certificate.mjs' $vpnAddress $leaf $ca *> (Join-Path $PSScriptRoot 'turn-certificate.log')
        $tlsStatus = $LASTEXITCODE
    }
    if ($tlsStatus -ne 0) { throw 'TURN/TLS недоступен. Проверьте .local/turn-certificate.log' }
}
