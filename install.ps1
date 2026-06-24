#Requires -Version 5
<#
  Agent Fleet - one-command bootstrap for Windows (PowerShell).

    git clone <repo-url> agent-fleet
    cd agent-fleet
    .\install.ps1

  Idempotent (safe to re-run). Sets up a fresh machine: tokens, the self-contained
  MCP config, the Claude Code hooks, builds + starts the hub, and verifies it.
  Everything runs on localhost; Tailscale / Cloudflare are opt-in (see QUICKSTART.md).

  PREREQS: Node 22 (pinned in .nvmrc) AND Git Bash. The fleet's wake/session hooks
  are shell scripts; on Windows they run via Git Bash (https://git-scm.com/download/win).
  No secrets are hardcoded; tokens are generated locally.

  Flags:  -NoStart            set up but do not launch the hub
          -Port <n>           hub port (default: PORT env / .env / 9559)
          -HubUrl <url>       join an EXISTING remote hub instead of running one
          -JoinToken <token>  that remote hub's join token (required with -HubUrl)

  Client-only mode (join an existing hub on another machine, any OS):
    .\install.ps1 -HubUrl https://hub.example.com -JoinToken <REMOTE_TOKEN>
  In this mode the installer does NOT generate tokens, does NOT create an admin
  token, and does NOT start a local hub - it only points this machine's MCP +
  hooks at the remote hub and verifies it is reachable.
#>
[CmdletBinding()]
param(
  [switch]$NoStart,
  [int]$Port = 0,
  [string]$HubUrl = "",
  [string]$JoinToken = ""
)
$ErrorActionPreference = "Stop"

# Client-only mode requires BOTH -HubUrl and -JoinToken (guard half-specs).
$ClientOnly = $false
if ($HubUrl -or $JoinToken) {
  if (-not $HubUrl)    { Write-Host "[fleet] error: -JoinToken requires -HubUrl (join an existing hub with both)." -ForegroundColor Red; exit 1 }
  if (-not $JoinToken) { Write-Host "[fleet] error: -HubUrl requires -JoinToken (the remote hub's join token)." -ForegroundColor Red; exit 1 }
  $ClientOnly = $true
}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $RepoRoot

function Log  ($m) { Write-Host "[fleet] $m" -ForegroundColor Green }
function Info ($m) { Write-Host "[fleet] $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "[fleet] $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "[fleet] error: $m" -ForegroundColor Red; exit 1 }

# ---- 1. Node preflight ----------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "Node.js not found. Install Node 22 (see .nvmrc), then re-run."
}
if (Test-Path "scripts/check-node.mjs") {
  & node scripts/check-node.mjs
  if ($LASTEXITCODE -ne 0) { Die "Wrong Node version. Install Node 22 (per .nvmrc), then re-run .\install.ps1" }
} else {
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 22) { Die "Node >= 22 required (found $(node -v)); better-sqlite3 needs Node 22's ABI." }
}
Log "Node $(node -v) OK"

# ---- 2. Git Bash (runs the .sh hooks on Windows) --------------------------
# MUST be a real Git-for-Windows bash. Do NOT use C:\Windows\System32\bash.exe —
# that's the WSL launcher; it runs the hooks inside a Linux filesystem where the
# Windows hook paths (C:/...) and node aren't on PATH, so the fleet silently
# breaks. `Get-Command bash.exe` returns System32\bash.exe first on any
# WSL-enabled box, so detect in this order: (1) derive from git.exe — the user
# just `git clone`d, so git is present; (2) known Git install dirs; (3) PATH, but
# skip the System32 WSL stub.
$BashExe = $null

# (1) Derive from git.exe:  <gitroot>\cmd\git.exe  ->  <gitroot>\bin\bash.exe
$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if ($gitCmd) {
  $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCmd.Source)
  $cand = Join-Path $gitRoot "bin\bash.exe"
  if (Test-Path $cand) { $BashExe = $cand }
}

# (2) Known Git-for-Windows install locations.
if (-not $BashExe) {
  foreach ($p in @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")) {
    if (Test-Path $p) { $BashExe = $p; break }
  }
}

