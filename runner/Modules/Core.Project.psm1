# Core.Project — структура проекта, копирование эталона, .dev.env / env.json.
# Перенос разделов 2-4 скрипта без интерактива: непустая папка проекта
# обрабатывается по флагу манифеста allowNonEmptyProjectDir.

function Initialize-CoreProject {
    param(
        [string]$ProjectDir,
        [string]$TemplateDir,
        [switch]$AllowNonEmpty
    )
    Test-PathOrFail -Path $TemplateDir -What 'Эталонный проект'
    Test-PathOrFail -Path (Join-Path $TemplateDir '.kilo')   -What 'Эталон: папка .kilo\ не найдена'
    Test-PathOrFail -Path (Join-Path $TemplateDir 'env.json') -What 'Эталон: env.json не найден'

    if (Test-Path -LiteralPath $ProjectDir) {
        $items = Get-ChildItem -LiteralPath $ProjectDir -Force | Where-Object { $_.Name -ne 'fk_deploy_log.bsl' }
        if ($items.Count -gt 0) {
            if (-not $AllowNonEmpty) {
                throw ("Папка проекта НЕ пуста: {0}. Разрешите перезапись (allowNonEmptyProjectDir в манифесте) или укажите другую папку." -f $ProjectDir)
            }
            Write-Host "  ПРЕДУПРЕЖДЕНИЕ: папка проекта НЕ пуста, шаблон будет перезаписан: $ProjectDir" -ForegroundColor Yellow
        }
    }
    else {
        New-Item -ItemType Directory -Path $ProjectDir -Force | Out-Null
        Write-Host "  Created: $ProjectDir" -ForegroundColor Green
    }
}

# Копирование эталонных файлов: env.json, packagedef, .kilo/*, tools/mcp-1c.
function Copy-CoreTemplateFiles {
    param([string]$ProjectDir, [string]$TemplateDir)

    Copy-Item -Path (Join-Path $TemplateDir 'env.json')  -Destination (Join-Path $ProjectDir 'env.json')  -Force
    $packagedefSrc = Join-Path $TemplateDir 'packagedef'
    if (Test-Path -LiteralPath $packagedefSrc) {
        Copy-Item -Path $packagedefSrc -Destination (Join-Path $ProjectDir 'packagedef') -Force
    }
    $kiloDir = Join-Path $ProjectDir '.kilo'
    if (-not (Test-Path -LiteralPath $kiloDir)) {
        New-Item -ItemType Directory -Path $kiloDir -Force | Out-Null
    }
    foreach ($name in @('kilo.json', 'kilo.jsonc', '.gitignore')) {
        $src = Join-Path $TemplateDir ".kilo\$name"
        if (Test-Path -LiteralPath $src) {
            Copy-Item -Path $src -Destination (Join-Path $kiloDir $name) -Force
        }
    }
    $mcp1cSrc = Join-Path $TemplateDir 'mcp-1c'
    if (Test-Path -LiteralPath $mcp1cSrc) {
        $toolsDir = Join-Path $ProjectDir 'tools'
        if (-not (Test-Path -LiteralPath $toolsDir)) {
            New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
        }
        Copy-Item -Path $mcp1cSrc -Destination $toolsDir -Recurse -Force
        Write-Host '  Скопировано: mcp-1c -> tools/mcp-1c' -ForegroundColor Green
    }
    Write-Host '  Скопировано: env.json, packagedef, .kilo/*, tools/mcp-1c' -ForegroundColor Green
    Write-BslLog 'Скопированы файлы шаблона: env.json, packagedef, .kilo/*, tools/mcp-1c'
}

# Структура каталогов проекта (перенос раздела 5).
function New-CoreProjectStructure {
    param([string]$ProjectDir)
    $structureDirs = @(
        '.1cpt', 'build', 'docs', 'examples', 'features',
        'fixtures', 'lib', 'openspec', 'oscript_modules',
        'src', 'src\epf', 'tasks', 'tests', 'tools', 'vendor'
    )
    foreach ($d in $structureDirs) {
        $p = Join-Path $ProjectDir $d
        if (-not (Test-Path -LiteralPath $p)) {
            New-Item -ItemType Directory -Path $p -Force | Out-Null
        }
    }
    Write-Host "  Создано: $($structureDirs -join ', ')" -ForegroundColor Green
}

