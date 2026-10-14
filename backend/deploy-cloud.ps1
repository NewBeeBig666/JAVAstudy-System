# 临时部署脚本：将本地最新 jar 发布到阿里云服务器（47.119.150.2）
# 密码通过 Read-Host 交互输入，不落盘、不进命令历史、不写入任何文件。
# 用法：在 backend 目录下执行  powershell -ExecutionPolicy Bypass -File .\deploy-cloud.ps1
$ErrorActionPreference = 'Stop'

$jar = Join-Path $PSScriptRoot 'target\learning-agent-backend-0.1.0-SNAPSHOT.jar'
if (-not (Test-Path $jar)) { throw "未找到本地 jar：$jar，请先执行 mvnw clean package" }

$pw = Read-Host -AsSecureString '请输入 47.119.150.2 的 Administrator 密码'
$cred = New-Object System.Management.Automation.PSCredential('Administrator', $pw)

Write-Host '正在建立 WinRM 会话…' -ForegroundColor Cyan
$s = New-PSSession -ComputerName 47.119.150.2 -Credential $cred

try {
  Write-Host '停止服务 learning-agent…' -ForegroundColor Cyan
  Invoke-Command $s { Stop-Service learning-agent -ErrorAction Stop }

  Write-Host '备份旧 jar 为 learning-agent.jar.bak…' -ForegroundColor Cyan
  Invoke-Command $s { Copy-Item 'C:\app\learning-agent\learning-agent.jar' 'C:\app\learning-agent\learning-agent.jar.bak' -Force }

  Write-Host '上传新 jar…' -ForegroundColor Cyan
  Copy-Item $jar -Destination 'C:\app\learning-agent\learning-agent.jar' -ToSession $s -Force

  Write-Host '启动服务 learning-agent…' -ForegroundColor Cyan
  Invoke-Command $s { Start-Service learning-agent -ErrorAction Stop }
  Start-Sleep -Seconds 5
  $status = Invoke-Command $s { [string](Get-Service learning-agent).Status }
  Write-Host "服务状态：$status" -ForegroundColor Green
  if ($status -ne 'Running') { throw '服务未能进入 Running 状态，请检查服务器日志' }
  Write-Host '部署完成。' -ForegroundColor Green
} finally {
  if ($s) { Remove-PSSession $s }
}
