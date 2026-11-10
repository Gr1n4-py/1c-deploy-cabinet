# Core.Tools — правила AI-агента (ai_rules_1c), bsl-analyzer,
# mcp-bsl-platform-context и связки с USER-RULES.md.
# Перенос разделов «Установка правил AI-агента», «Установка bsl-analyzer»,
# «Установка mcp-bsl-platform-context» скрипта.

# Добавляет управляемый блок в USER-RULES.md (единственный файл правил,
# который установщик не перезаписывает). Идемпотентно: повтор заменяет блок.
function Add-CoreUserRulesBlock {
    param(
        [string]$ProjectRoot,
        [string]$MarkerBegin,
        [string]$MarkerEnd,
        [string]$BlockTemplate,
        [string]$PlaceholderValue
    )
    $path = Join-Path $ProjectRoot 'USER-RULES.md'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $block = $MarkerBegin + "`r`n" + $BlockTemplate.Replace('{PLACEHOLDER}', $PlaceholderValue) + "`r`n" + $MarkerEnd + "`r`n"
    $content = [System.IO.File]::ReadAllText($path)
    $pattern = [regex]::Escape($MarkerBegin) + '[\s\S]*?' + [regex]::Escape($MarkerEnd)
    $m = [regex]::Match($content, $pattern)
    if ($m.Success) {
        $content = $content.Remove($m.Index, $m.Length)
    }
    $content = $content.TrimEnd("`r", "`n") + "`r`n`r`n" + $block
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

# Правила AI-агента: обновление кэша ai_rules_1c через git (клон/fetch+reset),
# установка через install.ps1 init. Без git/сети/при skip — фолбэк на локальную
# копию установщика. Перенос раздела правил.
function Install-CoreRules {
    param(
        [string]$ProjectDir,
        [string]$RulesSource = 'https://github.com/comol/ai_rules_1c',
        [string]$RulesCacheDir = 'C:\1C_Bases\AI\tools\ai_rules_1c',
        [switch]$SkipRulesUpdate,
        [string]$Step = '10-rules'
    )
    Write-StepProgress -Step $Step -Detail 'Установка правил AI-агента через install.ps1'

    $installerCandidates = @(
        (Join-Path $PSScriptRoot 'ai_rules_1c\install.ps1'),
        'C:\1C_Bases\AI\1c-deploy_new\ai_rules_1c\install.ps1',
        'C:\1C_Bases\AI\1c-deploy\ai_rules_1c\install.ps1'
    )
    $absoluteInstallerPath = $null

    if (-not $SkipRulesUpdate) {
        if (Get-Command git -ErrorAction SilentlyContinue) {
            try {
                if (Test-Path -LiteralPath (Join-Path $RulesCacheDir '.git')) {
                    Write-Host "  Обновляю кэш правил до origin/main: $RulesCacheDir" -ForegroundColor DarkGray
                    git -C $RulesCacheDir fetch --depth 1 origin main 2>$null
                    if ($LASTEXITCODE -eq 0) {
                        git -C $RulesCacheDir reset --hard FETCH_HEAD 2>$null | Out-Null
                    }
                }
                else {
                    Write-Host "  Клонирую актуальные правила: $RulesSource -> $RulesCacheDir" -ForegroundColor DarkGray
                    New-Item -ItemType Directory -Path $RulesCacheDir -Force | Out-Null
                    git clone --depth 1 $RulesSource $RulesCacheDir 2>$null
                }
                if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $RulesCacheDir 'install.ps1'))) {
                    $absoluteInstallerPath = Join-Path $RulesCacheDir 'install.ps1'
                    Write-Host "  Правила обновлены из $RulesSource" -ForegroundColor Green
                }
                else {
                    Write-Host "  Обновить кэш правил не удалось (git код $LASTEXITCODE) — использую локальную копию." -ForegroundColor Yellow
                }
            }
            catch {
                Write-Host "  Обновление кэша правил не удалось: $_" -ForegroundColor Yellow
                Write-Host '  Использую локальную копию правил.' -ForegroundColor Yellow
            }
        }
        else {
            Write-Host '  git не найден в PATH — использую локальную копию правил.' -ForegroundColor Yellow
        }
    }
    else {
        Write-Host '  skipRulesUpdate задан: ставлю локальный снимок правил без обновления.' -ForegroundColor DarkGray
    }

    if (-not $absoluteInstallerPath) {
        $absoluteInstallerPath = $installerCandidates |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    }

    if (-not $absoluteInstallerPath) {
        throw "install.ps1 не найден ни в кэше $RulesCacheDir, ни по одному из путей: $($installerCandidates -join '; ')"
    }
    Write-Host "  Источник установщика: $absoluteInstallerPath" -ForegroundColor Gray

    $projDir = [string]$ProjectDir
    & $absoluteInstallerPath -Command "init" -ProjectRoot $projDir -Tools kilocode -NonInteractive -AssumeYes

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARNING: install.ps1 завершился с кодом $LASTEXITCODE" -ForegroundColor Yellow
        Write-BslLog "install.ps1 завершился с ошибкой (код $LASTEXITCODE)"
    }
    else {
        Write-Host '  Правила AI-агента установлены.' -ForegroundColor Green
        Write-BslLog 'Установлены правила AI-агента через install.ps1'
    }
}

