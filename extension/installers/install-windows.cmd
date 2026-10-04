@echo off
chcp 65001 >nul
title YouTube 批量下載器 安裝程式
echo YouTube 批量下載器 安裝程式 0.1.0
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

$HostName = 'com.ytdl.batch_downloader'
$ExtId = 'mimlajbhpiphbndalphgmkdehgclnglg'
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

try {
    New-Item -ItemType Directory -Force -Path $Root, $HostDir, $BinDir, $PyDir, $Tmp | Out-Null

    Step '寫入本機小程式'
    $payload = Join-Path $Tmp 'host.zip'
    [IO.File]::WriteAllBytes($payload, [Convert]::FromBase64String('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'))
    Expand-Archive -Force -Path $payload -DestinationPath $HostDir

    $py = Join-Path $PyDir 'python.exe'
    if (-not (Test-Path $py)) {
        Step '下載 Python（內嵌版）'
        $zip = Join-Path $Tmp 'python.zip'
        Fetch 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip' $zip
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
    Fetch 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $ytdlp
    $resp = Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS' -UseBasicParsing
    $sums = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
    $m = [regex]::Match($sums, '(?m)^\s*([0-9a-fA-F]{64})\s+\*?yt-dlp\.exe\s*$')
    if (-not $m.Success) { throw '找不到 yt-dlp.exe 的 SHA-256 校驗碼' }
    if ((Get-FileHash -Algorithm SHA256 -Path $ytdlp).Hash -ne $m.Groups[1].Value) { throw 'yt-dlp.exe 校驗碼不符，檔案可能損毀，請重新執行' }

    if (-not (Test-Path (Join-Path $BinDir 'deno.exe'))) {
        Step '下載 Deno（YouTube 解題需要）'
        $zip = Join-Path $Tmp 'deno.zip'
        Fetch 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' $zip
        Expand-Archive -Force -Path $zip -DestinationPath $BinDir
    }

    if (-not (Test-Path (Join-Path $BinDir 'ffmpeg.exe'))) {
        Step '下載 ffmpeg'
        $zip = Join-Path $Tmp 'ffmpeg.zip'
        $dir = Join-Path $Tmp 'ffmpeg'
        Fetch 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip' $zip
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

    Step '自我檢查'
    $version = & $ytdlp --version
    if ($LASTEXITCODE -ne 0) { throw 'yt-dlp 無法執行（可能缺少 Visual C++ 執行階段，或被防毒軟體攔截）' }
    Write-Host "    yt-dlp $version"
    & $py -c "import sys; sys.path.insert(0, sys.argv[1]); import host; print('    host ok')" $HostDir
    if ($LASTEXITCODE -ne 0) { throw '本機小程式無法載入' }

    Write-Host ''
    Write-Host '安裝完成！請回到 Chrome，打開擴充功能並按「啟動」。' -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '請截圖這個視窗，並聯絡提供工具的同事。'
}
