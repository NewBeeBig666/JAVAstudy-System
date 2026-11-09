# Deploys the latest jar AND overrides the JWT secret on the cloud server.
# The strong secret is read at runtime from the local (gitignored) application-secret.yml
# and never appears in this file. Password via Read-Host (not logged).
$ErrorActionPreference = 'Stop'
$jar = Join-Path $PSScriptRoot 'target\learning-agent-backend-0.1.0-SNAPSHOT.jar'
if (-not (Test-Path $jar)) { throw 'Local jar not found. Run: mvnw clean package first.' }
$secretFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'application-secret.yml'
if (-not (Test-Path $secretFile)) { throw 'Local application-secret.yml not found.' }
$m = Select-String -Path $secretFile -Pattern '^\s*secret:\s*(\S.*)\s*$' | Select-Object -First 1
if (-not $m) { throw 'jwt.secret not found in local application-secret.yml.' }
$jwtSecret = $m.Matches[0].Groups[1].Value.Trim()
if ($jwtSecret.Length -lt 32) { throw 'JWT secret too short (' + $jwtSecret.Length + ' chars), aborting.' }

$pw = Read-Host -AsSecureString 'Enter Administrator password for 47.119.150.2'
$cred = New-Object System.Management.Automation.PSCredential('Administrator', $pw)
Write-Host 'Connecting WinRM...'
$s = New-PSSession -ComputerName 47.119.150.2 -Credential $cred

try {
  Write-Host 'Stopping service learning-agent...' -ForegroundColor Cyan
  Invoke-Command $s { Stop-Service learning-agent -ErrorAction Stop }

  Write-Host 'Backing up old jar...' -ForegroundColor Cyan
  Invoke-Command $s { Copy-Item 'C:\app\learning-agent\learning-agent.jar' 'C:\app\learning-agent\learning-agent.jar.bak' -Force }

  Write-Host 'Uploading new jar...' -ForegroundColor Cyan
  Copy-Item $jar -Destination 'C:\app\learning-agent\learning-agent.jar' -ToSession $s -Force

  Write-Host 'Overriding jwt.secret in server application-secret.yml...' -ForegroundColor Cyan
  $r = Invoke-Command $s -ArgumentList $jwtSecret {
    param($secret)
    $f = 'C:\app\learning-agent\application-secret.yml'
    $raw = ''
    if (Test-Path $f) { $raw = [IO.File]::ReadAllText($f) }
    # drop any existing top-level jwt block (jwt: + its indented lines), then append fresh one
    $raw = $raw -replace '(?m)^jwt:\r?\n((^[ \t]+\S.*\r?\n?)*)', ''
    $raw = $raw.TrimEnd() + "`r`njwt:`r`n  secret: $secret`r`n  expire-hours: 12`r`n"
    [IO.File]::WriteAllText($f, $raw, (New-Object System.Text.UTF8Encoding($true)))
    return 'ok'
  }
  Write-Host ('secret yml update: ' + $r)

  Write-Host 'Starting service learning-agent...' -ForegroundColor Cyan
  Invoke-Command $s { Start-Service learning-agent -ErrorAction Stop }
  Start-Sleep -Seconds 8
  $status = Invoke-Command $s { [string](Get-Service learning-agent).Status }
  Write-Host ('Service status: ' + $status) -ForegroundColor Green
  if ($status -ne 'Running') { throw 'Service failed to reach Running state; check server logs' }
  Write-Host 'Deploy complete.' -ForegroundColor Green
} finally {
  if ($s) { Remove-PSSession $s }
}
