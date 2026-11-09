# Server-side health check for Aliyun production server (47.119.150.2)
# Read-only: no configuration changes, no DB writes. Password via Read-Host (not logged).
$ErrorActionPreference = 'Continue'
$pw = Read-Host -AsSecureString 'Enter Administrator password for 47.119.150.2'
$cred = New-Object System.Management.Automation.PSCredential('Administrator', $pw)
Write-Host 'Connecting WinRM...'
$s = New-PSSession -ComputerName 47.119.150.2 -Credential $cred
if (-not $s) { throw 'WinRM session failed' }

$script = {
$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]

# ---------- [SVC] Service & process ----------
$svc = Get-Service learning-agent -ErrorAction SilentlyContinue
$out.Add('##SVC status=' + [string]($svc.Status))
$out.Add('##SVC startType=' + [string]($svc.StartType))
$javas = Get-Process java -ErrorAction SilentlyContinue
foreach ($pj in $javas) {
  try {
    $pj.Refresh()
    $out.Add('##PROC pid=' + $pj.Id + ' memMB=' + [Math]::Round($pj.WorkingSet64/1MB,1) + ' cpuSec=' + [Math]::Round($pj.TotalProcessorTime.TotalSeconds,0) + ' threads=' + $pj.Threads.Count + ' handles=' + $pj.HandleCount + ' start=' + $pj.StartTime)
  } catch { $out.Add('##PROC pid=' + $pj.Id + ' detailError') }
}
$svcProc = Get-CimInstance Win32_Service -Filter "Name='learning-agent'" -ErrorAction SilentlyContinue
if ($svcProc) { $out.Add('##SVC procId=' + $svcProc.ProcessId + ' exitCode=' + $svcProc.ExitCode) }

# ---------- [SYS] System resources ----------
$cpu = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average
$out.Add('##SYS cpuLoad=' + [Math]::Round($cpu.Average,1) + '%')
$os = Get-CimInstance Win32_OperatingSystem
$out.Add('##SYS memTotalGB=' + [Math]::Round($os.TotalVisibleMemorySize/1MB,1) + ' memFreeGB=' + [Math]::Round($os.FreePhysicalMemory/1MB,1) + ' usedPct=' + [Math]::Round((1 - $os.FreePhysicalMemory/$os.TotalVisibleMemorySize)*100,1) + '%')
$out.Add('##SYS uptimeHours=' + [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1))
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  $out.Add('##SYS disk ' + $_.DeviceID + ' sizeGB=' + [Math]::Round($_.Size/1GB,1) + ' freeGB=' + [Math]::Round($_.FreeSpace/1GB,1) + ' freePct=' + [Math]::Round($_.FreeSpace/$_.Size*100,1) + '%')
}
$net = (Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 80 }).Count
$out.Add('##SYS establishedConnsPort80=' + $net)

# ---------- [LOG] App directory & logs ----------
$app = 'C:\app\learning-agent'
Get-ChildItem $app -ErrorAction SilentlyContinue | ForEach-Object {
  $out.Add('##DIR name=' + $_.Name + ' sizeKB=' + [Math]::Round($_.Length/1KB,1) + ' modified=' + $_.LastWriteTime)
}
$logs = Get-ChildItem $app -Filter *.log -ErrorAction SilentlyContinue
foreach ($lg in $logs) {
  $out.Add('##LOG file=' + $lg.Name + ' sizeMB=' + [Math]::Round($lg.Length/1MB,2) + ' modified=' + $lg.LastWriteTime)
  $tail = Get-Content $lg.FullName -Tail 4000 -ErrorAction SilentlyContinue
  $errLines = @($tail | Select-String -Pattern 'ERROR|Exception' -CaseSensitive:$false)
  $out.Add('##LOG errCountInTail4000=' + $errLines.Count)
  $errLines | Select-Object -Last 6 | ForEach-Object { $out.Add('##LOGERR ' + $_.Line.Substring(0, [Math]::Min(320, $_.Line.Length))) }
}
$up = Join-Path $app 'uploads'
if (Test-Path $up) {
  $files = @(Get-ChildItem $up -Recurse -File -ErrorAction SilentlyContinue)
  $sz = ($files | Measure-Object -Property Length -Sum).Sum
  $out.Add('##UPLOADS files=' + $files.Count + ' sizeMB=' + [Math]::Round($sz/1MB,2))
} else { $out.Add('##UPLOADS missing') }

$winswFiles = Get-ChildItem $app -Filter *.xml -ErrorAction SilentlyContinue
foreach ($x in $winswFiles) {
  $out.Add('##WINSW file=' + $x.Name)
  (Get-Content $x.FullName -ErrorAction SilentlyContinue) | Select-String -Pattern 'onfailure|restart|stoptimeout|env name|log' | ForEach-Object { $out.Add('##WINSW ' + $_.Line.Trim()) }
}

