<#
.SYNOPSIS
  Generate a recipe thumbnail with Google's "Nano Banana" image model and save it as PNG.

.EXAMPLE
  $env:GEMINI_API_KEY = '<key>'
  .\gen-thumbnail.ps1 -OutPath 'C:\...\recipes\my-dish.png' -Prompt 'A warm anime film still ...'

.NOTES
  The API key is read from the -ApiKey parameter or the GEMINI_API_KEY environment variable.
  NEVER hardcode the key in this file or any file inside the repository.
#>
param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$Prompt = $env:IMAGE_PROMPT,
  [string]$ApiKey = $env:GEMINI_API_KEY,
  [string]$Model  = 'gemini-2.5-flash-image'
)

if (-not $ApiKey) { Write-Output 'ERROR: no API key. Set $env:GEMINI_API_KEY or pass -ApiKey.'; exit 1 }
if (-not $Prompt) { Write-Output 'ERROR: no prompt. Pass -Prompt or set $env:IMAGE_PROMPT.';   exit 1 }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$body = @{
  contents         = @( @{ parts = @( @{ text = $Prompt } ) } )
  generationConfig = @{ responseModalities = @('TEXT', 'IMAGE') }
} | ConvertTo-Json -Depth 10

$uri     = "https://generativelanguage.googleapis.com/v1beta/models/$Model`:generateContent"
$headers = @{ 'x-goog-api-key' = $ApiKey; 'Content-Type' = 'application/json; charset=utf-8' }

try {
  $resp = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 180
} catch {
  Write-Output "REQUEST_FAILED: $($_.Exception.Message)"
  $r = $_.Exception.Response
  if ($r) { Write-Output "BODY: $((New-Object IO.StreamReader($r.GetResponseStream())).ReadToEnd())" }
  exit 1
}

$dir = Split-Path -Parent $OutPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$saved = $false
foreach ($part in $resp.candidates[0].content.parts) {
  if ($part.inlineData -and $part.inlineData.data) {
    [IO.File]::WriteAllBytes($OutPath, [Convert]::FromBase64String($part.inlineData.data))
    Write-Output "SAVED: $OutPath ($((Get-Item $OutPath).Length) bytes, $($part.inlineData.mimeType))"
    $saved = $true
  } elseif ($part.text) {
    Write-Output "TEXT: $($part.text)"
  }
}

if (-not $saved) {
  Write-Output 'NO_IMAGE_RETURNED'
  Write-Output ($resp | ConvertTo-Json -Depth 8)
  exit 1
}
