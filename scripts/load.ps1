# A4I 2026 - Challenge 4: Adaptive Evacuation Readiness & Vulnerable Community Planning
# Windows PowerShell equivalent of scripts/load.sh
#
# Usage (from repository root in PowerShell):
#   .\scripts\load.ps1 FL
#   .\scripts\load.ps1 TX

param(
    [string]$State = "FL"
)

$ErrorActionPreference = "Stop"

$Bucket = "gs://class-demo/a4i-2026/challenge-4-evacuation"
$Dataset = "evacuation_readiness"
$Location = "US"
$Tables = @(
    "shelters",
    "vulnerability_tracts",
    "hazard_tracts",
    "care_facilities",
    "power_dependent_counties"
)

$State = $State.Trim().ToUpper()
$Src = "$Bucket/$State"

$ProjectId = (gcloud config get-value project 2>$null).Trim()
if (-not $ProjectId -or $ProjectId -eq "(unset)") {
    Write-Error "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
    exit 1
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "A4I Challenge 4 - Loading BigQuery data for state: $State" -ForegroundColor Cyan
Write-Host "  Project : $ProjectId"
Write-Host "  Source  : $Src"
Write-Host "  Dataset : $Dataset ($Location)"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "1/3  Creating dataset '$Dataset' (if not exists)..." -ForegroundColor Yellow
try {
    bq --project_id="$ProjectId" --location="$Location" mk --dataset "${ProjectId}:${Dataset}" 2>&1 | Out-Null
    Write-Host "  Created dataset ${ProjectId}:${Dataset}" -ForegroundColor Green
} catch {
    Write-Host "  Dataset ${ProjectId}:${Dataset} already exists (or checked) - continuing..." -ForegroundColor Gray
}

Write-Host ""
Write-Host "2/3  Loading 5 tables from Cloud Storage Parquet snapshots..." -ForegroundColor Yellow
foreach ($table in $Tables) {
    $uri = "$Src/$table/*.parquet"
    Write-Host "  Loading $table from $uri ..."
    bq --project_id="$ProjectId" --location="$Location" load `
        --source_format=PARQUET `
        --replace `
        "${Dataset}.${table}" `
        "$uri"
}

Write-Host ""
Write-Host "3/3  Verifying loaded tables in ${ProjectId}:${Dataset}..." -ForegroundColor Yellow
bq --project_id="$ProjectId" ls "${ProjectId}:${Dataset}"

Write-Host ""
Write-Host "Done! All tables loaded into ${ProjectId}.${Dataset}." -ForegroundColor Green