# (3) PATH fallback — every bash.exe except the System32 WSL stub.
if (-not $BashExe) {
  foreach ($c in @(Get-Command bash.exe -All -ErrorAction SilentlyContinue)) {
    if ($c.Source -and $c.Source -notmatch '\\System32\\') { $BashExe = $c.Source; break }
  }
}

if (-not $BashExe) {
  Die "Git Bash not found. The fleet's session/wake hooks are shell scripts that run via Git Bash on Windows (System32\bash.exe is the WSL launcher and won't work). Install Git for Windows (https://git-scm.com/download/win), then re-run .\install.ps1"
}
Log "Git Bash: $BashExe"

# ---- CLIENT-ONLY MODE: join an existing remote hub ------------------------
# When -HubUrl + -JoinToken are given, this machine is a Tier-2 CLIENT: it does
# NOT generate tokens, does NOT create an admin token, and does NOT start a local
# hub (NONE of the ShellExecute/detached-launch logic runs in this mode). It only
# points the MCP config + Claude Code hooks at the remote hub and verifies the
# remote /board returns 200 BEFORE writing config / declaring success.
if ($ClientOnly) {
  $HubUrlValue = $HubUrl.TrimEnd('/')   # strip trailing slash(es) so "$HubUrlValue/board" never becomes "//board" (stricter proxies/CF 404)
  Log "Client-only mode: joining existing hub at $HubUrlValue (no local hub will start)."

  # Probe the remote hub FIRST - fail fast with no half-written config.
  $boardOk = $false
  try {
    $ErrorActionPreference = 'Continue'
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$HubUrlValue/board" -TimeoutSec 10
    $boardOk = ($r.StatusCode -eq 200)
  } catch { $boardOk = $false } finally { $ErrorActionPreference = 'Stop' }
  if (-not $boardOk) {
    Die "Could not reach the hub at $HubUrlValue/board (expected HTTP 200). Check the URL is correct and reachable from this machine, then re-run."
  }
  Log "Remote hub reachable: $HubUrlValue/board returns 200."

  # The MCP bundle ships COMMITTED + self-contained (esbuild, ZERO native deps -
  # no better-sqlite3). A Tier-2 client never runs a hub, so DON'T npm install /
  # build / bundle: that would needlessly force the hub's better-sqlite3 native
  # compile on a machine that will never use it (the cross-OS fragility this
  # project fought on Windows). Just verify the committed bundle is present.
  $McpBundle = Join-Path $RepoRoot "plugin\dist\mcp-server.mjs"
  if (-not (Test-Path $McpBundle)) { Die "MCP bundle missing at $McpBundle - is this a complete clone?" }

  # Write .env (remote hub URL + remote join token only - NO tokens generated,
  # NO admin token, NO local hub).
  $EnvFile = Join-Path $RepoRoot ".env"
  if (Test-Path $EnvFile) {
    Warn ".env already exists - keeping it. Delete it and re-run to repoint at $HubUrlValue."
  } else {
    Log "Writing .env (client-only: remote hub URL + remote join token)..."
    @(
      "# Generated by install.ps1 (client-only / join existing hub). NEVER commit this file.",
      "# This machine joins a REMOTE hub; the token below is the REMOTE hub's join token.",
      "AGENT_FLEET_HUB_URL=$HubUrlValue",
      "AGENT_FLEET_JOIN_TOKEN=$JoinToken"
    ) | Set-Content -Path $EnvFile -Encoding ASCII
  }

  # Vendored MCP config -> remote URL + remote token (same shape as solo path).
  Log "Writing vendored MCP config -> .mcp.json (-> $HubUrlValue)"
  $mcpArg = ($McpBundle -replace '\\','/')
  $mcp = [ordered]@{
    mcpServers = [ordered]@{
      "agent-fleet" = [ordered]@{
        command = "node"
        args    = @($mcpArg)
        env     = [ordered]@{
          AGENT_FLEET_JOIN_TOKEN = $JoinToken
          AGENT_FLEET_HUB_URL    = $HubUrlValue
        }
      }
    }
  }
  ($mcp | ConvertTo-Json -Depth 6) | Set-Content -Path (Join-Path $RepoRoot ".mcp.json") -Encoding ASCII

  # Claude Code hooks: copy + wire settings.json to the REMOTE hub.
  $ClaudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
  $HooksDir = Join-Path $ClaudeHome "hooks"
  $Settings = Join-Path $ClaudeHome "settings.json"
  New-Item -ItemType Directory -Force -Path (Join-Path $HooksDir "state") | Out-Null
  $FleetHooks = @(
    "agent-fleet-sessionstart.sh","agent-fleet-msgcheck.sh","agent-fleet-rewake.sh",
    "agent-fleet-tabtitle.sh","fleet-taskboard.js","fleet-plan-heartbeat.js",
    "wt-lease-guard.js","wt-context-gauge.cjs"
  )
  Log "Installing $($FleetHooks.Count) hooks -> $HooksDir"
  foreach ($h in $FleetHooks) {
    $src = Join-Path $RepoRoot "deploy\hooks\$h"
    if (-not (Test-Path $src)) { Die "hook source missing: $src" }
    Copy-Item -Force $src (Join-Path $HooksDir $h)
  }
  # Ship the multi-instance protocol doc to ~/.claude/docs so the hook + SKILL
  # refs to ~/.claude/docs/dual-instance-protocol.md resolve on a fresh clone.
  $ProtoDoc = Join-Path $RepoRoot "docs\dual-instance-protocol.md"
  if (Test-Path $ProtoDoc) { New-Item -ItemType Directory -Force -Path (Join-Path $ClaudeHome "docs") | Out-Null; Copy-Item -Force $ProtoDoc (Join-Path $ClaudeHome "docs\dual-instance-protocol.md") }
  Log "Wiring hooks into $Settings (merge, non-destructive)..."
  $env:FLEET_SETTINGS  = $Settings
  $env:FLEET_HOOKS_DIR = $HooksDir
  $env:FLEET_JOIN_TOKEN = $JoinToken
  $env:FLEET_HUB_URL    = $HubUrlValue
  $env:FLEET_PLATFORM   = "windows"
  $env:FLEET_BASH       = $BashExe
  & node (Join-Path $RepoRoot "scripts\install\wire-fleet-hooks.mjs")
  if ($LASTEXITCODE -ne 0) { Die "hook wiring failed" }

  Write-Host ""
  Log "Joined existing hub at $HubUrlValue. Open $HubUrlValue in your browser; restart Claude Code, then fleet_join with a callsign."
  exit 0
}