# ---------- [DB] MySQL (locate exe, creds from XML env or system env) ----------
$mysql = 'C:\app\mysql\bin\mysql.exe'
if (-not (Test-Path $mysql)) {
  $mysvc = Get-CimInstance Win32_Service -Filter "Name like '%mysql%'" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($mysvc -and $mysvc.PathName -match '([^"\s]+)mysqld\.exe') { $mysql = ($Matches[1] + 'mysql.exe') }
}
$out.Add('##DB exe=' + $mysql + ' exists=' + (Test-Path $mysql))
$dbu = $env:DB_USER; $dbp = $env:DB_PASSWORD
if (-not $dbu) {
  foreach ($x in $winswFiles) {
    $c = Get-Content $x.FullName -Raw -ErrorAction SilentlyContinue
    if ($c -match 'name="DB_USER"\s+value="([^"]+)"') { $dbu = $Matches[1] }
    if ($c -match 'name="DB_PASSWORD"\s+value="([^"]+)"') { $dbp = $Matches[1] }
  }
}
if (-not $dbu) { $dbu = 'root' }
$env:MYSQL_PWD = $dbp
function Q($q) { & $mysql "-u$dbu" learning_agent "-N" "-B" "-e" $q 2>$null }
$ver = Q "SELECT VERSION()"
$out.Add('##DB version=' + ($ver -join ' '))
$out.Add('##DB schemaVersions=' + ((Q "SELECT GROUP_CONCAT(version ORDER BY version) FROM schema_version") -join ' '))
$out.Add('##DB ' + ((Q "SHOW GLOBAL STATUS LIKE 'Threads_connected'") -join ' ').Trim())
$out.Add('##DB ' + ((Q "SHOW GLOBAL STATUS LIKE 'Aborted_clients'") -join ' ').Trim())
$out.Add('##DB ' + ((Q "SHOW GLOBAL STATUS LIKE 'Slow_queries'") -join ' ').Trim())
foreach ($t in @('user','class','assignment','submission','warning','learning_resource','class_co_teacher','assignment_folder','question','exercise_record','notification','session_entity','message')) {
  $out.Add('##TBL ' + $t + '=' + (((Q "SELECT COUNT(*) FROM $t") -join '')).Trim())
}
# ---------- [CONSISTENCY] orphan / integrity checks (read-only) ----------
$checks = [ordered]@{
  assignmentFolderMissing = "SELECT COUNT(*) FROM assignment a LEFT JOIN assignment_folder f ON f.id=a.folder_id WHERE a.folder_id IS NOT NULL AND f.id IS NULL"
  folderClassMissing     = "SELECT COUNT(*) FROM assignment_folder f LEFT JOIN class c ON c.id=f.class_id WHERE f.class_id IS NOT NULL AND c.id IS NULL"
  coTeacherClassMissing  = "SELECT COUNT(*) FROM class_co_teacher ct LEFT JOIN class c ON c.id=ct.class_id WHERE c.id IS NULL"
  coTeacherUserMissing   = "SELECT COUNT(*) FROM class_co_teacher ct LEFT JOIN user u ON u.id=ct.teacher_id WHERE u.id IS NULL"
  userClassMissing       = "SELECT COUNT(*) FROM user u LEFT JOIN class c ON c.id=u.class_id WHERE u.class_id IS NOT NULL AND c.id IS NULL"
  subAssignMissing       = "SELECT COUNT(*) FROM submission s LEFT JOIN assignment a ON a.id=s.assignment_id WHERE a.id IS NULL"
  subStudentMissing      = "SELECT COUNT(*) FROM submission s LEFT JOIN user u ON u.id=s.student_id WHERE u.id IS NULL"
  warnClassMissing       = "SELECT COUNT(*) FROM warning w LEFT JOIN class c ON c.id=w.class_id WHERE c.id IS NULL"
  warnStudentMissing     = "SELECT COUNT(*) FROM warning w LEFT JOIN user u ON u.id=w.student_id WHERE w.student_id IS NOT NULL AND u.id IS NULL"
  resClassMissing        = "SELECT COUNT(*) FROM learning_resource r LEFT JOIN class c ON c.id=r.class_id WHERE c.id IS NULL"
  questionAssignMissing  = "SELECT COUNT(*) FROM question q LEFT JOIN assignment a ON a.id=q.assignment_id WHERE a.id IS NULL"
  rubricAssignMissing    = "SELECT COUNT(*) FROM rubric r LEFT JOIN assignment a ON a.id=r.assignment_id WHERE a.id IS NULL"
  folderDupName          = "SELECT COUNT(*) FROM (SELECT teacher_id,class_id,name,COUNT(*) c FROM assignment_folder GROUP BY teacher_id,class_id,name HAVING c>1) t"
  coTeacherDup           = "SELECT COUNT(*) FROM (SELECT class_id,teacher_id,COUNT(*) c FROM class_co_teacher GROUP BY class_id,teacher_id HAVING c>1) t"
}
foreach ($k in $checks.Keys) {
  $out.Add('##ORPHAN ' + $k + '=' + (((Q $checks[$k]) -join '')).Trim())
}
$resFiles = @(Get-ChildItem (Join-Path $app 'uploads\resource') -File -ErrorAction SilentlyContinue).Count
$dbRes = (((Q "SELECT COUNT(*) FROM learning_resource") -join '')).Trim()
$out.Add('##CONS resFilesOnDisk=' + $resFiles + ' resRowsInDB=' + $dbRes)
$env:MYSQL_PWD = $null
$out
}

Write-Host 'Running remote checks...'
$result = Invoke-Command $s -ScriptBlock $script
Remove-PSSession $s
$result | ForEach-Object { Write-Output $_ }
$resultFile = Join-Path $PSScriptRoot 'server-check-result.txt'
$result | Set-Content -Path $resultFile -Encoding UTF8
Write-Host ('Result saved to: ' + $resultFile)
Write-Host 'Done.'
