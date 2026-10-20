# ==============================================================================
# Deploy & Test Adaptive Evacuation Readiness on Google Cloud Run (PowerShell)
#
# Automatically loads environment variables from .env (and agent/evac_agent/.env).
# No secrets or project IDs are hardcoded in this script.
#
# Usage (from repository root in PowerShell):
#   .\scripts\deploy_cloud_run.ps1                  # Deploy agent + dashboard + run smoke test
#   .\scripts\deploy_cloud_run.ps1 -AgentOnly       # Deploy only the ADK multi-agent service
#   .\scripts\deploy_cloud_run.ps1 -DashboardOnly   # Deploy only the React + FastAPI dashboard
#   .\scripts\deploy_cloud_run.ps1 -TestOnly        # Run smoke tests against deployed services
#   .\scripts\deploy_cloud_run.ps1 -SkipTest        # Deploy without running post-deploy smoke test
# ==============================================================================
param(
    [switch]$AgentOnly,
    [switch]$DashboardOnly,
    [switch]$TestOnly,
    [switch]$SkipTest
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# Ensure gcloud is on PATH on Windows if installed in standard SDK locations
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    $SdkPaths = @(
        "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin",
        "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin",
        "${env:ProgramFiles(x86)}\Google\Cloud SDK\google-cloud-sdk\bin"
    )
    foreach ($p in $SdkPaths) {
        if (Test-Path (Join-Path $p "gcloud.cmd")) {
            $env:PATH = "$p;$env:PATH"
            break
        }
    }
}

# ------------------------------------------------------------------------------
# 1. Load environment variables from .env files
# ------------------------------------------------------------------------------
function Import-DotEnv([string]$FilePath) {
    if (Test-Path $FilePath) {
        Write-Host "==> Loading environment from $FilePath" -ForegroundColor Cyan
        Get-Content $FilePath | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#") -and $line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
                $key = $Matches[1]
                $val = $Matches[2].Trim().Trim('"').Trim("'")
                if (-not [Environment]::GetEnvironmentVariable($key)) {
                    [Environment]::SetEnvironmentVariable($key, $val, "Process")
                }
            }
        }
    }
}

Import-DotEnv (Join-Path $RepoRoot ".env")
Import-DotEnv (Join-Path $RepoRoot "agent\evac_agent\.env")

# ------------------------------------------------------------------------------
# 2. Resolve flags & configuration
# ------------------------------------------------------------------------------
$DeployAgent = -not $DashboardOnly -and -not $TestOnly
$DeployDashboard = -not $AgentOnly -and -not $TestOnly
$RunTests = -not $SkipTest

$ProjectId = $env:GOOGLE_CLOUD_PROJECT
if (-not $ProjectId) {
    $ProjectId = (gcloud config get-value project 2>$null).Trim()
}
if (-not $ProjectId -or $ProjectId -eq "(unset)") {
    Write-Error "GOOGLE_CLOUD_PROJECT is not set in .env and no default gcloud project was found."
    exit 1
}

$Region = if ($env:CLOUD_RUN_REGION) { $env:CLOUD_RUN_REGION } else { "us-east1" }
$VertexLocation = if ($env:GOOGLE_CLOUD_LOCATION) { $env:GOOGLE_CLOUD_LOCATION } else { "global" }
$UseVertex = if ($env:GOOGLE_GENAI_USE_VERTEXAI) { $env:GOOGLE_GENAI_USE_VERTEXAI } else { "TRUE" }
$BqDataset = if ($env:BQ_DATASET) { $env:BQ_DATASET } else { "evacuation_readiness" }
$State = if ($env:STATE) { $env:STATE } else { "FL" }
$GeminiModel = if ($env:GEMINI_MODEL) { $env:GEMINI_MODEL } else { "gemini-3.6-flash" }

$AgentService = if ($env:AGENT_SERVICE_NAME) { $env:AGENT_SERVICE_NAME } else { "evac-readiness-agent" }
$DashboardService = if ($env:DASHBOARD_SERVICE_NAME) { $env:DASHBOARD_SERVICE_NAME } else { "evac-dashboard" }
$AgentApp = if ($env:DEPLOYED_AGENT_APP) { $env:DEPLOYED_AGENT_APP } else { "evac_agent" }
$SessionUri = $env:SESSION_SERVICE_URI

# Locate Python and ADK CLI
$PythonBin = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $PythonBin)) {
    if (Test-Path "C:\Python313\python.exe") {
        $PythonBin = "C:\Python313\python.exe"
    } else {
        $PythonBin = "python"
    }
}

$AdkBin = Join-Path $RepoRoot ".venv\Scripts\adk.exe"
$UsePythonModuleForAdk = $false
if (-not (Test-Path $AdkBin)) {
    if (Get-Command adk -ErrorAction SilentlyContinue) {
        $AdkBin = "adk"
    } else {
        $UsePythonModuleForAdk = $true
    }
}

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "Cloud Run Deployment Configuration" -ForegroundColor Cyan
Write-Host "  Project        : $ProjectId"
Write-Host "  Region         : $Region"
Write-Host "  Vertex Location: $VertexLocation"
Write-Host "  BQ Dataset     : $BqDataset (State: $State)"
Write-Host "  Agent Service  : $AgentService ($AgentApp)"
Write-Host "  Dashboard Svc  : $DashboardService"
Write-Host "==============================================================================" -ForegroundColor Cyan

