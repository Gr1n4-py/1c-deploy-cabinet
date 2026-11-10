# Core.Infobase — создание ИБ из .dt, проверка блокировок, дампы cf/cfe.
# Перенос разделов 5-6 скрипта. Функции принимают путь ИБ (файловая);
# дескриптор серверной ИБ подключается в части 2 (D12).

# Создает файловую ИБ через ibcmd infobase create --restore и восстанавливает .dt.
# Идемпотентно: если в каталоге ИБ уже есть файлы — шаг пропускается.
function New-CoreInfobaseFromDt {
    param(
        [string]$Ibcmd,
        [string]$IbPath,
        [string]$DtPath,
        [string]$ProjectDir,
        [string]$Step = '04-ib-create'
    )
    $ibHasFiles = (Test-Path -LiteralPath $IbPath -PathType Container) -and `
        (Get-ChildItem -LiteralPath $IbPath -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    if ($ibHasFiles) {
        Write-StepEvent -Step $Step -Phase 'success' -Detail "ИБ уже существует по пути /F$IbPath, пропуск"
        Write-Host "  Информационная база уже существует по пути /F$IbPath, пропускаю." -ForegroundColor DarkGray
        Write-BslLog "ИБ уже существует: $IbPath"
        return
    }

    $ibLog = Join-Path $ProjectDir 'build\ib-create.log'
    New-Item -ItemType Directory -Path (Split-Path -Parent $ibLog) -Force | Out-Null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $cmdLine = @(
        $Ibcmd
        'infobase'
        'create'
        '--db-path=' + $IbPath
        '--create-database'
        '--restore=' + $DtPath
    )
    Invoke-CoreIbcmd -Ibcmd $Ibcmd -Arguments ($cmdLine[1..($cmdLine.Count - 1)]) `
        -LogPath $ibLog -Title 'Создание информационной базы' `
        -ErrorLabel 'ibcmd CREATEINFOBASE' -Step $Step

    # Файл выгрузки .dt появляется после успешного восстановления
    Write-StepEvent -Step $Step -Phase 'success' -Detail "ИБ создана и .dt восстановлен: /F$IbPath ($($sw.Elapsed.ToString('hh\:mm\:ss')))"
    Write-Host "  Информационная база создана и .dt восстановлен по пути /F$IbPath" -ForegroundColor Green
    Write-BslLog "Создана ИБ: $IbPath (время: $($sw.Elapsed.ToString('hh\:mm\:ss')))"
}

# Создает файловую ИБ из 1Cv8.cf установленного шаблона конфигурации (D13):
# ibcmd infobase create --create-database --load=<cf> --apply — одна команда.
# Идемпотентно: если в каталоге ИБ уже есть файлы — шаг пропускается.
function New-CoreInfobaseFromCf {
    param(
        [string]$Ibcmd,
        [string]$IbPath,
        [string]$CfPath,
        [string]$ProjectDir,
        [string]$Step = '04-ib-create'
    )
    if (-not (Test-Path -LiteralPath $CfPath -PathType Leaf)) {
        throw "Файл конфигурации шаблона не найден: $CfPath"
    }
    $ibHasFiles = (Test-Path -LiteralPath $IbPath -PathType Container) -and `
        (Get-ChildItem -LiteralPath $IbPath -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    if ($ibHasFiles) {
        Write-StepEvent -Step $Step -Phase 'success' -Detail "ИБ уже существует по пути /F$IbPath, пропуск"
        Write-Host "  Информационная база уже существует по пути /F$IbPath, пропускаю." -ForegroundColor DarkGray
        Write-BslLog "ИБ уже существует: $IbPath"
        return
    }

    $ibLog = Join-Path $ProjectDir 'build\ib-create.log'
    New-Item -ItemType Directory -Path (Split-Path -Parent $ibLog) -Force | Out-Null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $cmdLine = @(
        $Ibcmd
        'infobase'
        'create'
        '--db-path=' + $IbPath
        '--create-database'
        '--load=' + $CfPath
        '--apply'
        '--force'
    )
    Write-StepEvent -Step $Step -Phase 'progress' -Detail "Загрузка конфигурации из шаблона: $CfPath"
    Invoke-CoreIbcmd -Ibcmd $Ibcmd -Arguments ($cmdLine[1..($cmdLine.Count - 1)]) `
        -LogPath $ibLog -Title 'Создание ИБ из шаблона конфигурации' `
        -ErrorLabel 'ibcmd CREATEINFOBASE (cf)' -Step $Step

    Write-StepEvent -Step $Step -Phase 'success' -Detail "ИБ создана, конфигурация из шаблона загружена: /F$IbPath ($($sw.Elapsed.ToString('hh\:mm\:ss')))"
    Write-Host "  Информационная база создана, конфигурация шаблона загружена по пути /F$IbPath" -ForegroundColor Green
    Write-BslLog "Создана ИБ из 1Cv8.cf: $IbPath (время: $($sw.Elapsed.ToString('hh\:mm\:ss')))"
}

# Проверка блокировок файловой ИБ (перенос Test-IbLock): файлы *.1cl с ненулевой
# длиной, зависшие 1cv8/1cv8c/designer с ИБ в заголовке, ibsrv с этим путем.
function Test-CoreIbLock {
    param([string]$IbPath, [string]$IbLeaf)

    $lockFiles = @(Get-ChildItem -LiteralPath $IbPath -Filter '*.1cl' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '*.cfl' -and $_.Length -gt 0 })
    foreach ($tmpFile in @(Get-ChildItem -LiteralPath $IbPath -Filter '1Cv8tmp.1CD' -ErrorAction SilentlyContinue)) {
        try {
            Remove-Item -LiteralPath $tmpFile.FullName -Force -ErrorAction Stop
        }
        catch {
            $lockFiles += $tmpFile
        }
    }

    $procs = @(Get-Process -Name '1cv8','1cv8c','designer' -ErrorAction SilentlyContinue)
    $ours = @()
    foreach ($p in $procs) {
        $title = $p.MainWindowTitle
        if ($title -and ($title -like "*$IbLeaf*" -or $title -like "*$IbPath*")) {
            $ours += $p
        }
    }

    $ibsrvProcs = @()
    try {
        $ibsrvProcs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'ibsrv.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$IbPath*") })
    }
    catch { }

    return [pscustomobject]@{
        LockFiles  = $lockFiles
        Processes  = $ours
        IbsrvProcs = $ibsrvProcs
        IsClean    = ($lockFiles.Count -eq 0 -and $ours.Count -eq 0 -and $ibsrvProcs.Count -eq 0)
    }
}