# bsl-analyzer.toml в корне проекта (root = src/cf). Существующий не трогается.
function Set-CoreBslAnalyzerToml {
    param([string]$ProjectRoot, [string]$SourceRoot = 'src/cf')
    $tomlPath = Join-Path $ProjectRoot 'bsl-analyzer.toml'
    if (Test-Path -LiteralPath $tomlPath) { return }
    $text = "[source]`r`nroot = `"$SourceRoot`"`r`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tomlPath, $text, $utf8NoBom)
}

# Записи bsl-analyzer (workspace + reference) в .kilo/kilo.json.
function Set-CoreKiloBslAnalyzerMcp {
    param(
        [string]$ProjectRoot,
        [string]$AnalyzerExe,
        [string]$WorkspaceId = 'bsl-analyzer-workspace',
        [string]$ReferenceId = 'bsl-analyzer-reference'
    )
    $entries = @(
        @{ Id = $WorkspaceId; Args = @('mcp', 'serve', '--profile', 'workspace', '--source-dir', $ProjectRoot) },
        @{ Id = $ReferenceId; Args = @('mcp', 'serve', '--profile', 'reference') }
    )
    foreach ($e in $entries) {
        Set-CoreKiloMcpEntry -ProjectRoot $ProjectRoot -ServerId $e.Id -TimeoutMs 60000 `
            -Command (@($AnalyzerExe) + $e.Args)
    }
}

# Установка bsl-analyzer: официальной install.ps1 в %LOCALAPPDATA%\Programs
# (без прав администратора), затем toml + kilo.json + USER-RULES.md.
# Пропускается флагом SkipBslAnalyzer и при уже установленном exe.
function Install-CoreBslAnalyzer {
    param(
        [string]$ProjectDir,
        [string]$ProjectRoot,
        [string]$BslAnalyzerDir = '',
        [string]$BslAnalyzerVersion = '',
        [switch]$SkipBslAnalyzer,
        [string]$Step = '11-bsl-analyzer'
    )
    if (-not $BslAnalyzerDir) { $BslAnalyzerDir = Join-Path $env:LOCALAPPDATA 'Programs\bsl-analyzer' }
    $analyzerExe = Join-Path $BslAnalyzerDir 'bsl-analyzer.exe'
    $analyzerReady = Test-Path -LiteralPath $analyzerExe

    if ($SkipBslAnalyzer) {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail 'skipBslAnalyzer задан — установка пропущена'
        Write-Host '  skipBslAnalyzer задан: установка пропущена.' -ForegroundColor DarkGray
        Write-BslLog 'bsl-analyzer: установка пропущена (skipBslAnalyzer)'
        return
    }
    if ($analyzerReady) {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail "Уже установлен: $analyzerExe"
        Write-Host "  bsl-analyzer уже установлен: $analyzerExe" -ForegroundColor DarkGray
        Write-BslLog "bsl-analyzer: уже установлен ($analyzerExe)"
    }
    else {
        Write-Host "  Устанавливаю bsl-analyzer (официальный install.ps1) -> $BslAnalyzerDir..." -ForegroundColor Yellow
        Write-StepProgress -Step $Step -Detail 'Скачивание и установка bsl-analyzer'
        try {
            $analyzerInstallerUrl = 'https://raw.githubusercontent.com/itrous/bsl-analyzer/develop/scripts/install.ps1'
            $analyzerInstallerText = (Invoke-WebRequest -Uri $analyzerInstallerUrl -UseBasicParsing -TimeoutSec 120).Content
            $analyzerInstallArgs = @{ NoPathUpdate = $true }
            if ($BslAnalyzerVersion) { $analyzerInstallArgs.Version = $BslAnalyzerVersion }
            & ([scriptblock]::Create($analyzerInstallerText)) @analyzerInstallArgs
            $analyzerReady = Test-Path -LiteralPath $analyzerExe
            if ($analyzerReady) {
                Write-BslLog "bsl-analyzer установлен: $analyzerExe"
            }
            else {
                Write-Host "  Установщик отработал, но $analyzerExe не найден — возможно, изменился путь установки." -ForegroundColor Yellow
                Write-BslLog "bsl-analyzer: установщик отработал, но $analyzerExe не найден"
            }
        }
        catch {
            Write-Host "  Установка bsl-analyzer не удалась: $_" -ForegroundColor Yellow
            Write-Host '  Продолжаю без анализатора. Вручную: irm https://raw.githubusercontent.com/itrous/bsl-analyzer/develop/scripts/install.ps1 | iex' -ForegroundColor Yellow
            Write-BslLog "bsl-analyzer: установка не удалась ($_)"
        }
    }

    if ($analyzerReady) {
        Set-CoreBslAnalyzerToml -ProjectRoot $ProjectRoot -SourceRoot 'src/cf'
        Set-CoreKiloBslAnalyzerMcp -ProjectRoot $ProjectRoot -AnalyzerExe $analyzerExe
        Add-CoreUserRulesBlock -ProjectRoot $ProjectRoot `
            -MarkerBegin '<!-- bsl-analyzer: deploy-new-1c-project managed block -->' `
            -MarkerEnd '<!-- end bsl-analyzer managed block -->' `
            -BlockTemplate @'

## bsl-analyzer - локальный валидатор BSL

Серверы {PLACEHOLDER} установлены развёртыванием этого проекта. Штатная цепочка
валидаторов правил (syntaxcheck / check_1c_code / review_1c_code) рассчитана
на 1c-syntax-checker-mcp и 1c-code-check-mcp, которые в данном проекте не
развёрнуты. Пока это так, роль локального статического валидатора BSL
выполняет bsl-analyzer: перед сдачей изменения прогоняй его инструменты
(diagnostics, search, symbol_info, graph) по затронутым модулям вместо
недоступного syntaxcheck. Метаданные, запросы и данные по-прежнему проверять
через 1c-data-mcp; bsl-analyzer не заменяет проверку результата в ИБ.
'@ `
            -PlaceholderValue 'bsl-analyzer-workspace, bsl-analyzer-reference'
        Write-StepEvent -Step $Step -Phase 'success' -Detail 'bsl-analyzer.toml, .kilo/kilo.json (workspace/reference), USER-RULES.md обновлены'
        Write-Host '  Готово: bsl-analyzer.toml, .kilo/kilo.json (bsl-analyzer-workspace / bsl-analyzer-reference), USER-RULES.md.' -ForegroundColor Green
        Write-BslLog 'bsl-analyzer: bsl-analyzer.toml + .kilo/kilo.json (workspace/reference) + USER-RULES.md обновлены'
    }
    else {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail 'bsl-analyzer недоступен — настройка пропущена'
    }
}

