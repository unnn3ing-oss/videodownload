@echo off
chcp 65001 >nul
title YouTube 批量下載器 安裝程式
echo YouTube 批量下載器 安裝程式 @@VERSION@@
echo.
set "SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = [IO.File]::ReadAllText($env:SELF, [Text.Encoding]::UTF8); $i = $f.LastIndexOf('#PS-START'); Invoke-Expression $f.Substring($i + 9)"
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

# Never an older installer over a newer install: the automatic update may have put a newer host and extension here, and this
# file carries older ones. The version of the host files that are here (an x.y.z in version.py, next to its installer.py), or $null:
function InstalledVersion($dir) {
    $f = Join-Path $dir 'version.py'
    if (-not ((Test-Path $f) -and (Test-Path (Join-Path $dir 'installer.py')))) { return $null }
    try { $t = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) } catch { return $null }
    if ($t -match '(?m)^VERSION\s*=\s*"(\d+\.\d+\.\d+)"') { return $Matches[1] }
    return $null
}
# $true when version $a is higher than $b, by number (0.10.0 is newer than 0.9.0). Only x.y.z counts; anything else is not newer.
function IsNewer($a, $b) {
    if (($a -notmatch '^\d+\.\d+\.\d+$') -or ($b -notmatch '^\d+\.\d+\.\d+$')) { return $false }
    try { return (([version]$a) -gt ([version]$b)) } catch { return $false }
}

try {
    New-Item -ItemType Directory -Force -Path $Root, $HostDir, $PyDir, $Tmp | Out-Null

    $Embedded = '@@VERSION@@'
    $Installed = InstalledVersion $HostDir
    $Keep = IsNewer $Installed $Embedded
    if ($Keep) {
        Write-Host ''
        Write-Host "已安裝的版本（${Installed}）比這個安裝檔（${Embedded}）新，不會降版。要更新請在網頁按「更新到最新版」。" -ForegroundColor Yellow
    } else {
        Step '寫入下載助手'
        $payload = Join-Path $Tmp 'host.zip'
        [IO.File]::WriteAllBytes($payload, [Convert]::FromBase64String('@@PAYLOAD_B64@@'))
        # The files in the zip all carry the same fixed date, so an old __pycache__ would pass for current: drop it.
        Remove-Item -Recurse -Force -Path (Join-Path $HostDir '__pycache__') -ErrorAction SilentlyContinue
        Expand-Archive -Force -Path $payload -DestinationPath $HostDir
        [IO.File]::WriteAllBytes((Join-Path $Root 'extension.zip'), [Convert]::FromBase64String('@@EXTENSION_B64@@'))
    }

    $py = Join-Path $PyDir 'python.exe'
    if (-not (Works $py '--version')) {
        Step '下載 Python（內嵌版）'
        $zip = Join-Path $Tmp 'python.zip'
        Invoke-WebRequest -Uri '@@URL_PYTHON_WIN@@' -OutFile $zip -UseBasicParsing
        # Nothing is unpacked or run before it is the exact file this installer was made for.
        $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
        if ($actual -ne '@@SHA256_PYTHON_WIN@@') {
            Remove-Item -Force -Path $zip -ErrorAction SilentlyContinue
            throw "下載的 Python 校驗碼和預期不同，已丟棄、不會安裝。預期 @@SHA256_PYTHON_WIN@@，實際 $actual。可能是下載不完整或被中途改過；請確認網路（公司網路若會改寫下載內容，請洽 IT）後重新執行。"
        }
        Expand-Archive -Force -Path $zip -DestinationPath $PyDir
    }
    # The embeddable Python ignores the script folder, so list the host folder in its ._pth file.
    $pth = Get-ChildItem -Path $PyDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
        $lines = @(Get-Content -Path $pth.FullName)
        if ($lines -notcontains '..\host') { Set-Content -Path $pth.FullName -Value ($lines + '..\host') -Encoding ASCII }
    }

    $env:PYTHONIOENCODING = 'utf-8'
    # With a newer install the INSTALLED installer.py does the repair work, and leaves the host and the extension files alone.
    if ($Keep) {
        & $py (Join-Path $HostDir 'installer.py') --home $Root --ext-id '@@EXT_ID@@' --no-deploy --version $Embedded
    } else {
        & $py (Join-Path $HostDir 'installer.py') --home $Root --ext-id '@@EXT_ID@@' --extension-zip (Join-Path $Root 'extension.zip') --version $Embedded
    }
} catch {
    Write-Host ''
    Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '請截圖這個視窗，並聯絡提供工具的同事。'
}