# Неинтерактивная проверка блокировок: поллинг до MaxWaitSec, затем ошибка со
# списком блокеров. Замена интерактивного цикла Ask-YesNo.
function Assert-CoreIbFree {
    param(
        [string]$IbPath,
        [string]$Step = '05-locks',
        [int]$MaxWaitSec = 120
    )
    $ibLeaf = Split-Path -Leaf $IbPath
    $deadline = (Get-Date).AddSeconds($MaxWaitSec)
    $attempt = 0
    while ($true) {
        $attempt += 1
        $state = Test-CoreIbLock -IbPath $IbPath -IbLeaf $ibLeaf
        if ($state.IsClean) {
            Write-StepEvent -Step $Step -Phase 'success' -Detail "Блокировок нет (проверок: $attempt)"
            Write-Host "  Проверка блокировок ИБ: чисто (попыток: $attempt)." -ForegroundColor Green
            return
        }

        $blockers = @()
        if ($state.LockFiles.Count -gt 0) {
            $blockers += ($state.LockFiles | ForEach-Object { "файл $($_.Name) ($($_.Length) байт)" })
        }
        if ($state.Processes.Count -gt 0) {
            $blockers += ($state.Processes | ForEach-Object { "процесс PID $($_.Id) [$($_.ProcessName)]" })
        }
        if ($state.IbsrvProcs.Count > 0) {
            $blockers += ($state.IbsrvProcs | ForEach-Object { "ibsrv PID $($_.ProcessId)" })
        }
        $detail = "Попытка ${attempt}: " + ($blockers -join '; ')
        Write-StepEvent -Step $Step -Phase 'progress' -Detail $detail
        Write-Host "  Проверка блокировок ИБ: БЛОКИРОВКА — $detail" -ForegroundColor Yellow
        Write-Host '  Закройте Конфигуратор/клиенты 1С и остановите ibsrv этой ИБ.' -ForegroundColor Yellow

        if ((Get-Date) -ge $deadline) {
            throw "Не удалось дождаться снятия блокировок ИБ $IbPath за ${MaxWaitSec}с. Блокеры: $($blockers -join '; ')"
        }
        Start-Sleep -Seconds 5
    }
}