# ---- 3. .env (tokens + solo defaults), idempotent -------------------------
$EnvFile = Join-Path $RepoRoot ".env"
function New-Token { & node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))" }
$EnvPort = if ($Port -ne 0) { $Port } elseif ($env:PORT) { [int]$env:PORT } else { 9559 }

if (Test-Path $EnvFile) {
  Log ".env already exists - keeping it (re-run safe; delete it to regenerate tokens)."
} else {
  Log "Generating .env (fresh tokens + solo localhost defaults)..."
  New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "data") | Out-Null
  $join  = New-Token
  $admin = New-Token
  $dbPath = (Join-Path $RepoRoot "data\agent-fleet.db")
  @(
    "# Generated by install.ps1 - solo / localhost. NEVER commit this file.",
    "AGENT_FLEET_JOIN_TOKEN=$join",
    "AGENT_FLEET_ADMIN_TOKEN=$admin",
    "PORT=$EnvPort",
    "AGENT_FLEET_HUB_URL=http://localhost:$EnvPort",
    "AGENT_FLEET_DB_PATH=$dbPath",
    "AF_OPERATOR_NAME=Operator"
  ) | Set-Content -Path $EnvFile -Encoding ASCII
}

# Load .env into this process' environment (so npm/node inherit it).
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*([^=]+?)\s*=\s*(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
  }
}
if ($Port -ne 0) { $env:PORT = "$Port" }
$HubPort = if ($env:PORT) { $env:PORT } else { "9559" }
$HubUrl  = if ($env:AGENT_FLEET_HUB_URL) { $env:AGENT_FLEET_HUB_URL } else { "http://localhost:$HubPort" }
if (-not $env:AGENT_FLEET_JOIN_TOKEN)  { Die ".env is missing AGENT_FLEET_JOIN_TOKEN" }
if (-not $env:AGENT_FLEET_ADMIN_TOKEN) { Die ".env is missing AGENT_FLEET_ADMIN_TOKEN" }

