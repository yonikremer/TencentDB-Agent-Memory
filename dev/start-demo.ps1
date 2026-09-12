# Demo: real core (docker) + knowledge + panel + web. Prints the admin key.
# Usage: .\dev\start-demo.ps1   (from the repo root)
# Stop:   .\dev\stop-demo.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$main = "C:\Users\yonik\TencentDB-Agent-Memory"
$tmp = Join-Path $env:TEMP "conn-demo"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Import-PrefixedEnv($file, $prefixes) {
  Get-Content $file | ForEach-Object {
    $t = $_.Trim()
    if ($t -and -not $t.StartsWith("#") -and $t.Contains("=")) {
      $i = $t.IndexOf("=")
      $k = $t.Substring(0, $i).Trim()
      $v = $t.Substring($i + 1).Trim()
      foreach ($p in $prefixes) {
        if ($k -like "$p*") { Set-Item -Path ("Env:" + $k) -Value $v }
      }
    }
  }
}

# ── 1. Real metadata kernel (docker) ──
$running = (docker ps --format "{{.Names}}") -contains "tdai-memory-core"
if (-not $running) {
  $exists = (docker ps -a --format "{{.Names}}") -contains "tdai-memory-core"
  if ($exists) { docker start tdai-memory-core | Out-Null }
  else {
    Write-Host "No tdai-memory-core container. Run once from main tree:"
    Write-Host "  cd $main\deploy\global-images"
    Write-Host "  cp .env.example .env"
    Write-Host "  ./start-memory-core.sh"
    exit 1
  }
}
$deadline = (Get-Date).AddSeconds(90)
while ($true) {
  try {
    $h = Invoke-RestMethod "http://localhost:8420/health" -TimeoutSec 3
    if ($h.status -eq "ok") { break }
  } catch {}
  if ((Get-Date) -gt $deadline) { throw "core not healthy in time" }
  Start-Sleep -Seconds 2
}
Write-Host "core up: http://localhost:8420"

# ── 2. Admin key (create on first run, reuse after) ──
$keyFile = Join-Path $main "deploy\global-images\.admin-key"
if (-not (Test-Path $keyFile) -or (Get-Item $keyFile).Length -eq 0) {
  $key = "sk-admin-" + (-join ((48..57) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ }))
  $resp = Invoke-RestMethod "http://localhost:8420/v3/internal/meta/user/init-admin" `
    -Method Post -ContentType "application/json" `
    -Headers @{ "x-tdai-service-id" = "default" } `
    -Body (@{ username = "admin"; user_key = $key } | ConvertTo-Json)
  if ($resp.code -ne 0) { throw "init-admin failed: $($resp.message)" }
  Set-Content -Path $keyFile -Value $key -NoNewline
}
$adminKey = (Get-Content $keyFile -Raw).Trim()

# ── 3. Services ──
Import-PrefixedEnv (Join-Path $root "connector_testing.env") @("GOOGLE_", "MS_", "DROPBOX_CONNECTOR_")

Start-Process -FilePath "node" -ArgumentList (Join-Path $root "dev\verify-stub.cjs") -WindowStyle Hidden

$ksDir = Join-Path $root "MemoryKnowledge"
Start-Process -FilePath "node" -WorkingDirectory $ksDir -WindowStyle Hidden `
  -ArgumentList @("--import", "tsx", "node_modules/tsx/dist/cli.mjs", "src/server.ts") `
  -RedirectStandardOutput (Join-Path $tmp "ks.log") -RedirectStandardError (Join-Path $tmp "kserr.log") `
  -Environment @{
    PORT = "8421"; KNOWLEDGE_DATA_DIR = (Join-Path $tmp "data");
    KNOWLEDGE_DB_PATH = (Join-Path $tmp "data\knowledge.db");
    KNOWLEDGE_PUBLIC_BASE_URL = "http://localhost:8421/v3";
    CORE_VERIFY_URL = "http://localhost:8420"; LOG_LEVEL = "info"
  }

$panelDir = Join-Path $root "MemoryPanel"
Start-Process -FilePath "node" -WorkingDirectory $panelDir -WindowStyle Hidden `
  -ArgumentList @("--import", "tsx", "node_modules/tsx/dist/cli.mjs", "--watch", "src/index.ts") `
  -RedirectStandardOutput (Join-Path $tmp "panel.log") -RedirectStandardError (Join-Path $tmp "panelerr.log") `
  -Environment @{ PORT = "8123"; KNOWLEDGE_SERVICE_URL = "http://127.0.0.1:8421"; LOG_LEVEL = "info" }

$webDir = Join-Path $panelDir "web"
Start-Process -FilePath "node" -WorkingDirectory $webDir -WindowStyle Hidden `
  -ArgumentList @("$webDir\node_modules\vite\bin\vite.js", "--port", "5173", "--strictPort") `
  -RedirectStandardOutput (Join-Path $tmp "web.log") -RedirectStandardError (Join-Path $tmp "weberr.log") `
  -Environment @{ VITE_TMC_BACKEND_URL = "http://127.0.0.1:8123"; VITE_SKILL_GATEWAY_URL = "http://127.0.0.1:8421" }

Write-Host ""
Write-Host "  UI:      http://localhost:5173"
Write-Host "  instance: Local Default Instance"
Write-Host "  ADMIN KEY: $adminKey"
Write-Host ""
Write-Host "logs in $tmp"
