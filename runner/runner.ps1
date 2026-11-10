<#
runner.ps1 — исполнитель пайплайна развертки кабинета (этап 0).
Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File runner\runner.ps1 -Manifest <путь к manifest.json>

Читает манифест деплоя, исполняет шаги ядра (Modules/Core-*), пишет события
в <runDir>\steps.jsonl и итоговый статус в <runDir>\state.json.
Часть 1 (этап 0): платформа → проект → конфиги → ИБ из .dt → блокировки →
дампы cf/cfe → публикация. Шаги MCP-конфига, правил и инструментов — часть 2.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$runnerDir = $PSScriptRoot

Get-ChildItem -LiteralPath (Join-Path $runnerDir 'Modules') -Filter '*.psm1' | ForEach-Object {
    Import-Module $_.FullName -DisableNameChecking
}

# ---------- манифест ----------

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Манифест не найден: $ManifestPath"
}
$m = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-ManifestValue {
    param([string]$Key, $Default = '')
    $v = $m.PSObject.Properties[$Key]
    if ($null -eq $v -or $null -eq $v.Value) { return $Default }
    if ([string]::IsNullOrWhiteSpace([string]$v.Value)) { return $Default }
    return $v.Value
}

function Get-ManifestFlag {
    param([string]$Key, [bool]$Default = $false)
    $v = $m.PSObject.Properties[$Key]
    if ($null -eq $v -or $null -eq $v.Value) { return $Default }
    return [bool]$v.Value
}

$runDir     = [string](Get-ManifestValue 'runDir')
if (-not $runDir) { throw "В манифесте не задан runDir (его создает POST /api/deploy)." }

$name            = [string](Get-ManifestValue 'name')
$projectDir      = [string](Get-ManifestValue 'projectDir')
$templateDir     = [string](Get-ManifestValue 'templateDir')
$dtPath          = [string](Get-ManifestValue 'dtPath')
$templateCfPath  = [string](Get-ManifestValue 'templateCfPath')
$platformPath    = [string](Get-ManifestValue 'platformPath')
$ibcmdPath       = [string](Get-ManifestValue 'ibcmdPath')
$prefix          = [string](Get-ManifestValue 'prefix' 'ФК_')
$newObjectsIn    = [string](Get-ManifestValue 'newObjectsIn' 'extension')
$apacheDir       = [string](Get-ManifestValue 'apacheDir')
$publishPort     = [int](Get-ManifestValue 'publishPort' '8080')
$rulesSource     = [string](Get-ManifestValue 'rulesSource' 'https://github.com/comol/ai_rules_1c')
$rulesCacheDir   = [string](Get-ManifestValue 'rulesCacheDir' 'C:\1C_Bases\AI\tools\ai_rules_1c')
$skipRulesUpdate = Get-ManifestFlag 'skipRulesUpdate'
$bslAnalyzerDir  = [string](Get-ManifestValue 'bslAnalyzerDir' (Join-Path $env:LOCALAPPDATA 'Programs\bsl-analyzer'))
$bslAnalyzerVer  = [string](Get-ManifestValue 'bslAnalyzerVersion')
$skipBslAnalyzer = Get-ManifestFlag 'skipBslAnalyzer'
$javaPath        = [string](Get-ManifestValue 'javaPath')
$platformCtxDir  = [string](Get-ManifestValue 'platformContextDir' 'C:\1C_Bases\AI\tools\mcp-bsl-context')
$platformCtxVer  = [string](Get-ManifestValue 'platformContextVersion' 'latest')
$skipPlatformCtx = Get-ManifestFlag 'skipPlatformContext'
$allowNonEmpty   = Get-ManifestFlag 'allowNonEmptyProjectDir'
$locksWaitSec    = [int](Get-ManifestValue 'locksWaitSec' '120')
$noUsers         = Get-ManifestFlag 'noUsers'
$skipPublish     = Get-ManifestFlag 'skipPublish'

# Пароль ИБ: в манифесте визарда отсутствует (DPAPI — этап 0);
# для полностью автоматических прогонов допускается поле dbPassword.
$dbUser     = [string](Get-ManifestValue 'dbUser' 'Admin')
$dbPassword = [string](Get-ManifestValue 'dbPassword')
if ($noUsers) { $dbUser = ''; $dbPassword = '' }

# ---------- события и состояние ----------