# ---- 4. Dependencies + build ----------------------------------------------
# Call npm.cmd explicitly, never `& npm`. On Windows PowerShell 5.1 `& npm`
# resolves npm.ps1, whose arg-passing is buggy — it mangles the subcommand
# (e.g. `npm install` -> npm errors `Unknown command: "pm"`), which aborts the
# install. npm.cmd is the batch wrapper and passes argv cleanly via %*.
$npmResolved = Get-Command npm.cmd -ErrorAction SilentlyContinue
$NpmExe = if ($npmResolved) { $npmResolved.Source } else { "npm.cmd" }
function Invoke-Npm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs)
  # npm prints deprecation warnings (e.g. prebuild-install) to stderr. Under the
  # script's $ErrorActionPreference='Stop', those become a *terminating*
  # NativeCommandError whenever the caller captures/merges streams — e.g. a new
  # user or IT running `.\install.ps1 > install.log 2>&1` to keep a log, or CI.
  # The npm run itself is fine (non-zero $LASTEXITCODE only on real failure), so
  # run it under a function-local 'Continue' (does not leak to the rest of the
  # script) and keep gating on the real exit code via the Die checks below.
  $ErrorActionPreference = 'Continue'
  & $NpmExe @NpmArgs
}

Log "Installing dependencies (npm install)..."
Invoke-Npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die "npm install failed" }

# ---- 4b. Guarantee the better-sqlite3 native binary loads -----------------
# The hub require()s better-sqlite3's compiled .node at runtime. On Windows this
# is where a fresh clone most often breaks: if the win32 binary isn't present
# (prebuild-install couldn't fetch a prebuild for this Node/arch, or the node-gyp
# fallback needs Visual Studio Build Tools / MSVC), the hub crashes at require()
# and never starts. (npm 11.16+'s allow-scripts warning is ADVISORY only —
# scripts still run — so it is NOT itself the cause; we gate on whether the
# binary actually LOADS.) Verify the load from the hub's resolution context; if
# it fails, rebuild explicitly and re-verify; otherwise it's a harmless no-op.
# On failure, surface the REAL load error so the cause is visible.
function Test-NativeDeps {
  $ErrorActionPreference = 'Continue'
  Push-Location (Join-Path $RepoRoot "hub")
  try { & node -e "require('better-sqlite3')" *> $null; return ($LASTEXITCODE -eq 0) }
  finally { Pop-Location }
}
function Get-NativeLoadError {
  $ErrorActionPreference = 'Continue'
  Push-Location (Join-Path $RepoRoot "hub")
  try { return (& node -e "try{require('better-sqlite3');process.exit(0)}catch(e){console.error(String((e&&e.message)||e));process.exit(1)}" 2>&1 | Out-String).Trim() }
  finally { Pop-Location }
}
if (Test-NativeDeps) {
  Log "Native deps OK (better-sqlite3 loads)."
} else {
  Warn "better-sqlite3 did not load after npm install - rebuilding native deps with verbose build output captured..."
  New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "logs") | Out-Null
  $nativeLog = Join-Path $RepoRoot "logs\native-build.log"
  # Verbose + foreground so prebuild-install's prebuild FETCH attempt AND any
  # node-gyp / MSVC / Python output are captured to a file. If this still fails,
  # that log names the exact win32 cause - no second blind run needed. EAP is
  # set Continue locally so npm's stderr (warnings) under *>&1 capture doesn't
  # become a terminating error.
  $savedEAP = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $NpmExe rebuild better-sqlite3 node-pty --foreground-scripts --loglevel verbose *>&1 | Tee-Object -FilePath $nativeLog
  } finally { $ErrorActionPreference = $savedEAP }
  if (Test-NativeDeps) {
    Log "Native deps rebuilt (better-sqlite3 loads). Build log: $nativeLog"
  } else {
    $loadErr = Get-NativeLoadError
    Die @"
better-sqlite3's native binary is missing/unloadable after npm install + npm rebuild - this is the hub-start blocker on Windows.
  Underlying load error: $loadErr
  Full build output (prebuild-install fetch + node-gyp): $nativeLog
A win32 prebuild for this Node/arch IS published, so the likely cause is a prebuild-install FETCH failure (proxy/firewall to github.com) or a node-gyp build failure (e.g. Python 3.13 vs node-gyp). Inspect $nativeLog for the exact line, then re-run .\install.ps1
"@
  }
}

