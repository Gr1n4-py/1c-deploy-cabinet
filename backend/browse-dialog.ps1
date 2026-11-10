<#
Диалог выбора пути для кабинета (запускается server.ps1 в отдельном STA-процессе).
Окно диалога поднимает наверх внешний сторож dialog-watchdog.ps1 (см. server.ps1).
Параметры: -Kind file|dir  -OutFile <путь>  (выбранный путь пишется в OutFile)
#>
param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace Native -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'

# Невидимая форма-владелец: держит диалог в нашей "ветке" z-порядка
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(-2000, -2000)
$owner.Show()
$owner.Activate()
[void][Native.Win]::SetForegroundWindow($owner.Handle)
[System.Windows.Forms.Application]::DoEvents()

$p = ''
if ($Kind -eq 'dir') {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.ShowNewFolderButton = $true
    if ($dlg.ShowDialog($owner) -eq 'OK') { $p = $dlg.SelectedPath }
} else {
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Filter = 'Исполняемые файлы (*.exe)|*.exe|Все файлы (*.*)|*.*'
    if ($dlg.ShowDialog($owner) -eq 'OK') { $p = $dlg.FileName }
}

$owner.Close()
[System.IO.File]::WriteAllText($OutFile, $p, (New-Object System.Text.UTF8Encoding($false)))
