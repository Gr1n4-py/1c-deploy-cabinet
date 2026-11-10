<#
Сторож диалога выбора пути: пока browse-dialog показывает диалог в процессе
-TargetPid, каждые 300 мс ищет его окно (класс #32770 у целевого процесса) и
поднимает наверх: SetWindowPos(TOPMOST) + SwitchToThisWindow + SetForegroundWindow.
Лог: %TEMP%\cabinet-dialog-watchdog.log (для диагностики «диалог не видно»).
Параметры: -TargetPid <PID процесса с диалогом> [-TimeoutSec 60]
#>
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -Namespace Native -Name Win -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, IntPtr name);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, IntPtr name);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, ref uint procId);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
'@

$log = Join-Path $env:TEMP 'cabinet-dialog-watchdog.log'
function Write-Log {
    param([string]$Message)
    [System.IO.File]::AppendAllText($log, ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $Message + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
}

Write-Log "watchdog запущен: target=$TargetPid timeout=${TimeoutSec}s"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$done = $false
while (-not $done -and (Get-Date) -lt $deadline) {
    $h = [Native.Win]::FindWindow('#32770', [IntPtr]::Zero)
    while ($h -ne [IntPtr]::Zero) {
        $procId = [uint32]0
        [void][Native.Win]::GetWindowThreadProcessId($h, [ref]$procId)
        if ($procId -eq [uint32]$TargetPid -and [Native.Win]::IsWindowVisible($h)) {
            [void][Native.Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43)
            [void][Native.Win]::SwitchToThisWindow($h, $false)
            [void][Native.Win]::SetForegroundWindow($h)
            Write-Log "диалог hwnd=$h найден и поднят наверх"
            $done = $true
            break
        }
        $h = [Native.Win]::FindWindowEx([IntPtr]::Zero, $h, '#32770', [IntPtr]::Zero)
    }
    if (-not $done) { Start-Sleep -Milliseconds 300 }
}

if (-not $done) {
    Write-Log "диалог процесса $TargetPid не найден за ${TimeoutSec}s"
}
