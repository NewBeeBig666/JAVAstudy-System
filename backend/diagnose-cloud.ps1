# 云端诊断：检查 learning-agent 服务状态、Java 进程、8080 监听与应用日志
# 用法：在 backend 目录下执行  powershell -ExecutionPolicy Bypass -File .\diagnose-cloud.ps1
$ErrorActionPreference = 'Continue'

$pw = Read-Host -AsSecureString '请输入 47.119.150.2 的 Administrator 密码'
$cred = New-Object System.Management.Automation.PSCredential('Administrator', $pw)

Write-Host '正在建立 WinRM 会话…' -ForegroundColor Cyan
$s = New-PSSession -ComputerName 47.119.150.2 -Credential $cred

try {
  Write-Host "`n===== 1. 服务状态 =====" -ForegroundColor Yellow
  Invoke-Command $s { Get-Service learning-agent | Format-List Name, Status, StartType }

  Write-Host '===== 2. Java 进程 =====' -ForegroundColor Yellow
  Invoke-Command $s { Get-Process java -ErrorAction SilentlyContinue | Format-Table Id, StartTime, CPU, WorkingSet -AutoSize }

  Write-Host '===== 3. 8080 端口监听 =====' -ForegroundColor Yellow
  Invoke-Command $s { netstat -ano | Select-String ':8080' }

  Write-Host '===== 4. 服务器本机健康检查 =====' -ForegroundColor Yellow
  Invoke-Command $s { try { (Invoke-WebRequest -Uri 'http://localhost:8080/actuator/health' -UseBasicParsing -TimeoutSec 5).Content } catch { '本机 8080 访问失败: ' + $_.Exception.Message } }

  Write-Host '===== 5. 部署目录文件 =====' -ForegroundColor Yellow
  Invoke-Command $s { Get-ChildItem 'C:\app\learning-agent' | Format-Table Name, Length, LastWriteTime -AutoSize }

  Write-Host '===== 6. 应用日志（最后 60 行）=====' -ForegroundColor Yellow
  Invoke-Command $s {
    $logs = Get-ChildItem 'C:\app\learning-agent' -Filter '*.log' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    if ($logs) {
      $latest = $logs[0]
      Write-Host ('日志文件: ' + $latest.FullName)
      Get-Content $latest.FullName -Tail 60
    } else {
      Write-Host '目录下无 .log 文件，检查 wrapper 日志目录…'
      Get-ChildItem 'C:\app\learning-agent' -Recurse -Filter '*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object {
          Write-Host ('日志文件: ' + $_.FullName)
          Get-Content $_.FullName -Tail 60
        }
    }
  }
} finally {
  if ($s) { Remove-PSSession $s }
}
Write-Host "`n诊断完成，请将以上输出发给助手。" -ForegroundColor Green
