[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)][int]$Port = 9335,
  [ValidateRange(500, 10000)][int]$PollMilliseconds = 2000,
  [ValidateRange(0, 30000)][int]$NativeGraceMilliseconds = 1500,
  [ValidateRange(10, 300)][int]$CdpStartupTimeoutSeconds = 180,
  [ValidateRange(1, 30)][int]$CloseTimeoutSeconds = 8,
  [ValidateRange(1, 10)][int]$MaxHandoffsPerWindow = 2,
  [ValidateRange(60, 3600)][int]$HandoffWindowSeconds = 300,
  [ValidateRange(5, 300)][int]$MonitorRetrySeconds = 20
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'monitor-utils.ps1')

$statePath = Join-Path $CodexUsageStateRoot 'runtime-supervisor.json'
$logPath = Join-Path $CodexUsageStateRoot 'runtime-supervisor.log'
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
$mutex = [Threading.Mutex]::new($false, 'Local\CodexUsageRuntimeSupervisor')
$mutexAcquired = $false

function Write-CodexUsageSupervisorLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $CodexUsageStateRoot | Out-Null
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    [IO.File]::AppendAllText($logPath, "[$stamp] $Message`r`n", $CodexUsageUtf8)
  } catch {}
}

function Write-CodexUsageSupervisorState($State) {
  try {
    New-Item -ItemType Directory -Force -Path $CodexUsageStateRoot | Out-Null
    $temporary = "$statePath.$PID.tmp"
    $value = [ordered]@{
      schemaVersion = 1
      supervisorPid = $PID
      supervisorPath = $scriptPath
      runtimeVersion = $CodexUsageVersion
      updatedAt = (Get-Date).ToString('o')
    }
    foreach ($property in $State.Keys) { $value[$property] = $State[$property] }
    try {
      [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 8), $CodexUsageUtf8)
      Move-Item -LiteralPath $temporary -Destination $statePath -Force
    } finally {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Test-CodexUsageMainProcessIdentity($Candidate) {
  if (-not $Candidate -or $Candidate.ProcessId -le 0 -or -not $Candidate.CreationDate) { return $false }
  try {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Candidate.ProcessId)" -ErrorAction Stop
    return $live -and $live.CreationDate -and ([DateTime]$live.CreationDate).ToUniversalTime() -eq ([DateTime]$Candidate.CreationDate).ToUniversalTime()
  } catch { return $false }
}

function Wait-CodexUsageMainProcessExit([int]$ProcessId, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
    Start-Sleep -Milliseconds 250
  } while ($true)
}

function Start-CodexUsageSupervisedMonitor([int]$CandidatePort) {
  & (Join-Path $PSScriptRoot 'start-monitor.ps1') -Port $CandidatePort *> $null
  $runtimeState = Get-CodexUsageState
  $injectorPath = Join-Path $PSScriptRoot 'injector.mjs'
  if (-not $runtimeState -or $runtimeState.runtimeVersion -ne $CodexUsageVersion -or
    $runtimeState.port -ne $CandidatePort -or $runtimeState.injectorPath -ne $injectorPath) {
    throw '监视器后台状态与当前安装不一致。'
  }
  if ($runtimeState.startupPhase -eq 'ready') {
    Write-CodexUsageSupervisorLog "已验证监视器心跳，版本 $CodexUsageVersion，端口 $CandidatePort，PID $($runtimeState.injectorPid)。"
    return [ordered]@{ phase = 'monitoring'; port = $CandidatePort; injectorPid = $runtimeState.injectorPid }
  }
  Write-CodexUsageSupervisorLog "监视器尚未连接页面，版本 $CodexUsageVersion，端口 $CandidatePort，PID $($runtimeState.injectorPid)，等待重试。"
  return [ordered]@{ phase = 'waiting-ui'; port = $CandidatePort; injectorPid = $runtimeState.injectorPid }
}

