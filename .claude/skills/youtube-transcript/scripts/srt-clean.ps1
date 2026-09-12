<#
.SYNOPSIS
  자동 생성 자막(.srt)의 롤업 중복을 제거하고, 이어붙인 전문과 타임코드 표를 출력한다.
.DESCRIPTION
  유튜브 ASR 자막은 같은 문장이 여러 블록에 겹쳐 나오는 롤업 형식이라 그대로는 읽을 수 없다.
  텍스트 줄을 순서대로 모은 뒤 "연속 중복"만 제거하면 원래 발화 순서가 복원된다.
.EXAMPLE
  .\srt-clean.ps1 -Path "week-4/class/영상.ko.srt"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Out
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 파일명에 [ ] 가 있으면 와일드카드로 해석된다. 반드시 -LiteralPath.
$full = (Resolve-Path -LiteralPath $Path).Path
# PowerShell 5.1의 Get-Content -Encoding은 환경에 따라 어긋난다. .NET으로 직접 읽는다.
$raw = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)

# 구분자는 '빈 줄 + 다음 블록 번호'만. \s* 로 느슨하게 잡으면
# 공백 한 칸짜리 자막 줄(ASR 롤업에 흔하다)을 구분자로 오인해 블록이 쪼개진다.
$blocks = [regex]::Split($raw.Trim(), '\r?\n[ \t]*\r?\n(?=[ \t]*\d+[ \t]*\r?\n)')
$items = New-Object System.Collections.ArrayList
$prev = $null

foreach ($b in $blocks) {
    $lines = [regex]::Split($b, '\r?\n') | Where-Object { $_ -ne $null }
    if ($lines.Count -lt 2) { continue }

    $tsLine = $lines | Where-Object { $_ -match '-->' } | Select-Object -First 1
    if (-not $tsLine) { continue }
    $start = ($tsLine -split '-->')[0].Trim()

    $tsIdx = [array]::IndexOf($lines, $tsLine)
    if ($tsIdx -lt 0 -or $tsIdx -ge $lines.Count - 1) { continue }
    $text = $lines[($tsIdx + 1)..($lines.Count - 1)] | Where-Object { $_.Trim() -ne '' }

    foreach ($t in $text) {
        $clean = $t.Trim()
        if ($clean -eq '' -or $clean -eq $prev) { continue }   # 롤업 중복 제거
        $mmss = if ($start -match '^\d+:(\d{2}:\d{2})') { $matches[1] } else { $start }
        [void]$items.Add([pscustomobject]@{ Time = $mmss; Text = $clean })
        $prev = $clean
    }
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("## 이어붙인 전문 (중복 제거)")
[void]$sb.AppendLine()
[void]$sb.AppendLine(($items.Text -join ' '))
[void]$sb.AppendLine()
[void]$sb.AppendLine("## 타임코드별 원본 자막")
[void]$sb.AppendLine()
[void]$sb.AppendLine("| 시각 | 내용 |")
[void]$sb.AppendLine("|---|---|")
foreach ($i in $items) {
    [void]$sb.AppendLine("| $($i.Time) | $($i.Text.Replace('|','\|')) |")
}
[void]$sb.AppendLine()
[void]$sb.AppendLine("<!-- 블록 $($blocks.Count)개 -> 발화 $($items.Count)줄 -->")

$result = $sb.ToString()
if ($Out) {
    [System.IO.File]::WriteAllText($Out, $result, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "저장: $Out ($($items.Count)줄)"
} else {
    Write-Output $result
}
