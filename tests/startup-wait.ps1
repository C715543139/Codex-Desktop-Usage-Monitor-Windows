$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/monitor-utils.ps1')

function Assert-Startup($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

Assert-Startup ((Get-CodexUsageStartupPhase $true $false) -eq 'waiting-ui') 'A live slow-starting daemon must remain pending, not fail.'
Assert-Startup ((Get-CodexUsageStartupPhase $true $true) -eq 'ready') 'A matching live heartbeat should promote pending to ready.'
Assert-Startup ((Get-CodexUsageStartupPhase $false $false) -eq 'failed') 'A daemon that exits must fail.'
Assert-Startup ((Get-CodexUsageStartupPhase $false $true) -eq 'failed') 'A previous heartbeat must not conceal subsequent daemon exit.'

$pendingState = [pscustomobject]@{ startedAt = [DateTimeOffset]::UtcNow.AddSeconds(-200).ToString('o'); startupVerifiedAt = $null }
Assert-Startup (Test-CodexUsageInjectorStartupExpired $pendingState) 'An unresponsive backend must not be reused forever.'
$pendingState.startupVerifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
Assert-Startup (-not (Test-CodexUsageInjectorStartupExpired $pendingState)) 'A recent successful probe must preserve the healthy backend.'
Assert-Startup (-not (Test-CodexUsageInjectorStartupExpired ([pscustomobject]@{ startedAt = [DateTimeOffset]::UtcNow.ToString('o') }))) 'A newly started backend must retain its renderer loading grace.'

$removedInjector = Join-Path $env:LOCALAPPDATA 'Programs\CodexUsageMonitor\0.0.1\scripts\injector.mjs'
Assert-Startup (Test-CodexUsageManagedInjectorPath $removedInjector) 'A deleted managed package must not hide its running injector from retirement.'
Assert-Startup (-not (Test-CodexUsageManagedInjectorPath (Join-Path $env:LOCALAPPDATA 'Programs\OtherApp\0.0.1\scripts\injector.mjs'))) 'Unrelated injector paths must remain outside managed ownership.'

$startupTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-startup-wait-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $startupTestRoot | Out-Null
$originalRuntimeStateRoot = $CodexUsageStateRoot
try {
  $CodexUsageStateRoot = Join-Path $startupTestRoot 'runtime-state'
  [void](Set-CodexUsageRuntimeControl -Enabled $false -Reason 'test')
  Assert-Startup (-not (Get-CodexUsageRuntimeControl).enabled) 'Persisted monitor disable state must survive a fresh read.'
  [void](Set-CodexUsageRuntimeControl -Enabled $true -Reason 'test')
  Assert-Startup ((Get-CodexUsageRuntimeControl).enabled) 'Monitor re-enable state must survive a fresh read.'
  $supervisorPath = Get-CodexUsageRuntimeSupervisorPathFromCommandLine '"C:\Program Files\PowerShell\7\pwsh.exe" -File "C:\Codex Usage\scripts\runtime-supervisor.ps1" -Port 9335'
  Assert-Startup ($supervisorPath -eq 'C:\Codex Usage\scripts\runtime-supervisor.ps1') 'Supervisor process identification must preserve quoted script paths.'
  $emptyPath = Join-Path $startupTestRoot 'empty.log'
  $outputPath = Join-Path $startupTestRoot 'stdout.log'
  [IO.File]::WriteAllText($emptyPath, '')
  [IO.File]::WriteAllText($outputPath, 'real-startup-error')
  Assert-Startup ((Read-CodexUsageStartupLog $emptyPath) -eq '') 'An empty log must return a safe empty string.'
  Assert-Startup ((Read-CodexUsageStartupLog (Join-Path $startupTestRoot 'absent.log')) -eq '') 'A missing log must not conceal the failure.'
  $failure = Get-CodexUsageStartupFailure 321 7 $emptyPath $outputPath
  Assert-Startup ($failure -match '321' -and $failure -match '退出码 7' -and $failure -match 'real-startup-error') 'Failure diagnostics should include PID, exit code, and fallback stdout.'
  $failure = Get-CodexUsageStartupFailure 321 9 $emptyPath $emptyPath
  Assert-Startup ($failure -match '日志为空' -and $failure -match '退出码 9') 'Empty logs must retain useful failure diagnostics.'
  $locked = [IO.File]::Open($outputPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    Assert-Startup ((Read-CodexUsageStartupLog $outputPath) -match '暂时不可读取') 'An exclusively locked log must produce a safe diagnostic.'
  } finally { $locked.Dispose() }
  $shared = [IO.File]::Open($outputPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
  try {
    Assert-Startup ((Read-CodexUsageStartupLog $outputPath) -eq 'real-startup-error') 'A live redirected log must remain readable.'
  } finally { $shared.Dispose() }
  Assert-Startup ((Read-CodexUsageStartupLog $outputPath 5) -eq 'error') 'Log diagnostics must be bounded.'
} finally {
  $CodexUsageStateRoot = $originalRuntimeStateRoot
  # The exact GUID directory above is test-owned; no user state is touched.
  Remove-Item -LiteralPath $startupTestRoot -Recurse -Force
}

# Mock only the process boundary: exercise the real retirement policy without
# launching, probing, stopping, or otherwise changing any user's monitor.
$script:stoppedStartupPids = [Collections.Generic.List[int]]::new()
$script:startupProcesses = @{
  101 = [pscustomobject]@{ ProcessId = 101; InjectorPath = 'C:\test\old\scripts\injector.mjs'; Port = 9335 }
  102 = [pscustomobject]@{ ProcessId = 102; InjectorPath = 'C:\test\new\scripts\injector.mjs'; Port = 9335 }
  103 = [pscustomobject]@{ ProcessId = 103; InjectorPath = 'C:\other\scripts\injector.mjs'; Port = 9335 }
}
function Get-CodexUsageInjectorById([int]$ProcessId) { return $script:startupProcesses[$ProcessId] }
function Stop-Process([int]$Id, [switch]$Force, $ErrorAction) { $script:stoppedStartupPids.Add($Id) }
$prior = @(
  $script:startupProcesses[101],
  $script:startupProcesses[102],
  [pscustomobject]@{ ProcessId = 103; InjectorPath = 'C:\test\old\scripts\injector.mjs'; Port = 9335 }
)
Stop-CodexUsagePreviousInjectors $prior 102 $false
Assert-Startup ($script:stoppedStartupPids.Count -eq 0) 'Pending/failed replacement must preserve every existing daemon.'
Stop-CodexUsagePreviousInjectors $prior 102 $true
Assert-Startup (($script:stoppedStartupPids -join ',') -eq '101') 'Verified replacement should retire only the old matching identity, never itself or a reused PID.'
$script:stoppedStartupPids.Clear()
Stop-CodexUsagePreviousInjectors $prior 999 $true
Assert-Startup ($script:stoppedStartupPids.Count -eq 0) 'A candidate that exits after verification must not retire the fallback runtime.'

$testPath = 'C:\test\new\scripts\injector.mjs'
$pending = [pscustomobject]@{ injectorPid = 102; injectorPath = $testPath; runtimeVersion = $CodexUsageVersion; startupPhase = 'waiting-ui' }
Assert-Startup (Test-CodexUsageReusableInjector $pending $script:startupProcesses[102] $testPath) 'Repeated shortcut launches must reuse the matching waiting daemon.'

# Parse and execute the actual verification wrapper with a mocked child runner.
$startupSource = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/start-monitor.ps1'
$parseTokens = $null
$parseErrors = $null
$startupAst = [Management.Automation.Language.Parser]::ParseFile($startupSource, [ref]$parseTokens, [ref]$parseErrors)
Assert-Startup ($parseErrors.Count -eq 0) 'Startup script must parse.'
# Exercise only the shell-selection statements, with command discovery mocked.
# This never starts a monitor or imports the user's stored provider credentials.
& {
  $originalPowerShell = $env:CODEX_USAGE_POWERSHELL_PATH
  $shellSelection = [scriptblock]::Create((@($startupAst.EndBlock.Statements | Where-Object {
    $_.Extent.Text -match '^\$powerShellCommand\s*=' -or $_.Extent.Text -match '^if\s*\(\$powerShellCommand\)'
  } | ForEach-Object { $_.Extent.Text }) -join "`n"))
  function Get-Command { param($Name, $ErrorAction) return $script:availableTestShell }
  try {
    $script:availableTestShell = $null
    $env:CODEX_USAGE_POWERSHELL_PATH = 'stale-pwsh.exe'
    . $shellSelection
    Assert-Startup ($env:CODEX_USAGE_POWERSHELL_PATH -eq (Get-CodexUsageWindowsPowerShellPath)) 'Without PowerShell 7, the updater must receive the real Windows PowerShell path.'
    $script:availableTestShell = [pscustomobject]@{ Source = 'C:\test\PowerShell 7\pwsh.exe' }
    . $shellSelection
    Assert-Startup ($env:CODEX_USAGE_POWERSHELL_PATH -eq $script:availableTestShell.Source) 'An available PowerShell 7 should remain preferred.'
  } finally { $env:CODEX_USAGE_POWERSHELL_PATH = $originalPowerShell }
}
$probeAst = $startupAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-MonitorInjection' }, $true)
. ([scriptblock]::Create($probeAst.Extent.Text))
$node = 'mock-node'
$injector = 'C:\test\scripts\injector.mjs'
$script:probeArguments = ''
function Invoke-CodexUsageProcessWithTimeout($FilePath, $ArgumentLine, $TimeoutMs) {
  $script:probeArguments = $ArgumentLine
  return [pscustomobject]@{ TimedOut = $false; ExitCode = 0 }
}
Assert-Startup (Test-MonitorInjection 9335 102 1000) 'Successful heartbeat probe should verify.'
Assert-Startup ($script:probeArguments -match '--verify' -and $script:probeArguments -match '--expected-pid 102') 'Readiness must require the candidate backend identity, not merely a stale DOM host.'
$script:cdpProbeCount = 0
function Test-CodexUsageCdpPort([int]$Port) { $script:cdpProbeCount++; return $script:cdpProbeCount -ge 3 }
Assert-Startup (Wait-CodexUsageCdpPort 9335 1 0) 'A slow renderer should become ready after repeated port probes.'
Assert-Startup ($script:cdpProbeCount -eq 3) 'The CDP wait should not stop after its first unsuccessful probe.'
function Test-CodexUsageCdpPort([int]$Port) { return $false }
Assert-Startup (-not (Wait-CodexUsageCdpPort 9335 0 0)) 'A CDP deadline should return unavailable, not success.'

# A command-line flag proves intent, not that a process is still starting.
# Keep all process/window boundaries mocked; this never touches a live Codex.
& {
  $script:pendingCdpProcesses = @()
  $script:pendingCdpProbes = [Collections.Generic.List[int]]::new()
  $script:pendingCdpSleeps = [Collections.Generic.List[int]]::new()
  $script:pendingReadyPort = 0
  $script:pendingCreateDuringDiscovery = $false
  function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
    if ($Filter -match '^ProcessId = (\d+)$') {
      return $script:pendingCdpProcesses | Where-Object { $_.ProcessId -eq [int]$Matches[1] }
    }
    if ($script:pendingCreateDuringDiscovery) {
      # Simulate process creation while the CIM enumeration is in progress.
      [Threading.Thread]::Sleep(2)
      $script:pendingCdpProcesses = @([pscustomobject]@{
        ProcessId = 507; CreationDate = [DateTime]::UtcNow
        CommandLine = 'ChatGPT.exe --remote-debugging-port=9340'
      })
      $script:pendingCreateDuringDiscovery = $false
    }
    return $script:pendingCdpProcesses
  }
  function Test-CodexUsageCdpPort([int]$Port) {
    $script:pendingCdpProbes.Add($Port)
    return $Port -eq $script:pendingReadyPort
  }
  function Start-Sleep([int]$Milliseconds) {
    $script:pendingCdpSleeps.Add($Milliseconds)
    # Simulate the same process exiting between polls, without sleeping.
    $script:pendingCdpProcesses = @()
  }
  $oldProcess = [pscustomobject]@{
    ProcessId = 501; CreationDate = [DateTime]::UtcNow.AddHours(-2)
    CommandLine = 'ChatGPT.exe --remote-debugging-port=9335'
  }
  $normalProcess = [pscustomobject]@{
    ProcessId = 502; CreationDate = [DateTime]::UtcNow.AddSeconds(-1)
    CommandLine = 'ChatGPT.exe'
  }
  $script:pendingCdpProcesses = @($oldProcess, $normalProcess)
  $candidates = @(Get-CodexUsageProcessCdpCandidates)
  Assert-Startup ($candidates.Count -eq 1 -and $candidates[0].ProcessId -eq 501 -and $candidates[0].CreationDate -eq $oldProcess.CreationDate) 'CDP candidates must retain process identity and creation time.'
  foreach ($attempt in 1..2) {
    $staleFailure = ''
    try { [void](Wait-CodexUsagePendingCdpPort) } catch { $staleFailure = $_.Exception.Message }
    Assert-Startup ($staleFailure -match '调试端口未就绪' -and $staleFailure -match '残留' -and $staleFailure -match 'PID 501') 'Repeated shortcut clicks must identify stale startup processes instead of waiting another 180 seconds.'
  }
  Assert-Startup ($script:pendingCdpProbes.Count -eq 0 -and $script:pendingCdpSleeps.Count -eq 0) 'Expired candidates should return without probing or sleeping.'

  $freshProcess = [pscustomobject]@{
    ProcessId = 503; CreationDate = [DateTime]::UtcNow.AddSeconds(-2)
    CommandLine = 'ChatGPT.exe --remote-debugging-port 9336'
  }
  $childProcess = [pscustomobject]@{
    ProcessId = 504; CreationDate = [DateTime]::UtcNow.AddSeconds(-1)
    CommandLine = 'ChatGPT.exe --type=renderer --remote-debugging-port=9337'
  }
  $script:pendingCdpProcesses = @($oldProcess, $freshProcess, $childProcess)
  $script:pendingReadyPort = 9336
  Assert-Startup ((Wait-CodexUsagePendingCdpPort) -eq 9336) 'A fresh main process should be selected instead of an older residual process or renderer child.'
  Assert-Startup (($script:pendingCdpProbes -join ',') -eq '9336') 'Only the current startup candidate should be awaited.'

  $script:pendingCreateDuringDiscovery = $true
  $script:pendingReadyPort = 9340
  Assert-Startup ((Wait-CodexUsagePendingCdpPort) -eq 9340) 'A process created during discovery must not be misclassified as a future or stale process.'

  $script:pendingReadyPort = 0
  $script:pendingCdpProbes.Clear()
  $budgetProcess = [pscustomobject]@{
    ProcessId = 505; CreationDate = [DateTime]::UtcNow.AddSeconds(-18)
    CommandLine = 'ChatGPT.exe --remote-debugging-port=9338'
  }
  $script:pendingCdpProcesses = @($budgetProcess)
  $budgetCandidate = @(Get-CodexUsageProcessCdpCandidates)[0]
  Assert-Startup (-not (Wait-CodexUsageCdpPort 9338 20 5000 $budgetCandidate)) 'A candidate that exits must end its wait.'
  Assert-Startup ($script:pendingCdpSleeps.Count -eq 1 -and $script:pendingCdpSleeps[0] -gt 0 -and $script:pendingCdpSleeps[0] -le 2000) 'Only the remaining creation-time budget may be slept, not a new full timeout.'
  Assert-Startup ($script:pendingCdpProbes.Count -eq 1) 'A process exit should stop before the next port probe.'

  $script:pendingCdpProbes.Clear()
  $script:pendingCdpSleeps.Clear()
  $script:pendingCdpProcesses = @([pscustomobject]@{
    ProcessId = 503; CreationDate = [DateTime]::UtcNow
    CommandLine = 'ChatGPT.exe --remote-debugging-port=9336'
  })
  $script:pendingReadyPort = 9336
  Assert-Startup (-not (Wait-CodexUsageCdpPort 9336 180 0 ([pscustomobject]@{ ProcessId = 503; CreationDate = $freshProcess.CreationDate }))) 'A reused PID must not inherit the original startup wait.'
  Assert-Startup ($script:pendingCdpProbes.Count -eq 0) 'Process identity must be checked before probing a reused PID.'

  $script:pendingCdpProcesses = @()
  Assert-Startup (-not (Wait-CodexUsageCdpPort -Port 9339 -ProcessId 506)) 'A newly launched process that already exited must fail promptly.'
  Assert-Startup ($script:pendingCdpProbes.Count -eq 0 -and $script:pendingCdpSleeps.Count -eq 0) 'A missing new process must not start an unbound 180-second wait.'
  $script:pendingCdpProcesses = @($freshProcess)
  Assert-Startup (Wait-CodexUsageCdpPort -Port 9336 -ProcessId 503) 'A new process should use its actual creation time and remain eligible once CDP is ready.'

  # Age limits apply only to pending starts. An old healthy CDP process remains
  # eligible for the normal port-resolution fast path used by both entrypoints.
  $originalAppData = $env:APPDATA
  function Get-CodexUsageState { return $null }
  try {
    $env:APPDATA = Join-Path $startupTestRoot 'unused-profile'
    $script:pendingCdpProcesses = @($oldProcess)
    $script:pendingReadyPort = 9335
    Assert-Startup ((Resolve-CodexUsageCdpPort 9335) -eq 9335) 'An already-open CDP port must remain reusable regardless of process age.'
  } finally { $env:APPDATA = $originalAppData }
}
# Execute the real shutdown script; mock only process/HTTP boundaries so no
# running Codex or monitor can be closed by this regression check.
& {
  $shutdownTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-shutdown-' + [Guid]::NewGuid().ToString('N'))
  $previousLocalAppData = $env:LOCALAPPDATA
  $script:shutdownMainClosed = $false
  $script:shutdownStopped = [Collections.Generic.List[int]]::new()
  $fakeMain = [pscustomobject]@{ ProcessId = 65001; ParentProcessId = 0; CreationDate = [DateTime]::UtcNow; ExecutablePath = 'C:\test\ChatGPT.exe'; CommandLine = 'ChatGPT.exe --remote-debugging-port=9335' }
  $fakeInjector = [pscustomobject]@{ ProcessId = 65002; ParentProcessId = 0; CommandLine = ('node.exe "{0}" --watch --port 9335' -f (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\injector.mjs')) }
  function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
    if ($Filter -eq "Name = 'ChatGPT.exe'") { return $fakeMain }
    if ($Filter -eq "Name = 'node.exe'") { return $fakeInjector }
    return @()
  }
  function Get-Process($Id, $ErrorAction) {
    if ($Id -eq 65001 -and -not $script:shutdownMainClosed) {
      $process = [pscustomobject]@{ Id = 65001 }
      $process | Add-Member ScriptMethod CloseMainWindow {
        $control = Get-CodexUsageRuntimeControl
        if ($control.enabled) { throw 'Monitoring must be disabled before closing Codex.' }
        $script:shutdownMainClosed = $true
        return $true
      }
      return $process
    }
    return $null
  }
  function Stop-Process($Id, [switch]$Force, $ErrorAction) {
    if (-not $script:shutdownMainClosed) { throw 'The requesting backend must remain alive until Codex closes.' }
    $script:shutdownStopped.Add($Id)
  }
  try {
    $env:LOCALAPPDATA = $shutdownTestRoot
    $shutdownProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
      $shutdownProbe.Start()
      $unusedPort = ([Net.IPEndPoint]$shutdownProbe.LocalEndpoint).Port
    } finally { $shutdownProbe.Stop() }
    . (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\restore-monitor.ps1') -Port $unusedPort -DisableRuntime -CloseCodex -Reason test
    Assert-Startup $script:shutdownMainClosed 'The actual shutdown script must reach Codex closure.'
    Assert-Startup ($script:shutdownStopped.Contains(65002)) 'The monitor must stop after Codex closes.'
    Assert-Startup (-not (Get-CodexUsageRuntimeControl).enabled) 'Exit must persist the disabled state.'
  } finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    if (Test-Path -LiteralPath $shutdownTestRoot) { Remove-Item -LiteralPath $shutdownTestRoot -Recurse -Force }
  }
}
# Run the real supervisor loop with process/port snapshots. These scenarios
# never open, close or restart the user's desktop.
& {
  $supervisorPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\runtime-supervisor.ps1'
  $tokens = $null
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($supervisorPath, [ref]$tokens, [ref]$errors)
  foreach ($name in @('Test-CodexUsageMainProcessIdentity', 'Invoke-CodexUsageSupervision')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $Port = 9335
  $PollMilliseconds = 0
  $NativeGraceMilliseconds = 0
  $CdpStartupTimeoutSeconds = 1
  $CloseTimeoutSeconds = 1
  $MaxHandoffsPerWindow = 2
  $HandoffWindowSeconds = 300
  $MonitorRetrySeconds = 20
  function Write-CodexUsageSupervisorLog($Message) {}
  function Write-CodexUsageSupervisorState($State) { $script:supervisionStates.Add($State.phase) }
  function Start-Sleep($Milliseconds) { $script:supervisionFrame++ }
  function Get-CodexUsageRuntimeControl { return [pscustomobject]@{ enabled = $script:supervisionFrame -lt $script:supervisionFrames.Count } }
  function Get-CodexUsageMainCodexProcesses {
    if ($script:launchedInFrame -eq $script:supervisionFrame) { return $script:replacement }
    return $script:supervisionFrames[$script:supervisionFrame].Mains
  }
  function Resolve-CodexUsageCdpPort($Port) { if ($script:supervisionFrames[$script:supervisionFrame].Ready) { return 9335 }; return 0 }
  function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
    if ($script:identityChanged) { return $null }
    return Get-CodexUsageMainCodexProcesses | Where-Object { $Filter -eq "ProcessId = $($_.ProcessId)" }
  }
  function Get-Process($Id, $ErrorAction) {
    $process = [pscustomobject]@{ MainWindowHandle = [IntPtr]$script:nativeWindow }
    $process | Add-Member ScriptMethod Refresh {}
    $process | Add-Member ScriptMethod CloseMainWindow { $script:supervisionCloses++; return $script:closeAccepted }
    return $process
  }
  function Wait-CodexUsageMainProcessExit($ProcessId, $TimeoutSeconds) { return $true }
  function Stop-CodexUsageCodexProcessGeneration { throw 'These scenarios must not force-stop a process.' }
  function Resolve-CodexUsageAvailablePort($PreferredPort) { return $PreferredPort }
  function Start-CodexUsagePackagedCodex($Port) {
    $script:supervisionLaunches++
    $script:launchedInFrame = $script:supervisionFrame
    return [pscustomobject]@{ ProcessId = $script:replacement.ProcessId; Port = $Port }
  }
  function Start-CodexUsageSupervisedMonitor($CandidatePort) { return [ordered]@{ phase = 'monitoring'; port = $CandidatePort } }
  function Invoke-SupervisionScenario($Frames, $Replacement = $null, [int]$Window = 1, [bool]$CloseAccepted = $true, [bool]$IdentityChanged = $false) {
    $script:supervisionFrames = $Frames
    $script:supervisionFrame = 0
    $script:replacement = $Replacement
    $script:launchedInFrame = -1
    $script:nativeWindow = $Window
    $script:closeAccepted = $CloseAccepted
    $script:identityChanged = $IdentityChanged
    $script:supervisionLaunches = 0
    $script:supervisionCloses = 0
    $script:supervisionStates = [Collections.Generic.List[string]]::new()
    Invoke-CodexUsageSupervision
  }
  $native = [pscustomobject]@{ ProcessId = 701; CreationDate = [DateTime]::UtcNow.AddMinutes(-5); HasCdpArgument = $false }
  $cdp = [pscustomobject]@{ ProcessId = 702; CreationDate = [DateTime]::UtcNow.AddMinutes(-5); HasCdpArgument = $true }
  $withoutFlag = [pscustomobject]@{ ProcessId = 703; CreationDate = [DateTime]::UtcNow.AddMinutes(-4); HasCdpArgument = $false }
  $empty = @{ Mains = @(); Ready = $false }
  $nativeFrame = @{ Mains = @($native); Ready = $false }

  Invoke-SupervisionScenario @(@{ Mains = @($cdp); Ready = $true }, @{ Mains = @($native, $cdp); Ready = $false }, $empty)
  Assert-Startup ($script:supervisionLaunches -eq 0 -and $script:supervisionCloses -eq 0) 'Normal quit, missing pages and transient native launches must never restart a managed generation.'
  Assert-Startup ($script:supervisionStates.Contains('cdp-unavailable') -and $script:supervisionStates.Contains('waiting-for-codex')) 'A missing CDP page must transition to waiting for the next user launch.'

  Invoke-SupervisionScenario @($nativeFrame, @{ Mains = @($withoutFlag); Ready = $false }, @{ Mains = @($withoutFlag); Ready = $false }, @{ Mains = @($withoutFlag); Ready = $true }, $empty) $withoutFlag
  Assert-Startup ($script:supervisionLaunches -eq 1 -and $script:supervisionCloses -eq 1) 'One native handoff must stay at one launch even beyond the CDP deadline or without a reported flag.'
  Assert-Startup ($script:supervisionStates.Contains('monitoring')) 'A delayed page must connect without another desktop launch.'

  foreach ($scenario in @(@{ Window = 0 }, @{ CloseAccepted = $false }, @{ IdentityChanged = $true })) {
    Invoke-SupervisionScenario @($nativeFrame, $empty) @scenario
    Assert-Startup ($script:supervisionLaunches -eq 0) 'A closed window or vanished native process must cancel the handoff.'
  }
}

& {
  $script:desktopCreates = 0
  $script:existingDesktop = @()
  function Get-CodexUsageMainCodexProcesses { return $script:existingDesktop }
  function Start-CodexUsageDesktopProcess($Port) {
    $script:desktopCreates++
    $script:existingDesktop = @([pscustomobject]@{ ProcessId = 704; HasCdpArgument = $true; CommandLine = 'ChatGPT.exe --remote-debugging-port=9340' })
    return [pscustomobject]@{ ProcessId = 704; Port = 9340 }
  }
  $first = Start-CodexUsagePackagedCodex -Port 9340
  $second = Start-CodexUsagePackagedCodex -Port 9335
  Assert-Startup ($script:desktopCreates -eq 1 -and $first.ProcessId -eq $second.ProcessId -and $second.Port -eq 9340) 'Repeated startup entrypoints must reuse the actual generation and CDP port.'
}
Write-Host 'PASS: startup recovery, shutdown order, single native handoff, normal quit, slow CDP and shared desktop launch.'
