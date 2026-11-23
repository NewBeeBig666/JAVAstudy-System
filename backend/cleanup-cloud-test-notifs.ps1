# 云端测试通知清理：删除本轮云端验证产生的测试通知（不含任何密钥，密码交互输入）
# 背景：v1.24.0 云端验证在 student 账号产生了 2 条引用已删测试项目的打回通知，保持测试数据零残留
# 用法：在 backend 目录下执行  powershell -ExecutionPolicy Bypass -File .\cleanup-cloud-test-notifs.ps1
$ErrorActionPreference = 'Stop'

$pw = Read-Host -AsSecureString '请输入 47.119.150.2 的 Administrator 密码'
$cred = New-Object System.Management.Automation.PSCredential('Administrator', $pw)

Write-Host '正在建立 WinRM 会话…' -ForegroundColor Cyan
$s = New-PSSession -ComputerName 47.119.150.2 -Credential $cred

try {
  $result = Invoke-Command $s {
    $ErrorActionPreference = 'Continue'
    # ① 数据库凭证：优先系统/服务环境变量（与生产数据源同源）
    $dbUser = [Environment]::GetEnvironmentVariable('DB_USER', 'Machine')
    $dbPwd  = [Environment]::GetEnvironmentVariable('DB_PASSWORD', 'Machine')
    if (-not $dbUser -or -not $dbPwd) {
      # 回退：从 WinSW 服务 XML 的 env 节点解析
      $svcXml = Get-ChildItem 'C:\app\learning-agent\*.xml' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($svcXml) {
        [xml]$x = Get-Content $svcXml.FullName -Raw
        $envs = @($x.service.env)
        foreach ($e in $envs) {
          if ($e.name -eq 'DB_USER') { $dbUser = $e.value }
          if ($e.name -eq 'DB_PASSWORD') { $dbPwd = $e.value }
        }
      }
    }
    if (-not $dbUser -or -not $dbPwd) { return 'FAIL: 未找到数据库凭证（DB_USER/DB_PASSWORD）' }

    # ② 定位 mysql.exe：从 mysqld 服务 PathName 反查 bin 目录（云端为非标准路径）
    $mysql = $null
    $svc = Get-CimInstance Win32_Service -Filter "Name='MySQL'" -ErrorAction SilentlyContinue
    if (-not $svc) { $svc = Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'mysqld' } | Select-Object -First 1 }
    if ($svc -and $svc.PathName) {
      $bin = Split-Path ($svc.PathName -replace '^"?', '' -replace '".*$', '') -Parent
      $cand = Join-Path $bin 'mysql.exe'
      if (Test-Path $cand) { $mysql = $cand }
    }
    if (-not $mysql) {
      foreach ($p in @('C:\mysql\bin\mysql.exe', 'C:\Program Files\MySQL\MySQL Server 5.7\bin\mysql.exe', 'C:\app\mysql\bin\mysql.exe')) {
        if (Test-Path $p) { $mysql = $p; break }
      }
    }
    if (-not $mysql) { return 'FAIL: 未定位 mysql.exe' }

    # ③ 执行清理（密码经 MYSQL_PWD 环境变量传递，避免命令行告警中断远程调用）
    $env:MYSQL_PWD = $dbPwd
    $sql = "DELETE FROM notification WHERE content LIKE '%云端验证v124%' OR content LIKE '%云端诊断v124%'; SELECT ROW_COUNT() AS deleted;"
    $out = & $mysql "-u$dbUser" learning_agent -e $sql 2>$null
    $env:MYSQL_PWD = $null
    if ($LASTEXITCODE -ne 0) { return "FAIL: mysql exit=$LASTEXITCODE" }
    return 'OK: ' + ($out -join ' ')
  }
  Write-Host "清理结果：$result" -ForegroundColor $(if ($result -like 'OK*') { 'Green' } else { 'Yellow' })
} finally {
  if ($s) { Remove-PSSession $s }
}
