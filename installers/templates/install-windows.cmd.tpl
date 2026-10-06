@echo off
chcp 65001 >nul
title YouTube 批量下載器 安裝程式
echo YouTube 批量下載器 安裝程式 @@VERSION@@
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = [IO.File]::ReadAllText('%~f0', [Text.Encoding]::UTF8); $i = $f.LastIndexOf('#PS-START'); Invoke-Expression $f.Substring($i + 9)"
echo.
pause
exit /b
#PS-START
# This only gets things started: it makes sure there is a Python and unpacks what is embedded below. The installing itself
# (tools, Chrome registration, the extension's folder, the checks) is host\installer.py, which is unpacked with it.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Join-Path $env:LOCALAPPDATA 'YTDownloader'
$HostDir = Join-Path $Root 'host'
$PyDir = Join-Path $Root 'python'
$Tmp = Join-Path $env:TEMP 'ytdl-setup'

function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
# A part is judged by whether it runs, not by whether the file exists: running this installer again repairs what is broken.
function Works($exe, $arg) {
    if (-not (Test-Path $exe)) { return $false }
    try { & $exe $arg *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

try {
    New-Item -ItemType Directory -Force -Path $Root, $HostDir, $PyDir, $Tmp | Out-Null

    Step '寫入本機小程式'
    $payload = Join-Path $Tmp 'host.zip'
    [IO.File]::WriteAllBytes($payload, [Convert]::FromBase64String('@@PAYLOAD_B64@@'))
    Expand-Archive -Force -Path $payload -DestinationPath $HostDir
    [IO.File]::WriteAllBytes((Join-Path $Root 'extension.zip'), [Convert]::FromBase64String('@@EXTENSION_B64@@'))

    $py = Join-Path $PyDir 'python.exe'
    if (-not (Works $py '--version')) {
        Step '下載 Python（內嵌版）'
        $zip = Join-Path $Tmp 'python.zip'
        Invoke-WebRequest -Uri '@@URL_PYTHON_WIN@@' -OutFile $zip -UseBasicParsing
        Expand-Archive -Force -Path $zip -DestinationPath $PyDir
    }
    # The embeddable Python ignores the script folder, so list the host folder in its ._pth file.
    $pth = Get-ChildItem -Path $PyDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
        $lines = @(Get-Content -Path $pth.FullName)
        if ($lines -notcontains '..\host') { Set-Content -Path $pth.FullName -Value ($lines + '..\host') -Encoding ASCII }
    }

    $env:PYTHONIOENCODING = 'utf-8'
    & $py (Join-Path $HostDir 'installer.py') --home $Root --ext-id '@@EXT_ID@@' --extension-zip (Join-Path $Root 'extension.zip') --version '@@VERSION@@'
} catch {
    Write-Host ''
    Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '請截圖這個視窗，並聯絡提供工具的同事。'
}
