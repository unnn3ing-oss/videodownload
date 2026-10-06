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
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$HostName = '@@HOST_NAME@@'
$ExtId = '@@EXT_ID@@'
$Root = Join-Path $env:LOCALAPPDATA 'YTDownloader'
$HostDir = Join-Path $Root 'host'
$BinDir = Join-Path $Root 'bin'
$PyDir = Join-Path $Root 'python'
$Tmp = Join-Path $env:TEMP 'ytdl-setup'

function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Fetch($url, $dest) {
    Write-Host "    下載 $url"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}
# Every part is judged by whether it runs, not by whether the file exists: running this installer again repairs what is broken.
function Works($exe, $arg) {
    if (-not (Test-Path $exe)) { return $false }
    try { & $exe $arg *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

try {
    New-Item -ItemType Directory -Force -Path $Root, $HostDir, $BinDir, $PyDir, $Tmp | Out-Null

    Step '寫入本機小程式'
    $payload = Join-Path $Tmp 'host.zip'
    [IO.File]::WriteAllBytes($payload, [Convert]::FromBase64String('@@PAYLOAD_B64@@'))
    Expand-Archive -Force -Path $payload -DestinationPath $HostDir

    $py = Join-Path $PyDir 'python.exe'
    if (-not (Works $py '--version')) {
        Step '下載 Python（內嵌版）'
        $zip = Join-Path $Tmp 'python.zip'
        Fetch '@@URL_PYTHON_WIN@@' $zip
        Expand-Archive -Force -Path $zip -DestinationPath $PyDir
    }
    # The embeddable Python ignores the script folder, so list the host folder in its ._pth file.
    $pth = Get-ChildItem -Path $PyDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
        $lines = @(Get-Content -Path $pth.FullName)
        if ($lines -notcontains '..\host') { Set-Content -Path $pth.FullName -Value ($lines + '..\host') -Encoding ASCII }
    }

    Step '下載 yt-dlp 並驗證校驗碼'
    $ytdlp = Join-Path $BinDir 'yt-dlp.exe'
    Fetch '@@URL_YTDLP_WIN@@' $ytdlp
    $resp = Invoke-WebRequest -Uri '@@URL_YTDLP_SUMS@@' -UseBasicParsing
    $sums = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
    $m = [regex]::Match($sums, '(?m)^\s*([0-9a-fA-F]{64})\s+\*?yt-dlp\.exe\s*$')
    if (-not $m.Success) { throw '找不到 yt-dlp.exe 的 SHA-256 校驗碼' }
    if ((Get-FileHash -Algorithm SHA256 -Path $ytdlp).Hash -ne $m.Groups[1].Value) { throw 'yt-dlp.exe 校驗碼不符，檔案可能損毀，請重新執行' }

    if (-not (Works (Join-Path $BinDir 'deno.exe') '--version')) {
        Step '下載 Deno（YouTube 解題需要）'
        $zip = Join-Path $Tmp 'deno.zip'
        Fetch '@@URL_DENO_WIN@@' $zip
        Expand-Archive -Force -Path $zip -DestinationPath $BinDir
    }

    if (-not (Works (Join-Path $BinDir 'ffmpeg.exe') '-version')) {
        Step '下載 ffmpeg'
        $zip = Join-Path $Tmp 'ffmpeg.zip'
        $dir = Join-Path $Tmp 'ffmpeg'
        Fetch '@@URL_FFMPEG_WIN@@' $zip
        Expand-Archive -Force -Path $zip -DestinationPath $dir
        $exe = Get-ChildItem -Path $dir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
        if (-not $exe) { throw '壓縮檔裡找不到 ffmpeg.exe' }
        Copy-Item -Path $exe.FullName -Destination $BinDir -Force
    }

    Step '登錄 Chrome Native Messaging'
    $launcher = Join-Path $Root 'host.cmd'
    # Relative paths only: the launcher stays ASCII even when the user name is not.
    Set-Content -Path $launcher -Encoding ASCII -Value @(
        '@echo off',
        'set "YTDL_HOME=%~dp0"',
        '"%~dp0python\python.exe" -u "%~dp0host\host.py"'
    )
    $manifestPath = Join-Path $Root "$HostName.json"
    $manifest = @{
        name = $HostName
        description = 'YouTube 批量下載器本機小程式'
        path = $launcher
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtId/")
    } | ConvertTo-Json
    [IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))
    New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" -Value $manifestPath -Force | Out-Null

    Step '檢查安裝結果'
    & $py (Join-Path $HostDir 'doctor.py') --home $Root --ext-id $ExtId --native-manifest $manifestPath
    if ($LASTEXITCODE -ne 0) { throw '上面標著 ✘ 的項目需要處理（照每一項下面的「→」建議做）' }

    Write-Host ''
    Write-Host '安裝完成！請回到 Chrome，打開擴充功能並按「啟動」。' -ForegroundColor Green
    Write-Host '之後如果遇到任何問題，重新執行這個安裝檔就會自動檢查並修復。'
} catch {
    Write-Host ''
    Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '請截圖這個視窗，並聯絡提供工具的同事。'
}
