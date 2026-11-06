param([string]$Executable, [string]$Icon, [string]$WorkingDirectory, [string]$Name)
$ErrorActionPreference = 'Stop'
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($location in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $shortcut = $shortcutShell.CreateShortcut((Join-Path $location "$Name.lnk"))
  $shortcut.TargetPath = $Executable
  $shortcut.IconLocation = $Icon
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Save()
}
