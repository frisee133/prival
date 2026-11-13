param([switch]$Renew)
$ErrorActionPreference = 'Stop'
$CommandTimeoutSeconds = 35
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$project = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $project
$cli = Join-Path $project '.local/bin/pinggy.exe'
$config = (Resolve-Path -LiteralPath '.local/preview.env').Path
$vpn = (Get-NetIPAddress -InterfaceAlias 'Radmin VPN' -AddressFamily IPv4).IPAddress
$privateOrigin = "https://${vpn}:18443"
$stateFile = Join-Path $project '.local/public-link.json'
if (!(Test-Path -LiteralPath $cli)) { throw 'Нужен Pinggy CLI в .local/bin/pinggy.exe' }
if (!(Test-Path -LiteralPath '.local/Привал-VPN-CA.crt')) { throw 'Нужен сертификат локального TURN/TLS' }

function Read-PinggyLog([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $reader = New-Object IO.StreamReader($stream, $utf8)
    try { return $reader.ReadToEnd() }
    finally { $reader.Dispose() }
}
function Invoke-Pinggy([string[]]$Arguments) {
    $stamp = [Guid]::NewGuid().ToString('N')
    $outPath = Join-Path $project ".local/pinggy-$stamp.out.log"
    $errPath = Join-Path $project ".local/pinggy-$stamp.err.log"
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $runtime = $nodeCommand.Source
    } else {
        $runtime = Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe'
        if (!(Test-Path -LiteralPath $runtime)) {
            $runtime = Join-Path $env:ProgramFiles 'nodejs/node.exe'
        }
        if (!(Test-Path -LiteralPath $runtime)) {
            $codex = Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
            if ($codex -and $codex.InstallLocation) {
                $runtime = Join-Path $codex.InstallLocation 'dependencies/node/bin/node.exe'
            } else {
                $runtime = $null
            }
        }
        if (!$runtime -or !(Test-Path -LiteralPath $runtime)) {
            throw 'Node.js не найден. Установите Node.js 24 или запустите скрипт из среды Codex.'
        }
    }
    $result = & $runtime (Join-Path $project 'scripts/pinggy-command.mjs') $cli ($CommandTimeoutSeconds * 1000) $outPath $errPath @Arguments | ConvertFrom-Json
    if ($result.timedOut) {
        throw "Pinggy не ответил за $CommandTimeoutSeconds с. Журналы: $outPath и $errPath"
    }
    $text = (Read-PinggyLog $outPath) + (Read-PinggyLog $errPath)
    $text = [regex]::Replace($text, '\x1b\[[0-?]*[ -/]*[@-~]', '')
    if ($result.error -or $result.code -ne 0) {
        throw "Pinggy завершился с кодом $($result.code). $($result.error) $text Журналы: $outPath и $errPath"
    }
    return $text
}
function Test-PublicSite([string]$Origin) {
    $lastFailure = ''
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            $health = Invoke-RestMethod "$Origin/api/health" -Headers @{'Accept'='application/json';'X-Pinggy-No-Screen'='1'} -TimeoutSec 10
            if (!$health.ok) { throw 'API вернул некорректный ответ' }
            $page = Invoke-WebRequest "$Origin/" -Headers @{'X-Pinggy-No-Screen'='1'} -UseBasicParsing -TimeoutSec 10
            if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'id="root"') { throw 'Страница приложения недоступна' }
            return
        } catch {
            $lastFailure = $_.Exception.Message
            if ($attempt -lt 2) { Start-Sleep -Seconds 1 }
        }
    }
    throw "Публичный сайт не прошёл проверку. $lastFailure"
}
function Get-Mapping([int]$Port, [string]$Scheme) {
    $rows = (Invoke-Pinggy -Arguments @('ps')) -split "\r?\n"
    foreach ($row in $rows) {
        if ($row -match "^\s*(?<id>[a-f0-9-]+)\s+.*?\brunning\s+127\.0\.0\.1:$Port\s+(?<url>${Scheme}://[^\s]+)") {
            return [pscustomobject]@{ id = $Matches.id; url = $Matches.url }
        }
    }
    return $null
}
function Start-Mapping([int]$Port, [string]$Type, [string]$Scheme) {
    $mapping = Get-Mapping $Port $Scheme
    if ($mapping) { return $mapping }
    Write-Host "Открываю туннель $Type..."
    $message = Invoke-Pinggy -Arguments @('--type', $Type, '--no-autoreconnect', '-l', "127.0.0.1:$Port", '--b')
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $mapping = Get-Mapping $Port $Scheme
        if ($mapping) { break }
        if ($attempt -lt 2) { Start-Sleep -Seconds 1 }
    }
    if (!$mapping) { throw "Поставщик не выдал адрес $Type. $message" }
    return $mapping
}
function Get-Listener([int]$Port) {
    return Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
}