$stepsLogPath = Join-Path $runDir 'steps.jsonl'
$statePath    = Join-Path $runDir 'state.json'
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

$script:StepsState = @{}
$script:Results = @{}

Set-StepEventSink -Sink {
    param($e)
    $line = [pscustomobject]@{
        ts     = $e.ts
        step   = $e.step
        phase  = $e.phase
        detail = $e.detail
    } | ConvertTo-Json -Compress
    Add-Content -LiteralPath $script:StepsLogPath -Value $line -Encoding UTF8
}

function Save-State {
    param([string]$Status, [string]$Current = '', [string]$Error = '')
    $stateObj = [pscustomobject]@{
        runId      = [string](Get-ManifestValue 'runId')
        status     = $Status
        currentStep = $Current
        error      = $Error
        startedAt  = [string](Get-ManifestValue 'createdAt')
        finishedAt = (Get-Date).ToString('o')
        steps      = $script:StepsState
    }
    $json = $stateObj | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($statePath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-Step {
    param([string]$Id, [string]$Title, [scriptblock]$Action)
    Write-StepEvent -Step $Id -Phase 'start' -Detail $Title
    Save-State -Status 'running' -Current $Id
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action
        Write-StepEvent -Step $Id -Phase 'success' -Detail ("готово за " + $sw.Elapsed.ToString('mm\:ss'))
        $script:StepsState[$Id] = 'success'
    }
    catch {
        $script:StepsState[$Id] = 'error'
        Write-StepEvent -Step $Id -Phase 'error' -Detail $_.Exception.Message
        Save-State -Status 'error' -Current $Id -Error $_.Exception.Message
        throw
    }
}

# ---------- пайплайн ----------

try {
    Save-State -Status 'running'

    Invoke-Step '00-validate' 'Проверка манифеста' {
        Test-PathOrFail -Path $templateDir -What 'templateDir'
        Test-PathOrFail -Path (Join-Path $templateDir '.kilo') -What 'templateDir: папка .kilo\ не найдена'
        Test-PathOrFail -Path (Join-Path $templateDir 'env.json') -What 'templateDir: env.json не найден'
        # Источник базы: .dt (выгрузка/шаблон с demo-dt) ИЛИ 1Cv8.cf шаблона конфигурации (D13)
        if ($dtPath) {
            Test-PathOrFail -Path $dtPath -What 'dtPath'
        }
        elseif ($templateCfPath) {
            Test-PathOrFail -Path $templateCfPath -What 'templateCfPath'
        }
        else {
            throw 'Не задан источник базы: dtPath или templateCfPath'
        }
        if (-not $projectDir) { throw 'Не задан projectDir' }
        if (-not $apacheDir) { throw 'Не задан apacheDir' }
        if ($publishPort -le 1024 -or $publishPort -gt 65535) { throw "publishPort должен быть в диапазоне 1025–65535 ($publishPort)" }
        if (-not $name) { throw 'Не задано name' }
    }

    Invoke-Step '01-platform' 'Определение платформы и ibcmd' {
        $platform = Find-CorePlatform -PlatformPath $platformPath -PlatformVersion ([string](Get-ManifestValue 'platformVersion'))
        $script:PlatformDir    = $platform.Path
        $script:PlatformVer    = $platform.Version
        $script:Ibcmd          = Find-CoreIbcmd -IbcmdPath $ibcmdPath -PlatformDir $script:PlatformDir -PlatformVersion $script:PlatformVer
        Write-StepEvent -Step '01-platform' -Phase 'progress' -Detail "Платформа: $($script:PlatformDir) (версия $($script:PlatformVer)); ibcmd: $($script:Ibcmd)"
    }

    Invoke-Step '02-project' 'Создание проекта и копирование эталона' {
        Set-BslLogPath -Path (Join-Path $projectDir 'fk_deploy_log.bsl')
        Initialize-CoreProject -ProjectDir $projectDir -TemplateDir $templateDir -AllowNonEmpty:$allowNonEmpty
        Write-BslLog "Начало развёртывания: ProjectDir=$projectDir, runId=$(Get-ManifestValue 'runId')"
        Copy-CoreTemplateFiles -ProjectDir $projectDir -TemplateDir $templateDir
        New-CoreProjectStructure -ProjectDir $projectDir
    }

    Invoke-Step '03-config' 'Конфигурация .dev.env и env.json' {
        $ibPath = Join-Path $projectDir 'build\ib'
        $script:IbPath = $ibPath
        Set-CoreDevEnv -ProjectDir $projectDir -TemplateDir $templateDir `
            -PlatformDir $script:PlatformDir -PlatformVersion $script:PlatformVer `
            -IbPath $ibPath -IbKind 'file' -DbUser $dbUser -DbPassword $dbPassword `
            -Prefix $prefix -NewObjectsIn $newObjectsIn
        Set-CoreEnvJson -ProjectDir $projectDir -IbPath $ibPath -DbUser $dbUser -DbPassword $dbPassword -PlatformVersion $script:PlatformVer
    }

    Invoke-Step '04-ib-create' 'Создание ИБ' {
        if ($dtPath) {
            New-CoreInfobaseFromDt -Ibcmd $script:Ibcmd -IbPath $script:IbPath -DtPath $dtPath -ProjectDir $projectDir
        }
        else {
            New-CoreInfobaseFromCf -Ibcmd $script:Ibcmd -IbPath $script:IbPath -CfPath $templateCfPath -ProjectDir $projectDir
        }
    }

    Invoke-Step '05-locks' 'Проверка блокировок ИБ' {
        Assert-CoreIbFree -IbPath $script:IbPath -Step '05-locks' -MaxWaitSec $locksWaitSec
    }

    Invoke-Step '06-mcp-ext' 'Установка расширения MCP_HTTPService' {
        Install-CoreMcpExtension -IbPath $script:IbPath -ProjectDir $projectDir `
            -PlatformDir $script:PlatformDir -Ibcmd $script:Ibcmd `
            -DbUser $dbUser -DbPassword $dbPassword -Step '06-mcp-ext'
    }

    Invoke-Step '07-cf-dump' 'Выгрузка основной конфигурации (src/cf)' {
        Export-CoreCf -Ibcmd $script:Ibcmd -IbPath $script:IbPath -ProjectDir $projectDir -DbUser $dbUser -DbPassword $dbPassword
    }

    Invoke-Step '08-cfe-dump' 'Выгрузка расширений (src/cfe)' {
        Export-CoreCfe -Ibcmd $script:Ibcmd -IbPath $script:IbPath -ProjectDir $projectDir -DbUser $dbUser -DbPassword $dbPassword
    }

    if ($skipPublish) {
        Write-StepEvent -Step '09-publish' -Phase 'skipped' -Detail 'skipPublish задан (например, серверная ИБ, публикация выполнена администратором)'
        $script:StepsState['09-publish'] = 'skipped'
        $script:PublishUrl = ''
        $devEnvPath = Join-Path $projectDir '.dev.env'
    }
    else {
        Invoke-Step '09-publish' 'Публикация ИБ (Apache portable)' {
            $devEnvPath = Join-Path $projectDir '.dev.env'
            $r = Publish-CoreApache -ApacheDir $apacheDir -PublishPort $publishPort `
                -ProjectDir $projectDir -IbPath $script:IbPath -PlatformDir $script:PlatformDir `
                -DbUser $dbUser -DbPassword $dbPassword -DevEnvPath $devEnvPath -Step '09-publish'
            $script:PublishUrl = $r.PublishUrl
        }
    }

    Invoke-Step '10-rules' 'Установка правил AI-агента (ai_rules_1c)' {
        Install-CoreRules -ProjectDir $projectDir -RulesSource $rulesSource `
            -RulesCacheDir $rulesCacheDir -SkipRulesUpdate:$skipRulesUpdate -Step '10-rules'
    }

    Invoke-Step '11-bsl-analyzer' 'Установка и настройка bsl-analyzer' {
        Install-CoreBslAnalyzer -ProjectDir $projectDir -ProjectRoot $projectDir `
            -BslAnalyzerDir $bslAnalyzerDir -BslAnalyzerVersion $bslAnalyzerVer `
            -SkipBslAnalyzer:$skipBslAnalyzer -Step '11-bsl-analyzer'
    }

    Invoke-Step '12-platform-context' 'Установка mcp-bsl-platform-context' {
        Install-CorePlatformContext -ProjectDir $projectDir -ProjectRoot $projectDir `
            -PlatformDir $script:PlatformDir -JavaPath $javaPath `
            -PlatformContextDir $platformCtxDir -PlatformContextVersion $platformCtxVer `
            -SkipPlatformContext:$skipPlatformCtx -Step '12-platform-context'
    }

    Invoke-Step '13-mcp-config' 'Конфигурация MCP-серверов (.kilo/kilo.json)' {
        $mcpExePath = Join-Path $projectDir 'tools\mcp-1c\mcp-1c.exe'
        if ($script:PublishUrl -and (Test-Path -LiteralPath $mcpExePath)) {
            Set-CoreKiloDataMcpLocal -ProjectRoot $projectDir `
                -McpExePath $mcpExePath `
                -ServiceBaseUrl ($script:PublishUrl + '/hs/mcp-1c') `
                -DumpPath (Join-Path $projectDir 'src\cf')
            Disable-CoreKiloMcpServers -ProjectRoot $projectDir -KeepServerIds @(
                '1c-data-mcp', 'bsl-analyzer-workspace', 'bsl-analyzer-reference', 'bsl-platform-context'
            )
            Write-StepEvent -Step '13-mcp-config' -Phase 'progress' -Detail '1c-data-mcp переведен на локальный stdio-прокси, докер-серверы каталога отключены'
            Write-Host '  Обновлено: .kilo/kilo.json — 1c-data-mcp переведен на локальный stdio-прокси, докер-серверы каталога отключены' -ForegroundColor Green
            Write-BslLog 'MCP-конфиг: 1c-data-mcp -> local stdio; докер-серверы каталога отключены'
        }
        elseif (-not $script:PublishUrl) {
            Write-StepEvent -Step '13-mcp-config' -Phase 'skipped' -Detail 'Нет веб-публикации — 1c-data-mcp оставлен как есть (работать не будет)'
            Write-Host '  Публикация не настроена — 1c-data-mcp оставлен как есть и работать не будет.' -ForegroundColor Yellow
            Write-BslLog 'MCP-конфиг: 1c-data-mcp НЕ исправлен (нет веб-публикации)'
        }
        else {
            Write-StepEvent -Step '13-mcp-config' -Phase 'skipped' -Detail "Прокси не найден: $mcpExePath"
            Write-Host "  Прокси не найден: $mcpExePath — 1c-data-mcp оставлен как есть." -ForegroundColor Yellow
            Write-BslLog 'MCP-конфиг: 1c-data-mcp НЕ исправлен (tools/mcp-1c/mcp-1c.exe не найден)'
        }
    }

    Write-BslLog 'Развертка контура для разработки завершена (runner, часть 1 этапа 0)'

    # Реестр проектов (D7): добавляем/обновляем запись о проекте
    $registryPath = Join-Path 'C:\1C_Bases\AI' 'registry.json'
    $registry = $null
    try { $registry = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $registry = $null }
    if ($null -eq $registry) { $registry = [pscustomobject]@{ projects = @() } }
    if (-not $registry.PSObject.Properties['projects']) {
        $registry | Add-Member -NotePropertyName 'projects' -NotePropertyValue @()
    }
    $projects = @($registry.projects)
    $existing = $projects | Where-Object { $_.projectDir -ieq $projectDir } | Select-Object -First 1
    $now = (Get-Date).ToString('o')
    if ($existing) {
        $existing.publishUrl = [string]$script:PublishUrl
        $existing.lastDeployAt = $now
    }
    else {
        $entry = [pscustomobject]@{
            name        = $name
            projectDir  = $projectDir
            createdAt   = $now
            lastDeployAt = $now
            publishUrl  = [string]$script:PublishUrl
        }
        $registry.projects = @($projects) + $entry
    }
    $regJson = $registry | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($registryPath, $regJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-StepEvent -Step 'registry' -Phase 'success' -Detail "Проект зарегистрирован: $projectDir"

    Save-State -Status 'success'
    Write-Host ''
    Write-Host "  Прогон завершен успешно. Project: $projectDir" -ForegroundColor Green
    if ($script:PublishUrl) {
        Write-Host "  Publish: $($script:PublishUrl)" -ForegroundColor Green
    }
    exit 0
}
catch {
    $msg = $_.Exception.Message
    Save-State -Status 'error' -Error $msg
    Write-Host ''
    Write-Host "  РАЗВЕРТКА ПРЕРВАНА: $msg" -ForegroundColor Red
    exit 1
}