# ------------------------------------------------------------------------------
# 3. Deploy Step 1: Ensure Derived BigQuery Tables & Deploy ADK Multi-Agent Service
# ------------------------------------------------------------------------------
if ($DeployAgent) {
    Write-Host "`n==> [0/3] Ensuring derived BigQuery tables exist in $ProjectId.$BqDataset..." -ForegroundColor Yellow
    & $PythonBin (Join-Path $RepoRoot "agent\sql\build_derived.py")

    Write-Host "`n==> [1/3] Deploying ADK Multi-Agent Service ($AgentService)..." -ForegroundColor Yellow
    Push-Location (Join-Path $RepoRoot "agent")
    try {
        $AdkArgs = @(
            "deploy", "cloud_run",
            "--project", $ProjectId,
            "--region", $Region,
            "--service_name", $AgentService,
            "--with_ui",
            "--env", "GOOGLE_GENAI_USE_VERTEXAI=$UseVertex",
            "--env", "GOOGLE_CLOUD_PROJECT=$ProjectId",
            "--env", "GOOGLE_CLOUD_LOCATION=$VertexLocation",
            "--env", "BQ_DATASET=$BqDataset",
            "--env", "STATE=$State",
            "--env", "GEMINI_MODEL=$GeminiModel",
            "--provider-args=--allow-unauthenticated",
            "--provider-args=--min-instances=1",
            "--provider-args=--memory=2Gi",
            "--provider-args=--timeout=600"
        )
        if ($SessionUri) {
            $AdkArgs += @("--session_service_uri", $SessionUri)
        }
        $AdkArgs += $AgentApp

        if ($UsePythonModuleForAdk) {
            $ModArgs = @("-m", "google.adk.cli") + $AdkArgs
            & $PythonBin @ModArgs
        } else {
            & $AdkBin @AdkArgs
        }
    } finally {
        Pop-Location
    }
}

$AgentUrl = $env:DEPLOYED_AGENT_URL
if (-not $AgentUrl -or $DeployAgent) {
    $AgentUrl = (gcloud run services describe $AgentService --project $ProjectId --region $Region --format="value(status.url)" 2>$null).Trim()
}
if ($AgentUrl) {
    Write-Host "==> ADK Agent URL: $AgentUrl" -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 4. Deploy Step 2: Unified Dashboard + FastAPI Service
# ------------------------------------------------------------------------------
if ($DeployDashboard) {
    if (-not $AgentUrl) {
        Write-Error "Could not resolve ADK Agent URL. Deploy the agent first or set DEPLOYED_AGENT_URL in .env."
        exit 1
    }

    Write-Host "`n==> [2/3] Deploying Unified Dashboard Service ($DashboardService)..." -ForegroundColor Yellow
    $EnvVars = "GOOGLE_CLOUD_PROJECT=$ProjectId,BQ_DATASET=$BqDataset,STATE=$State,DEPLOYED_AGENT_URL=$AgentUrl,DEPLOYED_AGENT_APP=$AgentApp"
    if ($env:MAPS_API_KEY) {
        $EnvVars = "$EnvVars,MAPS_API_KEY=$($env:MAPS_API_KEY)"
    }

    gcloud run deploy $DashboardService `
        --source $RepoRoot `
        --project $ProjectId `
        --region $Region `
        --allow-unauthenticated `
        --min-instances 1 `
        --memory 1Gi `
        --timeout 600 `
        --set-env-vars $EnvVars
}

$DashboardUrl = (gcloud run services describe $DashboardService --project $ProjectId --region $Region --format="value(status.url)" 2>$null).Trim()

# ------------------------------------------------------------------------------
# 5. Step 3: Post-Deployment Smoke Test
# ------------------------------------------------------------------------------
if ($RunTests) {
    Write-Host "`n==> [3/3] Running post-deployment smoke tests..." -ForegroundColor Yellow
    if ($DashboardUrl) {
        Write-Host "  -> Checking $DashboardUrl/health ..."
        $health = Invoke-RestMethod -Method Get -Uri "$DashboardUrl/health"
        Write-Host "     Health check: OK ($($health.status), project=$($health.project))" -ForegroundColor Green

        Write-Host "  -> Testing $DashboardUrl/api/chat (verifying Pydantic recommended_actions)..."
        $body = @{
            message = "Which census tracts in Lee County should we prioritize?"
            county  = "Lee"
        } | ConvertTo-Json

        $chatResp = Invoke-RestMethod -Method Post -Uri "$DashboardUrl/api/chat" -ContentType "application/json" -Body $body
        if ($null -ne $chatResp.recommended_actions) {
            Write-Host "     Chat API + recommended_actions schema verification: PASSED ($($chatResp.recommended_actions.Count) actions returned)" -ForegroundColor Green
        } else {
            Write-Warning "/api/chat responded, but 'recommended_actions' field was missing."
        }
    } else {
        Write-Host "  -> Dashboard URL not found; skipping dashboard HTTP check." -ForegroundColor Gray
    }
}

Write-Host "`n==============================================================================" -ForegroundColor Cyan
Write-Host "Deployment & Verification Complete!" -ForegroundColor Green
if ($AgentUrl)     { Write-Host "  ADK Dev UI   : $AgentUrl/dev-ui/" }
if ($DashboardUrl) { Write-Host "  Dashboard UI : $DashboardUrl" }
Write-Host "==============================================================================" -ForegroundColor Cyan