# Патч .dev.env значениями манифеста (перенос раздела 4).
function Set-CoreDevEnv {
    param(
        [string]$ProjectDir,
        [string]$TemplateDir,
        [string]$PlatformDir,
        [string]$PlatformVersion,
        [string]$IbPath,
        [string]$IbKind,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$Prefix,
        [string]$NewObjectsIn
    )
    $devEnvPath = Join-Path $ProjectDir '.dev.env'
    if (Test-Path -LiteralPath $devEnvPath) {
        Write-Host '  .dev.env already exists, patching key values' -ForegroundColor DarkGray
    }
    else {
        Copy-Item -Path (Join-Path $TemplateDir '.dev.env') -Destination $devEnvPath -Force
        Write-Host "  Created: $devEnvPath" -ForegroundColor Green
    }

    Set-DevEnvValue -Path $devEnvPath -Key 'PLATFORM_PATH'   -Value $PlatformDir
    if ($PlatformVersion) {
        Set-DevEnvValue -Path $devEnvPath -Key 'PLATFORM_VERSION' -Value $PlatformVersion
    }
    Set-DevEnvValue -Path $devEnvPath -Key 'INFOBASE_PATH'   -Value $IbPath
    Set-DevEnvValue -Path $devEnvPath -Key 'INFOBASE_KIND'   -Value $IbKind
    Set-DevEnvValue -Path $devEnvPath -Key 'IB_USER'         -Value $DbUser
    Set-DevEnvValue -Path $devEnvPath -Key 'IB_PASSWORD'     -Value $DbPassword
    Set-DevEnvValue -Path $devEnvPath -Key 'EXPORT_PATH'     -Value 'src\cf'
    Set-DevEnvValue -Path $devEnvPath -Key 'EXTENSIONS_PATH' -Value 'src\cfe'
    Set-DevEnvValue -Path $devEnvPath -Key 'PREFIX'          -Value $Prefix
    Set-DevEnvValue -Path $devEnvPath -Key 'NEW_OBJECTS_IN'  -Value $NewObjectsIn
    Write-Host '  Обновлено: .dev.env (PLATFORM_*, INFOBASE_*, IB_*, EXPORT_*, PREFIX, NEW_OBJECTS_IN)' -ForegroundColor Green
    Write-BslLog 'Обновлен .dev.env'
}

# Патч env.json профиля default (перенос раздела 4, файловая ИБ; серверный
# вариант соединения добавляется в части 2 вместе с дескриптором ИБ).
function Set-CoreEnvJson {
    param(
        [string]$ProjectDir,
        [string]$IbPath,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$PlatformVersion
    )
    $envJsonPath = Join-Path $ProjectDir 'env.json'
    $ibConnValue = '/F"' + $IbPath + '"'
    Set-EnvJsonValue -Path $envJsonPath -Key '--ibconnection' -Value $ibConnValue
    Set-EnvJsonValue -Path $envJsonPath -Key '--db-user'      -Value $DbUser
    Set-EnvJsonValue -Path $envJsonPath -Key '--db-pwd'       -Value $DbPassword
    if ($PlatformVersion) {
        $shortVer = ($PlatformVersion -split '\.')[0..2] -join '.'
        Set-EnvJsonValue -Path $envJsonPath -Key '--v8version' -Value $shortVer
    }
    Set-EnvJsonValue -Path $envJsonPath -Key '--root'      -Value '.'
    Set-EnvJsonValue -Path $envJsonPath -Key '--workspace' -Value '.'
    Write-Host '  Обновлено: env.json --ibconnection / --db-user / --v8version / --root' -ForegroundColor Green
    Write-BslLog 'Обновлен env.json'
}