& (Join-Path $project '.local/Запустить.ps1') | Out-Host
$turn = Start-Mapping 19444 'tcp' 'tcp'
$web = Start-Mapping 18880 'http' 'https'
$origin = ([uri]$web.url).GetLeftPart([UriPartial]::Authority)
$remote = [uri]$turn.url
$old = if (Test-Path -LiteralPath $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json }
if (!$Renew -and $old -and $old.origin -eq $origin -and $old.turn -eq $turn.url -and (Get-Listener 19444) -and (Get-Listener 18880)) {
    Test-PublicSite $origin
    Write-Output $origin
    return
}
$env:TUNNEL_HOST = ([uri]$origin).Host
$env:PRIVATE_IP = $vpn
$env:TURN_CA_FILE = (Resolve-Path -LiteralPath '.local/Привал-VPN-CA.crt').Path
$node = (Get-Command node.exe).Source
if (!(Get-Listener 19444)) {
    Start-Process $node -ArgumentList 'scripts/turn-tls-bridge.mjs' -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardError '.local/public-turn-bridge.err' -RedirectStandardOutput '.local/public-turn-bridge.out'
}
$gateway = Get-Listener 18880
if ($gateway) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($gateway.OwningProcess)"
    if ($process.ExecutablePath -ne (Resolve-Path '.local/bin/caddy.exe').Path -or $process.CommandLine -notlike '*--config deploy/Caddyfile.tunnel*') { throw 'Порт 18880 занят другим процессом' }
    Stop-Process -Id $process.ProcessId
}
Start-Process '.local/bin/caddy.exe' -ArgumentList 'run --config deploy/Caddyfile.tunnel --adapter caddyfile' -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardError '.local/tunnel-gateway.err' -RedirectStandardOutput '.local/tunnel-gateway.out'
$lines = [IO.File]::ReadAllLines($config)
$settings = @{}
foreach ($line in $lines) { if ($line -match '^([A-Z_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] } }
$aliases = @(($settings['APP_EXTRA_ORIGINS'] -split ',') | Where-Object { $_ -and $_ -ne $settings['TUNNEL_ORIGIN'] })
$aliases = @(($aliases + @($privateOrigin,$origin)) | Select-Object -Unique)
$replacement = @("APP_EXTRA_ORIGINS=$($aliases -join ',')", "FRIEND_LINK_ORIGIN=$origin", "TUNNEL_ORIGIN=$origin", "TUNNEL_TURN_URL=turn:$($remote.Host):$($remote.Port)?transport=tcp")
$keep = @($lines | Where-Object { $_ -notmatch '^(APP_EXTRA_ORIGINS|FRIEND_LINK_ORIGIN|TUNNEL_ORIGIN|TUNNEL_TURN_URL)=' })
$api = Get-Listener 18080
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($api.OwningProcess)"
if ($process.CommandLine -notlike '*--env-file=.local/preview.env dist/server/index.js*') { throw 'На порту 18080 работает другой сервер' }
[IO.File]::WriteAllLines($config + '.new', [string[]]($keep + $replacement))
[IO.File]::Replace($config + '.new', $config, $config + '.previous')
$stopping = Get-Process -Id $process.ProcessId
$null = $stopping.Handle
Stop-Process -Id $process.ProcessId
if (!$stopping.WaitForExit(5000)) { throw 'API не завершился за 5 секунд' }
& (Join-Path $project '.local/Запустить.ps1') | Out-Host
Test-PublicSite $origin
@{origin=$origin;turn=$turn.url;webId=$web.id;turnId=$turn.id} | ConvertTo-Json | Set-Content $stateFile -Encoding UTF8
Write-Output $origin
