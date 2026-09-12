<#
.SYNOPSIS
  yt-dlp로 유튜브 영상과 자막을 내려받는다. 없으면 winget으로 설치까지 처리.
.EXAMPLE
  .\fetch.ps1 -Url "https://youtu.be/XXXX" -OutDir "week-4/class"
  .\fetch.ps1 -Url "https://youtu.be/XXXX" -OutDir "." -SubsOnly
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$OutDir = ".",
    [string]$Langs = "ko",
    [switch]$SubsOnly,
    [switch]$NoSubs
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Sync-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}

# winget이 PATH를 수정해도 이미 떠 있는 셸에는 반영되지 않는다. 매번 다시 읽는다.
Sync-Path

if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
    Write-Host "[설치] yt-dlp가 없어 winget으로 설치합니다 (ffmpeg, deno 동반 설치)..."
    winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements --disable-interactivity
    Sync-Path
    if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
        throw "yt-dlp 설치 실패. winget 출력을 확인하세요."
    }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$tmpl = Join-Path $OutDir '%(title)s.%(ext)s'

Write-Host "[정보] 영상 메타데이터 확인..."
yt-dlp --no-warnings --print "%(title)s | %(duration_string)s | %(uploader)s | %(resolution)s" $Url

if (-not $SubsOnly) {
    Write-Host "[영상] 다운로드 시작..."
    yt-dlp -f "bv*+ba/b" --merge-output-format mp4 --no-progress -o $tmpl $Url
    if ($LASTEXITCODE -ne 0) { throw "영상 다운로드 실패 (exit $LASTEXITCODE)" }
}

if (-not $NoSubs) {
    # 자동 생성 자막은 언어별로 따로 요청된다. 번역 캡션(원어 외)은 429가 잦으므로
    # 언어를 하나씩 돌려 실패해도 나머지는 살린다.
    foreach ($lang in ($Langs -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        Write-Host "[자막] $lang 시도..."
        yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs $lang `
               --convert-subs srt --no-progress -o $tmpl $Url
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "자막 '$lang' 실패 (429면 잠시 후 재시도). 계속 진행합니다."
        }
    }
}

Write-Host "`n[완료] $OutDir"
Get-ChildItem $OutDir | Select-Object Name, @{n = 'Size'; e = { "{0:N0}" -f $_.Length } } | Format-Table -AutoSize
