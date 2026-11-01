[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)][int]$Port = 9335,
  [string]$TaskName = 'Codex Usage Monitor Runtime Supervisor',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'monitor-utils.ps1')

$startupDirectory = [Environment]::GetFolderPath('Startup')
$startupShortcut = Join-Path $startupDirectory 'Codex Usage Monitor Runtime Supervisor.lnk'
$hiddenLauncher = Join-Path $PSScriptRoot 'launch-runtime-supervisor-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if ($Remove) {
  Stop-CodexUsageRuntimeSupervisorProcesses
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue
  Write-Host '已移除 Codex Usage Monitor 运行时协调器登录入口。'
  return
}

$powerShellCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if (-not $powerShellCommand) { $powerShellCommand = Get-Command powershell.exe -ErrorAction Stop }
$supervisorScript = Join-Path $PSScriptRoot 'runtime-supervisor.ps1'
if (-not (Test-Path -LiteralPath $supervisorScript -PathType Leaf)) { throw "运行时协调器不存在：$supervisorScript" }
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) { throw "隐藏启动器不存在：$hiddenLauncher" }
if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) { throw "Windows Script Host 不存在：$wscript" }
$controlPath = Join-Path $CodexUsageStateRoot 'runtime-control.json'
if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) {
  [void](Set-CodexUsageRuntimeControl -Enabled $true -Reason 'install')
}

$taskInstalled = $false
if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
  try {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments = '"{0}" "{1}" {2}' -f $hiddenLauncher, $powerShellCommand.Source, $Port
    $action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keeps Codex launch-enforced for the Codex Usage Monitor.' -Force | Out-Null
    $taskInstalled = $true
  } catch {
    Write-Warning "无法注册计划任务，将使用当前用户启动目录：$($_.Exception.Message)"
  }
}

if ($taskInstalled) {
  Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue
  Write-Host "已注册运行时协调器登录任务：$TaskName"
} else {
  if (-not (Test-Path -LiteralPath $startupDirectory -PathType Container)) { throw "启动目录不存在：$startupDirectory" }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($startupShortcut)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = '"' + $hiddenLauncher + '" "' + $powerShellCommand.Source + '" ' + $Port
  $shortcut.WorkingDirectory = $PSScriptRoot
  $shortcut.Description = 'Starts the Codex Usage Monitor runtime supervisor.'
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  Write-Host "已注册运行时协调器启动目录入口：$startupShortcut"
}

# Updating a login task does not update its already-running PowerShell child.
# Refresh only an active supervisor; installation must not start Codex itself.
if ((Get-CodexUsageRuntimeControl).enabled -and @(Get-CodexUsageRuntimeSupervisorProcesses).Count -gt 0) {
  $supervisor = Start-CodexUsageRuntimeSupervisor -Port $Port -Replace
  Write-Host "已切换正在运行的协调器到 $CodexUsageVersion（PID $($supervisor.ProcessId)）。"
}
