[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9335,
  [switch]$DisableRuntime,
  [switch]$CloseCodex,
  [switch]$ReportProgress,
  [string]$Reason = 'command'
)

$ErrorActionPreference = 'Stop'
$shutdownLogPath = Join-Path $env:LOCALAPPDATA 'CodexUsageMonitor\shutdown.log'

function Write-CodexUsageShutdownLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $shutdownLogPath) | Out-Null
    [IO.File]::AppendAllText($shutdownLogPath, "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message`r`n", [Text.UTF8Encoding]::new($false))
  } catch {}
}

try {
  Write-CodexUsageShutdownLog "退出脚本启动，PID $PID，原因 $Reason。"
  . (Join-Path $PSScriptRoot 'monitor-utils.ps1')
  if (-not $CloseCodex) {
    $state = Get-CodexUsageState
    if ($state -and $state.PSObject.Properties['port']) { $Port = [int]$state.port }
  }
  if ($DisableRuntime) { [void](Set-CodexUsageRuntimeControl -Enabled $false -Reason $Reason) }
  $rootIds = @()
  if ($CloseCodex) {
    $rootIds = @(Get-CodexUsageMainCodexProcesses | ForEach-Object { $_.ProcessId } | Where-Object { $_ -gt 0 } | Select-Object -Unique)
  }
  if ($ReportProgress) {
    [Console]::Out.WriteLine('{"event":"shutdown-started"}')
    [Console]::Out.Flush()
  }
  Stop-CodexUsageRuntimeSupervisorProcesses -GracefulTimeoutSeconds 2
  Write-CodexUsageShutdownLog '启动协调器已停止。'

  if ($CloseCodex) {
    foreach ($processId in $rootIds) {
      try {
        $process = Get-Process -Id $processId -ErrorAction Stop
        [void]$process.CloseMainWindow()
      } catch {}
    }
    if ($rootIds.Count -gt 0) {
      $deadline = (Get-Date).AddSeconds(6)
      do {
        $remaining = @($rootIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if (-not $remaining.Count) { break }
        if ((Get-Date) -ge $deadline) {
          Stop-CodexUsageCodexProcessGeneration -RootProcessIds $remaining
          break
        }
        Start-Sleep -Milliseconds 250
      } while ($true)
      if (@($rootIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count) {
        throw 'Codex 进程未能关闭，请重试。'
      }
    }
    Write-CodexUsageShutdownLog "Codex 已关闭，主进程：$($rootIds -join ',')。"
  } elseif (Test-CodexUsageCdpPort $Port) {
    $node = Resolve-CodexUsageNodePath
    $injector = Join-Path $PSScriptRoot 'injector.mjs'
    $arguments = '"{0}" --remove --port {1} --timeout-ms 5000' -f $injector, $Port
    [void](Invoke-CodexUsageProcessWithTimeout -FilePath $node -ArgumentLine $arguments -TimeoutMs 10000)
  }

  # Keep the requesting backend alive until Codex has closed, so early errors
  # can be returned to the settings page. Closing Codex needs no DOM removal.
  Remove-Item -LiteralPath $CodexUsageStatePath -Force -ErrorAction SilentlyContinue
  Write-CodexUsageShutdownLog '开始结束监视器后台。'
  foreach ($process in @(Get-CodexUsageInjectorProcesses)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Write-CodexUsageShutdownLog '监视器退出完成。'
} catch {
  Write-CodexUsageShutdownLog "退出失败：$($_.Exception.Message)"
  throw
}

if ($CloseCodex) {
  Write-Host '监控进程已停用，Codex 已关闭。重新运行 Codex Usage Monitor 快捷方式可再次启用。'
} elseif ($DisableRuntime) {
  Write-Host '监控进程已停用；ChatGPT 保持运行。重新运行 Codex Usage Monitor 快捷方式可再次启用。'
} else {
  Write-Host 'Codex 用量监视器已停止并从当前 renderer 移除。'
}
