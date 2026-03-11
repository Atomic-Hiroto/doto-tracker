# PowerShell Deployment Script for Doto-Tracker
# Run this locally on Windows to update the remote bot.

$KeyPath = "C:\Users\user\arm-key.key"
$Server = "ubuntu@80.225.227.0"
$RemoteCommand = "source ~/.nvm/nvm.sh && cd ~/doto-tracker && git pull origin ts_cope && npx tsc && sudo systemctl restart doto-tracker"

Write-Host "≡ƒöì Deploying updates to $Server..." -ForegroundColor Cyan

ssh -i $KeyPath $Server $RemoteCommand

if ($LASTEXITCODE -eq 0) {
    Write-Host "Γ£à Deployment successful!" -ForegroundColor Green
} else {
    Write-Host "Γ¥î Deployment failed!" -ForegroundColor Red
}