# Дамп основной конфигурации: ibcmd infobase config export -> src/cf.
# Идемпотентно: пропускается, если выгрузка уже есть. Перенос раздела cf.
function Export-CoreCf {
    param(
        [string]$Ibcmd,
        [string]$IbPath,
        [string]$ProjectDir,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$Step = '07-cf-dump'
    )
    $cfRoot = Join-Path $ProjectDir (Join-Path 'src' 'cf')
    $cfMarker = Join-Path $cfRoot 'Configuration.xml'
    $cfDone = (Test-Path -LiteralPath $cfRoot -PathType Container) -and `
        ((Get-ChildItem -LiteralPath $cfRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
    if ($cfDone) {
        Write-StepEvent -Step $Step -Phase 'success' -Detail "Выгрузка уже есть: $cfRoot — пропуск"
        Write-Host "  Обнаружена выгруженная основная конфигурация в $cfRoot, пропускаю." -ForegroundColor DarkGray
        return
    }

    $cfLogPath = Join-Path $ProjectDir 'build\cf-dump.log'
    New-Item -ItemType Directory -Path (Split-Path -Parent $cfLogPath) -Force | Out-Null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    Write-StepProgress -Step $Step -Detail 'Выгрузка основной конфигурации через ibcmd'
    $cmdLine = @(
        $Ibcmd
        'infobase'
        'config'
        'export'
        '--db-path=' + $IbPath
    )
    if ($DbUser) {
        $cmdLine += '--user=' + $DbUser
        if ($DbPassword) {
            $cmdLine += '--password=' + $DbPassword
        }
    }
    $cmdLine += $cfRoot
    Invoke-CoreIbcmd -Ibcmd $Ibcmd -Arguments ($cmdLine[1..($cmdLine.Count - 1)]) `
        -LogPath $cfLogPath -Title 'Дамп основной конфигурации' `
        -ErrorLabel 'ibcmd config export' -Step $Step

    if (-not (Test-Path -LiteralPath $cfMarker)) {
        throw "Configuration.xml не найден в $cfRoot после дампа. ИБ пуста или выгрузка настроена некорректно."
    }
    Write-StepEvent -Step $Step -Phase 'success' -Detail "Основная конфигурация выгружена в src/cf ($($sw.Elapsed.ToString('hh\:mm\:ss')))"
    Write-Host '  Основная конфигурация выгружена.' -ForegroundColor Green
    Write-BslLog "Выгружена основная конфигурация в src/cf (время: $($sw.Elapsed.ToString('hh\:mm\:ss')))"
}

# Дамп всех расширений: ibcmd config export all-extensions -> src/cfe/<имя>.
# Перенос раздела cfe.
function Export-CoreCfe {
    param(
        [string]$Ibcmd,
        [string]$IbPath,
        [string]$ProjectDir,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$Step = '08-cfe-dump'
    )
    $cfeRoot = Join-Path $ProjectDir (Join-Path 'src' 'cfe')
    $cfeDone = (Test-Path -LiteralPath $cfeRoot -PathType Container) -and `
        ((Get-ChildItem -LiteralPath $cfeRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
    if ($cfeDone) {
        Write-StepEvent -Step $Step -Phase 'success' -Detail "Выгрузка расширений уже есть: $cfeRoot — пропуск"
        Write-Host "  Обнаружены выгруженные расширения в $cfeRoot, пропускаю." -ForegroundColor DarkGray
        return
    }

    $cfeLog = Join-Path $ProjectDir 'build\cfe-dump.log'
    New-Item -ItemType Directory -Path $cfeRoot -Force | Out-Null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    Write-StepProgress -Step $Step -Detail 'Выгрузка расширений через ibcmd'
    $cmdLine = @(
        $Ibcmd
        'config'
        'export'
        'all-extensions'
        '--db-path=' + $IbPath
    )
    if ($DbUser) {
        $cmdLine += '--user=' + $DbUser
        if ($DbPassword) {
            $cmdLine += '--password=' + $DbPassword
        }
    }
    $cmdLine += $cfeRoot
    Invoke-CoreIbcmd -Ibcmd $Ibcmd -Arguments ($cmdLine[1..($cmdLine.Count - 1)]) `
        -LogPath $cfeLog -Title 'Дамп расширений' `
        -ErrorLabel 'ibcmd config export all-extensions' -Step $Step

    $cfeDirs = @(Get-ChildItem -LiteralPath $cfeRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'Configuration.xml') })
    if ($cfeDirs.Count -eq 0) {
        Write-StepEvent -Step $Step -Phase 'success' -Detail 'В ИБ расширения не найдены'
        Write-Host '  В ИБ расширения не найдены.' -ForegroundColor DarkGray
    }
    else {
        $extNames = $cfeDirs.Name -join ', '
        Write-StepEvent -Step $Step -Phase 'success' -Detail "Выгружено расширений: $($cfeDirs.Count) ($extNames) ($($sw.Elapsed.ToString('hh\:mm\:ss')))"
        Write-Host "  Выгружено расширений: $($cfeDirs.Count) ($extNames)" -ForegroundColor Green
        Write-BslLog "Выгружено $($cfeDirs.Count) расширений в src/cfe: $extNames (время: $($sw.Elapsed.ToString('hh\:mm\:ss')))"
    }
}
