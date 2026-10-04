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