Log "Building hub + MCP bundle..."
Invoke-Npm run build;  if ($LASTEXITCODE -ne 0) { Die "build failed" }
Invoke-Npm run bundle; if ($LASTEXITCODE -ne 0) { Die "bundle failed" }

# ---- 5. Vendored, self-contained MCP config -------------------------------
$McpBundle = Join-Path $RepoRoot "plugin\dist\mcp-server.mjs"
if (-not (Test-Path $McpBundle)) { Die "MCP bundle missing at $McpBundle (npm run bundle should have built it)." }
Log "Writing vendored MCP config -> .mcp.json"
$mcpArg = ($McpBundle -replace '\\','/')
$mcp = [ordered]@{
  mcpServers = [ordered]@{
    "agent-fleet" = [ordered]@{
      command = "node"
      args    = @($mcpArg)
      env     = [ordered]@{
        AGENT_FLEET_JOIN_TOKEN = $env:AGENT_FLEET_JOIN_TOKEN
        AGENT_FLEET_HUB_URL    = $HubUrl
      }
    }
  }
}
($mcp | ConvertTo-Json -Depth 6) | Set-Content -Path (Join-Path $RepoRoot ".mcp.json") -Encoding ASCII

# ---- 6. Claude Code hooks: copy + wire settings.json ----------------------
$ClaudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
$HooksDir = Join-Path $ClaudeHome "hooks"
$Settings = Join-Path $ClaudeHome "settings.json"
New-Item -ItemType Directory -Force -Path (Join-Path $HooksDir "state") | Out-Null

$FleetHooks = @(
  "agent-fleet-sessionstart.sh","agent-fleet-msgcheck.sh","agent-fleet-rewake.sh",
  "agent-fleet-tabtitle.sh","fleet-taskboard.js","fleet-plan-heartbeat.js",
  "wt-lease-guard.js","wt-context-gauge.cjs"
)
Log "Installing $($FleetHooks.Count) hooks -> $HooksDir"
foreach ($h in $FleetHooks) {
  $src = Join-Path $RepoRoot "deploy\hooks\$h"
  if (-not (Test-Path $src)) { Die "hook source missing: $src" }
  Copy-Item -Force $src (Join-Path $HooksDir $h)
}

# Ship the multi-instance protocol doc to ~/.claude/docs so the hook + SKILL
# refs to ~/.claude/docs/dual-instance-protocol.md resolve on a fresh clone.
$ProtoDoc = Join-Path $RepoRoot "docs\dual-instance-protocol.md"
if (Test-Path $ProtoDoc) { New-Item -ItemType Directory -Force -Path (Join-Path $ClaudeHome "docs") | Out-Null; Copy-Item -Force $ProtoDoc (Join-Path $ClaudeHome "docs\dual-instance-protocol.md") }

Log "Wiring hooks into $Settings (merge, non-destructive)..."
$env:FLEET_SETTINGS  = $Settings
$env:FLEET_HOOKS_DIR = $HooksDir
$env:FLEET_JOIN_TOKEN = $env:AGENT_FLEET_JOIN_TOKEN
$env:FLEET_HUB_URL    = $HubUrl
$env:FLEET_PLATFORM   = "windows"
$env:FLEET_BASH       = $BashExe
& node (Join-Path $RepoRoot "scripts\install\wire-fleet-hooks.mjs")
if ($LASTEXITCODE -ne 0) { Die "hook wiring failed" }

