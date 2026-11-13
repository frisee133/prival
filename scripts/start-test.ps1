param([switch]$Renew)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$project = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $project
$address = & (Join-Path $PSScriptRoot 'temporary-link.ps1') -Renew:$Renew | Select-Object -Last 1
if (!$address -or ([Uri]$address).Scheme -ne 'https') { throw 'Не удалось получить публичную HTTPS-ссылку' }
$client = Join-Path $project 'dist/windows/Привал'
if (Test-Path -LiteralPath (Join-Path $client 'Привал.exe')) {
    $json = @{server=([Uri]$address).GetLeftPart([UriPartial]::Authority)} | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $client 'server.json'), $json, $utf8)
    Write-Host 'Windows-клиент настроен на эту же ссылку. Если он уже открыт, полностью выйдите из него через значок в трее и запустите заново.'
}
Write-Host 'Сервер готов. Оба откройте адрес ниже в Chrome или Edge. Другу достаточно ссылки.'
Write-Host 'Сначала проверьте браузерный звонок; затем PTT и оверлей в Windows-клиенте.'
Write-Host 'Инструкция: КАК ПРОВЕРИТЬ С ДРУГОМ.md'
Write-Host 'Бесплатный туннель действует около часа. Компьютер должен оставаться включённым.'
Write-Output $address
