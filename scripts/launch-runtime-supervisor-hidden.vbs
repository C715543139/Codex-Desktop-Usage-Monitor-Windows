Option Explicit

Dim arguments, shell, fileSystem, powerShellPath, supervisorPath, port, command
Set arguments = WScript.Arguments
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

If arguments.Count < 2 Then WScript.Quit 2

powerShellPath = arguments.Item(0)
port = arguments.Item(1)
supervisorPath = fileSystem.BuildPath(fileSystem.GetParentFolderName(WScript.ScriptFullName), "runtime-supervisor.ps1")
If Not fileSystem.FileExists(powerShellPath) Then WScript.Quit 2
If Not fileSystem.FileExists(supervisorPath) Then WScript.Quit 2
If Not IsNumeric(port) Then WScript.Quit 2

command = Quote(powerShellPath) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(supervisorPath) & " -Port " & port
WScript.Quit shell.Run(command, 0, True)

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
