# Start one Cloudflare quick tunnel per local web service (hub + webuis).
# Safe to run at every login: already-running tunnels are skipped.
$ErrorActionPreference = "Continue"

$projectDir = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $projectDir "runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
  $cloudflared = "C:\Program Files\cloudflared\cloudflared.exe"
}
if (-not (Test-Path $cloudflared)) {
  Write-Output "cloudflared not found"
  exit 1
}

$targets = @(
  @{ Port = 3789; Log = "cloudflared.log" },
  @{ Port = 6099; Log = "cloudflared-6099.log" },
  @{ Port = 6100; Log = "cloudflared-6100.log" },
  @{ Port = 6185; Log = "cloudflared-6185.log" }
)

foreach ($target in $targets) {
  $log = Join-Path $runtime $target.Log
  $running = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match [regex]::Escape($log) }
  if ($running) {
    Write-Output "skip $($target.Port) (already running)"
    continue
  }
  Start-Process -FilePath $cloudflared -ArgumentList @(
    "tunnel",
    "--url", ("http://127.0.0.1:" + $target.Port),
    "--no-autoupdate",
    "--protocol", "http2",
    "--edge-ip-version", "4",
    "--retries", "10",
    "--logfile", $log
  ) -WindowStyle Hidden
  Write-Output "started tunnel for $($target.Port)"
}
