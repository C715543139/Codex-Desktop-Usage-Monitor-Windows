[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9335,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'monitor-utils.ps1')

function Get-CodexMonitorLaunchPlan([bool]$DebugReady, [bool]$CodexRunning, [bool]$HasCdpProcess = $false) {
  if ($DebugReady) { return 'reuse-codex' }
  if ($HasCdpProcess) { return 'wait-cdp' }
  if ($CodexRunning) { return 'restart-native-codex' }
  return 'launch-codex'
}

if ($SelfTest) {
  $cases = @(
    @{ DebugReady = $true; CodexRunning = $true; Expected = 'reuse-codex' },
    @{ DebugReady = $true; CodexRunning = $false; Expected = 'reuse-codex' },
    @{ DebugReady = $false; CodexRunning = $true; Expected = 'restart-native-codex' },
    @{ DebugReady = $false; CodexRunning = $false; Expected = 'launch-codex' }
  )
  foreach ($case in $cases) {
    if ((Get-CodexMonitorLaunchPlan $case.DebugReady $case.CodexRunning) -ne $case.Expected) { throw '监视器启动决策测试失败。' }
  }
  if ((Get-CodexMonitorLaunchPlan $false $true $true) -ne 'wait-cdp') { throw '已有 CDP 进程时应等待页面，不重复启动或交接。' }
  $injectorPath = Join-Path $PSScriptRoot 'injector.mjs'
  $injectorProcess = [pscustomobject]@{ ProcessId = 42; InjectorPath = $injectorPath }
  $legacyState = [pscustomobject]@{ injectorPid = 42; injectorPath = $injectorPath }
  $currentState = [pscustomobject]@{ injectorPid = 42; injectorPath = $injectorPath; runtimeVersion = $CodexUsageVersion }
  if (Test-CodexUsageReusableInjector $legacyState $injectorProcess $injectorPath) { throw '旧版状态不应复用新版监视器进程。' }
  if (-not (Test-CodexUsageReusableInjector $currentState $injectorProcess $injectorPath)) { throw '当前版本状态应允许复用监视器进程。' }
  $testListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $testListener.Server.ExclusiveAddressUse = $true
    $testListener.Start()
    $occupiedPort = ([Net.IPEndPoint]$testListener.LocalEndpoint).Port
    if (Test-CodexUsageTcpPortAvailable $occupiedPort) { throw '已占用端口不应被识别为可用。' }
    $searchCount = [Math]::Min(32, 65536 - $occupiedPort)
    $availablePort = Resolve-CodexUsageAvailablePort -PreferredPort $occupiedPort -SearchCount $searchCount
    if ($availablePort -le $occupiedPort -or -not (Test-CodexUsageTcpPortAvailable $availablePort)) { throw '端口冲突时应选择后续可用端口。' }
  } finally {
    $testListener.Stop()
  }
  if (-not (Test-CodexUsageTcpPortAvailable $occupiedPort)) { throw '监听器关闭后端口应恢复可用。' }
  $orderedPorts = @(Get-CodexUsageCdpCandidates -PreferredPort 9335 -ProcessPorts @(9338, 9338) -ActiveFilePort 9337 -StatePort 9336)
  if (($orderedPorts -join ',') -ne '9338,9337,9336,9335,9229') { throw 'CDP 端口候选顺序测试失败。' }
  Write-Host 'PASS: Codex monitor launcher decisions.'
  return
}

function Show-CodexMonitorMessage([string]$Message, [string]$Icon = 'Information') {
  try {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($Message, 'Codex 用量监视器', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::$Icon)
  } catch { Write-Error $Message }
}

function Write-CodexMonitorLaunchError([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $CodexUsageStateRoot | Out-Null
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    [IO.File]::WriteAllText((Join-Path $CodexUsageStateRoot 'launcher-error.log'), $line, $CodexUsageUtf8)
  } catch {}
}

try {
  [void](Set-CodexUsageRuntimeControl -Enabled $true -Reason 'launcher')
  [void](Start-CodexUsageRuntimeSupervisor -Port $Port)
  $mains = @(Get-CodexUsageMainCodexProcesses)
  $codexRunning = $mains.Count -gt 0
  $hasCdpProcess = @($mains | Where-Object { $_.HasCdpArgument }).Count -gt 0
  $activePort = if ($codexRunning) { Resolve-CodexUsageCdpPort $Port } else { 0 }
  $debugReady = [bool]$activePort
  $plan = Get-CodexMonitorLaunchPlan $debugReady $codexRunning $hasCdpProcess
  if ($plan -eq 'wait-cdp') {
    # A timeout or normal quit must never turn a CDP launch into a native one.
    $activePort = Wait-CodexUsagePendingCdpPort
    if (-not $activePort) { return }
    $debugReady = $true
  }
  if ($plan -eq 'restart-native-codex') {
    $deadline = (Get-Date).AddSeconds(180)
    do {
      Start-Sleep -Milliseconds 500
      $activePort = Resolve-CodexUsageCdpPort $Port
      if ($activePort) { break }
      $runtimeControl = Get-CodexUsageRuntimeControl
      if (-not $runtimeControl.enabled) { return }
      $statusPath = Join-Path $CodexUsageStateRoot 'runtime-supervisor.json'
      try { $supervisorState = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $supervisorState = $null }
      if ($supervisorState -and $supervisorState.phase -eq 'waiting-for-codex' -and -not @(Get-CodexUsageMainCodexProcesses).Count) { return }
    } while ((Get-Date) -lt $deadline)
    if (-not $activePort) {
      throw '运行时协调器未能将原生 Codex 切换为带监视插件的模式。请查看 runtime-supervisor.log。'
    }
    $debugReady = $true
  }
  if ($debugReady) { $Port = $activePort }
  if (-not $debugReady) {
    $Port = Resolve-CodexUsageAvailablePort -PreferredPort $Port
    $launch = Start-CodexUsagePackagedCodex -Port $Port
    $Port = $launch.Port
    if (-not (Wait-CodexUsageCdpPort -Port $Port -ProcessId $launch.ProcessId)) { throw "Codex 调试端口 $Port 未就绪（PID $($launch.ProcessId)）；启动进程已退出或超过 180 秒启动期限，可能存在启动残留。请查看 runtime-supervisor.log。" }
  }
  & (Join-Path $PSScriptRoot 'start-monitor.ps1') -Port $Port
  # start-monitor.ps1 throws on failure. LASTEXITCODE may still contain a failed
  # readiness probe while the daemon is legitimately waiting for the renderer.
} catch {
  $message = "启动失败。`n`n$($_.Exception.Message)"
  Write-CodexMonitorLaunchError $message
  Show-CodexMonitorMessage $message 'Error'
  exit 1
}