try {
  try { $mutexAcquired = $mutex.WaitOne([TimeSpan]::FromSeconds(5)) }
  catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
  if (-not $mutexAcquired) { Write-CodexUsageSupervisorLog '另一个运行时协调器已在运行。'; return }

  $control = Get-CodexUsageRuntimeControl
  if (-not $control.enabled) {
    Write-CodexUsageSupervisorState ([ordered]@{ phase = 'disabled'; port = $Port })
    return
  }

  $handled = [Collections.Generic.HashSet[string]]::new()
  $handoffTimes = [Collections.Generic.Queue[DateTime]]::new()
  $lastMonitorAttempts = @{}
  $monitorStates = @{}
  $lastIdleWrite = [DateTime]::MinValue
  Write-CodexUsageSupervisorLog "运行时协调器启动，偏好端口 $Port。"
  Write-CodexUsageSupervisorState ([ordered]@{ phase = 'watching'; port = $Port })

  while ($true) {
    $control = Get-CodexUsageRuntimeControl
    if (-not $control.enabled) {
      Write-CodexUsageSupervisorLog '监控进程已禁用，协调器退出。'
      Write-CodexUsageSupervisorState ([ordered]@{ phase = 'disabled'; port = $Port })
      break
    }

    $activePort = 0
    try { $activePort = Resolve-CodexUsageCdpPort $Port } catch {}
    if ($activePort) {
      $lastAttempt = if ($lastMonitorAttempts.ContainsKey($activePort)) { [DateTime]$lastMonitorAttempts[$activePort] } else { [DateTime]::MinValue }
      if (([DateTime]::UtcNow - $lastAttempt).TotalSeconds -ge $MonitorRetrySeconds) {
        $lastMonitorAttempts[$activePort] = [DateTime]::UtcNow
        try {
          $monitorStates[$activePort] = Start-CodexUsageSupervisedMonitor $activePort
        } catch {
          Write-CodexUsageSupervisorLog "启动监视器失败：$($_.Exception.Message)"
          $monitorStates[$activePort] = [ordered]@{ phase = 'monitor-failed'; port = $activePort; message = $_.Exception.Message }
        }
      }
      Write-CodexUsageSupervisorState $monitorStates[$activePort]
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }

    $mains = @(Get-CodexUsageMainCodexProcesses | Sort-Object CreationDate -Descending)
    if (-not $mains.Count) {
      if (([DateTime]::UtcNow - $lastIdleWrite).TotalSeconds -ge 30) {
        $lastIdleWrite = [DateTime]::UtcNow
        Write-CodexUsageSupervisorState ([ordered]@{ phase = 'waiting-for-codex'; port = $Port })
      }
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }

    $candidate = $mains[0]
    $createdAt = if ($candidate.CreationDate) { ([DateTime]$candidate.CreationDate).ToUniversalTime() } else { [DateTime]::MinValue }
    $fingerprint = "$($candidate.ProcessId):$($createdAt.Ticks)"
    if ($handled.Contains($fingerprint)) {
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }

    $ageMilliseconds = if ($createdAt -eq [DateTime]::MinValue) { [int]::MaxValue } else { ([DateTime]::UtcNow - $createdAt).TotalMilliseconds }
    if ($ageMilliseconds -lt $NativeGraceMilliseconds) {
      Write-CodexUsageSupervisorState ([ordered]@{ phase = 'waiting-native-start'; port = $Port; codexPid = $candidate.ProcessId })
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }
    if ($candidate.HasCdpArgument -and $ageMilliseconds -lt ($CdpStartupTimeoutSeconds * 1000)) {
      Write-CodexUsageSupervisorState ([ordered]@{ phase = 'waiting-cdp'; port = $Port; codexPid = $candidate.ProcessId })
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }

    $handled.Add($fingerprint) | Out-Null
    $cutoff = [DateTime]::UtcNow.AddSeconds(-$HandoffWindowSeconds)
    while ($handoffTimes.Count -gt 0 -and $handoffTimes.Peek() -lt $cutoff) { [void]$handoffTimes.Dequeue() }
    if ($handoffTimes.Count -ge $MaxHandoffsPerWindow) {
      Write-CodexUsageSupervisorLog "最近 $HandoffWindowSeconds 秒内已尝试 $($handoffTimes.Count) 次交接，停止循环重启。"
      Write-CodexUsageSupervisorState ([ordered]@{ phase = 'restart-budget-exhausted'; port = $Port; codexPid = $candidate.ProcessId })
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }
    $handoffTimes.Enqueue([DateTime]::UtcNow)
    Write-CodexUsageSupervisorLog "检测到无 CDP 的 Codex 主进程 PID $($candidate.ProcessId)，开始交接。"
    Write-CodexUsageSupervisorState ([ordered]@{ phase = 'restarting-native-codex'; port = $Port; codexPid = $candidate.ProcessId })

    try {
      if (Test-CodexUsageMainProcessIdentity $candidate) {
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
        try { [void]$process.CloseMainWindow() } catch {}
        if (-not (Wait-CodexUsageMainProcessExit $candidate.ProcessId $CloseTimeoutSeconds)) {
          Write-CodexUsageSupervisorLog "PID $($candidate.ProcessId) 未在正常关闭期限内退出，结束该 Codex 进程树。"
          Stop-CodexUsageCodexProcessGeneration -RootProcessIds @($candidate.ProcessId)
          if (-not (Wait-CodexUsageMainProcessExit $candidate.ProcessId 5)) {
            throw "无法结束原生 Codex 进程 PID $($candidate.ProcessId)"
          }
        } else {
          Stop-CodexUsageCodexProcessGeneration -RootProcessIds @($candidate.ProcessId)
        }
      } else {
        Write-CodexUsageSupervisorLog '原生 Codex 进程身份已变化，跳过本次交接。'
      }

      $launchPort = Resolve-CodexUsageAvailablePort -PreferredPort $Port
      $launch = Start-CodexUsagePackagedCodex -Port $launchPort
      Write-CodexUsageSupervisorState ([ordered]@{ phase = 'waiting-cdp-after-restart'; port = $launchPort; codexPid = $launch.ProcessId })
      if (-not (Wait-CodexUsageCdpPort -Port $launchPort -ProcessId $launch.ProcessId -TimeoutSeconds $CdpStartupTimeoutSeconds)) {
        throw "带 CDP 的 Codex 未在 $CdpStartupTimeoutSeconds 秒内就绪（PID $($launch.ProcessId)）"
      }
      $lastMonitorAttempts[$launchPort] = [DateTime]::UtcNow
      Write-CodexUsageSupervisorLog "Codex 已切换为带 CDP 模式，端口 $launchPort。"
      $monitorStates[$launchPort] = Start-CodexUsageSupervisedMonitor $launchPort
      Write-CodexUsageSupervisorState $monitorStates[$launchPort]
    } catch {
      Write-CodexUsageSupervisorLog "Codex 交接失败：$($_.Exception.Message)"
      Write-CodexUsageSupervisorState ([ordered]@{ phase = 'restart-failed'; port = $Port; codexPid = $candidate.ProcessId; message = $_.Exception.Message })
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
} catch {
  Write-CodexUsageSupervisorLog "协调器异常：$($_.Exception.Message)"
  Write-CodexUsageSupervisorState ([ordered]@{ phase = 'failed'; port = $Port; message = $_.Exception.Message })
  throw
} finally {
  if ($mutexAcquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
