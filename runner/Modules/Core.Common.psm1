# Core.Common — общие функции ядра: события шагов, BSL-лог, процессы 1cv8/ibcmd
# с прогрессом, конфиги .dev.env / env.json. Перенос из deploy-new-1c-project-ru-publish.ps1.

$script:EventSink = $null
$script:BslLogPath = $null

function Set-StepEventSink {
    # Подключает приемник событий: scriptblock { param($eventObj) } — runner
    # пишет их в steps.jsonl прогона.
    param([scriptblock]$Sink)
    $script:EventSink = $Sink
}

function Write-StepEvent {
    param(
        [string]$Step,
        [string]$Phase, # start | progress | success | error | skipped
        [string]$Detail = ''
    )
    $eventObj = [pscustomobject]@{
        ts     = (Get-Date).ToString('o')
        step   = $Step
        phase  = $Phase
        detail = $Detail
    }
    if ($script:EventSink) {
        try { & $script:EventSink $eventObj } catch { }
    }
    $color = @{ start = 'Cyan'; progress = 'DarkGray'; success = 'Green'; error = 'Red'; skipped = 'Yellow' }[$Phase]
    Write-Host ("  [{0}] {1}: {2}" -f $Step, $Phase, $Detail) -ForegroundColor $color
}

function Write-StepProgress {
    param([string]$Step, [string]$Detail)
    Write-StepEvent -Step $Step -Phase 'progress' -Detail $Detail
}

function Set-BslLogPath {
    param([string]$Path)
    $script:BslLogPath = $Path
}

function Write-BslLog {
    param([string]$Message)
    if (-not $script:BslLogPath) { return }
    $line = "// Deploy: $Message"
    try {
        Add-Content -LiteralPath $script:BslLogPath -Value $line -Encoding UTF8
    }
    catch {
        # ошибки лога не критичны
    }
}

function Test-PathOrFail {
    param([string]$Path, [string]$What)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$What not found: $Path"
    }
}

# Запускает процесс (1cv8/ibcmd/mcp-1c), следит за хвостом stdout и на каждый
# новый статус «Обрабатывается: X» / «Выгрузка X» шлет progress-событие.
# Возвращает код выхода. Перенос Invoke-1cv8WithProgress.
function Invoke-CoreProcess {
    param(
        [string[]]$CmdLine,
        [string]$LogPath,
        [string]$Title,
        [string]$Step = ''
    )
    $stdoutPath = $LogPath + '.stdout.log'
    $stderrPath = $LogPath + '.stderr.log'
    $procWord = 'Обрабатывается:'
    $unlWord  = 'Выгрузка '
    $reProc = [regex]::Escape($procWord) + '\s*(.+?)\s*$'
    $reUnl  = [regex]::Escape($unlWord)  + '(.+?)\s*$'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # PS 5.1 Start-Process -ArgumentList склеивает массив пробелами БЕЗ кавычек,
    # поэтому аргументы с пробелами квотируем явно одной строкой.
    $argList = ($CmdLine[1..($CmdLine.Count - 1)] | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $proc = Start-Process -FilePath $CmdLine[0] -ArgumentList $argList -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    try {
        while (-not $proc.HasExited) {
            $proc | Wait-Process -Timeout 1 -ErrorAction SilentlyContinue | Out-Null
            $obj = ''
            if (Test-Path -LiteralPath $stdoutPath) {
                try { $last = (Get-Content -LiteralPath $stdoutPath -Tail 1 -ErrorAction Stop) -replace '\s+', ' ' } catch { $last = '' }
                if ($last -match $reProc) { $obj = $matches[1] }
                elseif ($last -match $reUnl) { $obj = $matches[1] }
            }
            $elapsed = $sw.Elapsed.ToString('mm\:ss')
            $detail = if ($obj) { "$obj ($elapsed)" } else { "выполняется ($elapsed)" }
            if ($Step) { Write-StepProgress -Step $Step -Detail $detail }
        }
        return $proc.ExitCode
    }
    finally { }
}

# Проверяет лог процесса на ошибки 1С и при неудаче бросает исключение с хвостами
# stdout/stderr. Перенос повторяющегося блока error-handling дампов/install.
function Assert-CoreProcessSuccess {
    param(
        [int]$ExitCode,
        [string]$LogPath,
        [string]$ErrorLabel
    )
    $stdoutPath = $LogPath + '.stdout.log'
    $stderrPath = $LogPath + '.stderr.log'
    $logText = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue } else { '' }
    $logError = ($logText -split "`r?`n" | Where-Object { $_ -match '^\s*(Ошибка|Error|ERROR|Сбой|FATAL)\b' } | Select-Object -First 5)
    if ($exitCode -ne 0 -or $logError) {
        $tails = @()
        foreach ($f in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $f) {
                $tails += (Get-Content -LiteralPath $f -Tail 20 -ErrorAction SilentlyContinue) -join ' | '
            }
        }
        throw "$ErrorLabel завершился с ошибкой (код $exitCode). Подробности в $stdoutPath / $stderrPath. Хвост: $($tails -join ' ')"
    }
}

# Запускает команду ibcmd (или mcp-1c) с прогрессом, логом и проверкой ошибок.
# Перенос Invoke-IbcmdLogged.
function Invoke-CoreIbcmd {
    param(
        [string]$Ibcmd,
        [string[]]$Arguments,
        [string]$LogPath,
        [string]$Title,
        [string]$ErrorLabel,
        [string]$Step = ''
    )
    $cmdLine = @($Ibcmd) + $Arguments
    Write-Host "    > $($cmdLine -join ' ')" -ForegroundColor DarkGray
    $exitCode = Invoke-CoreProcess -CmdLine $cmdLine -LogPath $LogPath -Title $Title -Step $Step
    Assert-CoreProcessSuccess -ExitCode $exitCode -LogPath $LogPath -ErrorLabel $ErrorLabel
}

function Copy-DirectorySafe {
    param([string]$Source, [string]$Destination)
    if (Test-Path -LiteralPath $Destination) {
        Write-Host "  -> already exists, skipping: $Destination" -ForegroundColor DarkGray
        return
    }
    Copy-Item -Path $Source -Destination $Destination -Recurse -Force
}

# Точечный патч значения KEY=VALUE в .dev.env (перенос Set-DevEnvValue).
function Set-DevEnvValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )
    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $pattern = "(?m)^[ \t]*(#?[ \t]*)$([regex]::Escape($Key))[ \t]*=[^\r\n]*"
    $m = [regex]::Match($content, $pattern)
    if ($m.Success) {
        $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + "$Key=$Value")
    }
    else {
        $content = $content.TrimEnd([char[]]@("`r", "`n")) + "`r`n$Key=$Value`r`n"
    }
    Set-Content -LiteralPath $Path -Value $content -Encoding UTF8 -NoNewline
}

# Патч значения в профиле default файла env.json (перенос Set-EnvJsonValue).
function Set-EnvJsonValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )
    try {
        $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Cannot parse env.json at $Path : $_"
    }
    if (-not $json.default) { $json.default = [pscustomobject]@{} }
    if ($json.default.PSObject.Properties[$Key]) {
        $json.default.$Key = $Value
    } else {
        $json.default | Add-Member -NotePropertyName $Key -NotePropertyValue $Value
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $text = $json | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($Path, $text, $utf8)
}
