# PowerShell deployment script for doto-tracker.
# Pulls the latest code on your server, rebuilds and restarts the systemd service.
#
# Put these in .env (or set them in your shell), then run `npm run remote-deploy`:
#   DOTO_DEPLOY_HOST=ubuntu@203.0.113.10
#   DOTO_DEPLOY_KEY=C:\path\to\my-server.key   # optional, defaults to your ssh config

$EnvFile = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match '^\s*(DOTO_DEPLOY_[A-Z]+)\s*=\s*(.+?)\s*$' -and -not [Environment]::GetEnvironmentVariable($Matches[1])) {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'))
        }
    }
}

$Server = $env:DOTO_DEPLOY_HOST
if (-not $Server) {
    Write-Host "Set DOTO_DEPLOY_HOST (for example ubuntu@203.0.113.10) first." -ForegroundColor Red
    exit 1
}
$Branch = if ($env:DOTO_DEPLOY_BRANCH) { $env:DOTO_DEPLOY_BRANCH } else { "ts_cope" }
$RemoteCommand = "source ~/.nvm/nvm.sh && cd ~/doto-tracker && git pull origin $Branch && npx tsc && sudo systemctl restart doto-tracker"

Write-Host "Deploying $Branch to $Server..." -ForegroundColor Cyan

if ($env:DOTO_DEPLOY_KEY) {
    ssh -i $env:DOTO_DEPLOY_KEY $Server $RemoteCommand
} else {
    ssh $Server $RemoteCommand
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "Deployment successful." -ForegroundColor Green
} else {
    Write-Host "Deployment failed." -ForegroundColor Red
}
