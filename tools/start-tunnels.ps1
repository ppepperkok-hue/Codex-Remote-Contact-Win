# Start the Cloudflare tunnel(s) for the hub and webuis.
# Prefers a named tunnel configured in ~/.cloudflared/config.yml (stable
# hostnames); falls back to per-port quick tunnels (random trycloudflare URLs).
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

$namedConfig = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
$namedLog = Join-Path $runtime "cloudflared-named.log"

if (Test-Path $namedConfig) {
  $running = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match [regex]::Escape($namedLog) }
  if (-not $running) {
    Start-Process -FilePath $cloudflared -ArgumentList @(
      "tunnel", "--no-autoupdate", "--logfile", $namedLog, "run"
    ) -WindowStyle Hidden
    Write-Output "started named tunnel"
  } else {
    Write-Output "named tunnel already running"
  }
  exit 0
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