# mcp-bsl-platform-context: справка платформы 1С (fat-JAR с GitHub Releases,
# java 17+). Jar общий на все проекты (-PlatformContextDir). kilo.json получает
# bsl-platform-context (stdio) с --platform-path выбранной платформы.
function Install-CorePlatformContext {
    param(
        [string]$ProjectDir,
        [string]$ProjectRoot,
        [string]$PlatformDir,
        [string]$JavaPath = '',
        [string]$PlatformContextDir = 'C:\1C_Bases\AI\tools\mcp-bsl-context',
        [string]$PlatformContextVersion = 'latest',
        [switch]$SkipPlatformContext,
        [string]$Step = '12-platform-context'
    )
    $contextJarPath = $null
    $javaExe = $null

    if ($SkipPlatformContext) {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail 'skipPlatformContext задан — установка пропущена'
        Write-Host '  skipPlatformContext задан: установка пропущена.' -ForegroundColor DarkGray
        Write-BslLog 'mcp-bsl-platform-context: установка пропущена (skipPlatformContext)'
        return
    }

    # 1. Java 17+
    $javaCandidate = $null
    if ($JavaPath) {
        $javaCandidate = $JavaPath
        if (-not (Test-Path -LiteralPath $javaCandidate)) {
            Write-Host "  -JavaPath не найден: $JavaPath" -ForegroundColor Yellow
            $javaCandidate = $null
        }
    }
    else {
        $javaCandidate = (Get-Command java -ErrorAction SilentlyContinue).Source
    }
    if ($javaCandidate) {
        $javaVersionText = ''
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $javaVersionText = (& $javaCandidate -version 2>&1 | Out-String) } catch { } finally { $ErrorActionPreference = $prevEap }
        $javaMajor = [regex]::Match($javaVersionText, 'version "(\d+)').Groups[1].Value
        if ($javaMajor -and [int]$javaMajor -lt 17) {
            Write-Host "  Найден java $javaMajor, а нужен 17+ — mcp-bsl-platform-context пропущен." -ForegroundColor Yellow
            Write-BslLog "mcp-bsl-platform-context: java $javaMajor < 17, пропущен"
            $javaCandidate = $null
        }
        else {
            $javaExe = $javaCandidate
            if (-not $javaMajor) {
                Write-Host '  Не удалось определить версию java — считаю подходящей.' -ForegroundColor DarkGray
            }
        }
    }
    else {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail 'java не найдена (нужен JDK 17+)'
        Write-Host '  java не найдена в PATH: mcp-bsl-platform-context пропущен (нужен JDK 17+ или javaPath).' -ForegroundColor Yellow
        Write-BslLog 'mcp-bsl-platform-context: java не найдена, пропущен'
    }

    # 2. Jar: переиспользуем скачанный ранее, иначе качаем релиз
    if ($javaExe) {
        try {
            New-Item -ItemType Directory -Path $PlatformContextDir -Force | Out-Null
            $jarVersion = ''
            if ($PlatformContextVersion -and $PlatformContextVersion -ne 'latest') {
                $exactJar = Join-Path $PlatformContextDir ("mcp-bsl-context-$PlatformContextVersion.jar")
                $jarVersion = $PlatformContextVersion
                if (Test-Path -LiteralPath $exactJar) {
                    $contextJarPath = $exactJar
                }
            }
            else {
                $existingJar = Get-ChildItem -LiteralPath $PlatformContextDir -Filter 'mcp-bsl-context-*.jar' -ErrorAction SilentlyContinue |
                    Sort-Object Name -Descending | Select-Object -First 1
                if ($existingJar) {
                    $contextJarPath = $existingJar.FullName
                }
            }
            if (-not $contextJarPath) {
                if (-not $jarVersion) {
                    Write-Host '  Определяю последний релиз mcp-bsl-platform-context...' -ForegroundColor DarkGray
                    $releaseTag = (Invoke-RestMethod -Uri 'https://api.github.com/repos/alkoleft/mcp-bsl-platform-context/releases/latest' -TimeoutSec 60).tag_name
                    $jarVersion = $releaseTag.TrimStart('v')
                }
                $jarUrl = 'https://github.com/alkoleft/mcp-bsl-platform-context/releases/download/v' + $jarVersion + '/mcp-bsl-context-' + $jarVersion + '.jar'
                $contextJarPath = Join-Path $PlatformContextDir ("mcp-bsl-context-$jarVersion.jar")
                Write-Host "  Скачиваю $jarUrl (~42 МБ)..." -ForegroundColor Yellow
                Write-StepProgress -Step $Step -Detail "Скачивание jar $jarVersion (~42 МБ)"
                $prevProgress = $ProgressPreference
                $ProgressPreference = 'SilentlyContinue'
                try {
                    Invoke-WebRequest -Uri $jarUrl -OutFile $contextJarPath -TimeoutSec 600 -UseBasicParsing
                }
                finally {
                    $ProgressPreference = $prevProgress
                }
            }
            Write-Host "  Jar: $contextJarPath" -ForegroundColor Green
        }
        catch {
            Write-Host "  Установка mcp-bsl-platform-context не удалась: $_" -ForegroundColor Yellow
            Write-Host '  Продолжаю без справочного сервера.' -ForegroundColor Yellow
            Write-BslLog "mcp-bsl-platform-context: установка не удалась ($_)"
            $contextJarPath = $null
        }
    }

    # 3. kilo.json + USER-RULES.md
    if ($contextJarPath -and $javaExe) {
        Set-CoreKiloMcpEntry -ProjectRoot $ProjectRoot -ServerId 'bsl-platform-context' -Command @(
            $javaExe, '-Dfile.encoding=UTF-8', '-jar', $contextJarPath, '--platform-path', $PlatformDir
        )
        Add-CoreUserRulesBlock -ProjectRoot $ProjectRoot `
            -MarkerBegin '<!-- bsl-platform-context: deploy-new-1c-project managed block -->' `
            -MarkerEnd '<!-- end bsl-platform-context managed block -->' `
            -BlockTemplate @'

## bsl-platform-context - справка платформы 1С

Сервер {PLACEHOLDER} установлен развёртыванием этого проекта. Инструменты: search
(нечеткий поиск по API), info (детали функции/типа), getMember / getMembers
(методы и свойства типа), getConstructors (конструкторы). Прежде чем
использовать встроенную функцию, метод или свойство платформы 1С, сверяй
сигнатуру с этим сервером - не бери её из памяти модели. Для диагностики кода
проекта используй bsl-analyzer, для метаданных и данных базы - 1c-data-mcp.
'@ `
            -PlaceholderValue 'bsl-platform-context'
        Write-StepEvent -Step $Step -Phase 'success' -Detail "kilo.json (bsl-platform-context, jar: $contextJarPath) + USER-RULES.md"
        Write-Host '  Готово: .kilo/kilo.json (bsl-platform-context), USER-RULES.md.' -ForegroundColor Green
        Write-BslLog "mcp-bsl-platform-context: kilo.json (bsl-platform-context, jar: $contextJarPath, platform: $PlatformDir) + USER-RULES.md обновлены"
    }
    else {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail 'Jar или java недоступны — настройка пропущена'
    }
}