# ---- 7. Start the hub + verify -------------------------------------------
function Test-Board {
  # Patient: a first-run Windows cold-start (node JIT + antivirus scanning the
  # freshly built native .node) routinely takes longer than the old 15s. Poll
  # 127.0.0.1 (not 'localhost', which may try ::1 first and add per-request
  # latency) for up to ~90s, but fail fast if the hub process already exited.
  for ($i = 0; $i -lt 90; $i++) {
    try { if ($hub -and $hub.HasExited) { return $false } } catch { }
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$HubPort/board" -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    if ($i -gt 0 -and ($i % 10) -eq 0) { Info "  waiting for the hub to finish starting (${i}s; first Windows cold-start can be slow)..." }
    Start-Sleep -Seconds 1
  }
  return $false
}

if (-not $NoStart) {
  $alreadyUp = $false
  try { $alreadyUp = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$HubPort/board" -TimeoutSec 2).StatusCode -eq 200 } catch { }
  if ($alreadyUp) {
    Warn "Something is already serving port $HubPort - not starting a second hub. (Use -Port N or stop it.)"
  } else {
    New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "logs") | Out-Null
    Log "Starting the hub on port $HubPort (detached background)..."
    # FULLY DETACH from this shell's console. A plain Start-Process - even hidden
    # and with all stdio redirected - leaves node ATTACHED to the launching
    # console; over ssh/CI that console (a ConPTY) stays open until node exits, so
    # install.ps1 never returns (the Windows "hang"). Launch via ShellExecute
    # instead: Start-Process WITHOUT any -RedirectStandard* uses UseShellExecute=
    # $true, which gives the hub its OWN hidden console with no tie to this shell.
    # A tiny .cmd wrapper does the file redirection (stdout/stderr -> logs, stdin
    # <- NUL); the hub's env (PORT/tokens/DB) is INHERITED through ShellExecute,
    # so no secrets are written to the wrapper. (Win32_Process.Create would also
    # detach but does NOT inherit this shell's env -> wrong port / no tokens.)
    $nodeExe = (Get-Command node).Source
    $hubJs   = Join-Path $RepoRoot "hub\dist\index.js"
    $logOut  = Join-Path $RepoRoot "logs\hub.log"
    $logErr  = Join-Path $RepoRoot "logs\hub.err.log"
    $starter = Join-Path $RepoRoot "logs\start-hub.cmd"
    @(
      "@echo off",
      ('"' + $nodeExe + '" "' + $hubJs + '" > "' + $logOut + '" 2> "' + $logErr + '" < NUL')
    ) | Set-Content -Path $starter -Encoding ASCII
    $hub = Start-Process -FilePath $starter -WindowStyle Hidden -PassThru
    if ($hub) { $hub.Id | Set-Content -Path (Join-Path $RepoRoot ".hub.pid") }
    if (Test-Board) { Log "Hub is up: $HubUrl/board returns 200." }
    else { Die "Hub did not become reachable on /board within ~90s (process exited or slow start) - see logs\hub.log / logs\hub.err.log" }
  }
} else {
  Info "-NoStart: skipped launching the hub. Start it later from a shell with the .env loaded."
}

# ---- 8. Summary -----------------------------------------------------------
Write-Host ""
Log "Agent Fleet is set up."
Write-Host @"
  Hub URL ........ $HubUrl   (open this in your browser)
  Dashboard ...... $HubUrl/
  Tokens ......... $EnvFile  (join + admin; keep private, never commit)
  MCP config ..... $RepoRoot\.mcp.json
  Hooks .......... $HooksDir

  Next:
    1) Open $HubUrl in your browser.
    2) Restart Claude Code so it loads the MCP server + hooks.
    3) fleet_join with a callsign, then fleet_send a message.

  Multi-node / public dashboard / cockpit terminal are opt-in - see QUICKSTART.md.
"@
