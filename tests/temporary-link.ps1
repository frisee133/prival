$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$suiteDir = Join-Path $project ('.local/link-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $suiteDir | Out-Null
$cli = Join-Path $suiteDir 'native.exe'
$source = @'
using System;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Threading;
public static class NativeFixture {
    public static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        if(args[0]=="sleep") { Thread.Sleep(4000); return 0; }
        if(args[0]=="fail") { Console.Error.WriteLine("Ошибка соединения"); return 7; }
        if(args[0]=="child") {
            Process.Start(new ProcessStartInfo {
                FileName=Assembly.GetExecutingAssembly().Location, Arguments="sleep",
                UseShellExecute=false,CreateNoWindow=true
            });
        }
        if(args[0]=="ps") Console.WriteLine("\u001b[32m12345678-abcd - running 127.0.0.1:18880 https://fixture.example\u001b[0m".Replace("\u001b","\x1b"));
        else Console.WriteLine("Сервер запущен");
        return 0;
    }
}
'@
$fixtureSource = Join-Path $suiteDir 'native.cs'
[IO.File]::WriteAllText($fixtureSource, $source, $utf8)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:exe "/out:$cli" $fixtureSource
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать native fixture' }
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'scripts/temporary-link.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$CommandTimeoutSeconds = 3
# Warm up the newly compiled executable before timing process lifetime.
$null = Invoke-Pinggy @('warmup')
$watch = [Diagnostics.Stopwatch]::StartNew()
$text = Invoke-Pinggy @('child')
if ($text.Trim() -ne 'Сервер запущен') { throw 'Нарушена кодировка native stdout' }
if ($watch.Elapsed.TotalSeconds -gt 3) { throw 'Ожидание EOF дочернего процесса' }
$mapping = Get-Mapping 18880 https
if ($mapping.url -ne 'https://fixture.example') { throw 'Не распознан URL с ANSI-кодами' }
try { Invoke-Pinggy @('fail'); throw 'Пропущена ошибка CLI' }
catch { if ($_.Exception.Message -notmatch 'кодом 7.*Ошибка соединения') { throw } }
$CommandTimeoutSeconds = 1
$watch.Restart()
try { Invoke-Pinggy @('sleep'); throw 'Пропущен timeout' }
catch { if ($_.Exception.Message -notmatch 'не ответил за 1 с') { throw } }
if ($watch.Elapsed.TotalSeconds -gt 3) { throw 'Timeout не ограничил ожидание' }
Write-Output 'Проверены UTF-8, URL с ANSI, наследование stdout, код ошибки и timeout.'
