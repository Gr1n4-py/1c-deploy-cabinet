# Core.Mcp — установка расширения MCP_HTTPService и конфигурация .kilo/kilo.json.
# Перенос раздела «Установка расширения MCP_HTTPService» и kilo.json-хелперов.

# Добавляет одну local-запись MCP-сервера в .kilo/kilo.json (перенос
# Add-KiloLocalMcpEntry). Идемпотентно: повторный вызов обновляет запись.
function Set-CoreKiloMcpEntry {
    param(
        [string]$ProjectRoot,
        [string]$ServerId,
        [string[]]$Command,
        [int]$TimeoutMs = 60000
    )
    $kiloJsonPath = Join-Path $ProjectRoot '.kilo\kilo.json'
    $root = $null
    if (Test-Path -LiteralPath $kiloJsonPath) {
        try { $root = Get-Content -LiteralPath $kiloJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $root = $null }
    }
    if ($null -eq $root) {
        $root = New-Object System.Management.Automation.PSCustomObject
    }
    if (-not $root.PSObject.Properties['mcp']) {
        $root | Add-Member -NotePropertyName 'mcp' -NotePropertyValue (New-Object System.Management.Automation.PSCustomObject)
    }
    $mcpObj = $root.PSObject.Properties['mcp'].Value
    $entry = [pscustomobject]@{
        type    = 'local'
        command = $Command
        enabled = $true
        timeout = $TimeoutMs
    }
    if ($mcpObj.PSObject.Properties[$ServerId]) {
        $mcpObj.PSObject.Properties[$ServerId].Value = $entry
    }
    else {
        $mcpObj | Add-Member -NotePropertyName $ServerId -NotePropertyValue $entry
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($kiloJsonPath, ($root | ConvertTo-Json -Depth 20), $utf8NoBom)
}

# 1c-data-mcp -> локальный stdio-прокси mcp-1c.exe -base <url>/hs/mcp-1c
# [--dump src\cf]. Перенос Set-KiloDataMcpLocal. Идемпотентно.
function Set-CoreKiloDataMcpLocal {
    param(
        [string]$ProjectRoot,
        [string]$McpExePath,
        [string]$ServiceBaseUrl,
        [string]$DumpPath = ''
    )
    $kiloJsonPath = Join-Path $ProjectRoot '.kilo\kilo.json'
    $root = $null
    if (Test-Path -LiteralPath $kiloJsonPath) {
        try { $root = Get-Content -LiteralPath $kiloJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $root = $null }
    }
    if ($null -eq $root) {
        $root = New-Object System.Management.Automation.PSCustomObject
    }
    if (-not $root.PSObject.Properties['mcp']) {
        $root | Add-Member -NotePropertyName 'mcp' -NotePropertyValue (New-Object System.Management.Automation.PSCustomObject)
    }
    $command = @($McpExePath, '-base', $ServiceBaseUrl)
    if ($DumpPath -and (Test-Path -LiteralPath (Join-Path $DumpPath 'Configuration.xml'))) {
        $command += @('--dump', $DumpPath)
    }
    $entry = [pscustomobject]@{
        type    = 'local'
        command = $command
        enabled = $true
        timeout = 30000
    }
    $mcpObj = $root.PSObject.Properties['mcp'].Value
    if ($mcpObj.PSObject.Properties['1c-data-mcp']) {
        $mcpObj.PSObject.Properties['1c-data-mcp'].Value = $entry
    }
    else {
        $mcpObj | Add-Member -NotePropertyName '1c-data-mcp' -NotePropertyValue $entry
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($kiloJsonPath, ($root | ConvertTo-Json -Depth 20), $utf8NoBom)
}

# Отключает (enabled=false) MCP-серверы каталога ai_rules_1c, которые этот
# деплой не ставит (docker-образы на портах 8000-8008). Перенос
# Disable-KiloMcpServers. Идемпотентно.
function Disable-CoreKiloMcpServers {
    param(
        [string]$ProjectRoot,
        [string[]]$KeepServerIds
    )
    $kiloJsonPath = Join-Path $ProjectRoot '.kilo\kilo.json'
    if (-not (Test-Path -LiteralPath $kiloJsonPath)) { return }
    $root = $null
    try { $root = Get-Content -LiteralPath $kiloJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return }
    if ($null -eq $root -or -not $root.PSObject.Properties['mcp']) { return }
    $mcpObj = $root.PSObject.Properties['mcp'].Value
    $changed = $false
    foreach ($prop in $mcpObj.PSObject.Properties) {
        if ($prop.Name -notin $KeepServerIds -and $mcpObj.($prop.Name).enabled -ne $false) {
            $mcpObj.($prop.Name).enabled = $false
            $changed = $true
        }
    }
    if ($changed) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($kiloJsonPath, ($root | ConvertTo-Json -Depth 20), $utf8NoBom)
    }
}

# Устанавливает расширение MCP_HTTPService: mcp-1c -install (через Конфигуратор,
# объявляет MCP_ОсновнаяРоль ролью по умолчанию) + снятие безопасного режима
# через ibcmd config extension update. Перенос раздела установки. Пропускается,
# если tools/mcp-1c неполон.
function Install-CoreMcpExtension {
    param(
        [string]$IbPath,
        [string]$ProjectDir,
        [string]$PlatformDir,
        [string]$Ibcmd,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$Step = '06-mcp-ext'
    )
    $mcpCfePath = Join-Path $ProjectDir 'tools\mcp-1c\MCP_HTTPService.cfe'
    $mcpCliPath = Join-Path $ProjectDir 'tools\mcp-1c\mcp-1c.exe'
    if (-not (Test-Path -LiteralPath $mcpCfePath)) {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail "Файл расширения не найден: $mcpCfePath"
        Write-Host "  Файл расширения не найден: $mcpCfePath — установка пропущена." -ForegroundColor Yellow
        Write-BslLog 'Расширение MCP_HTTPService не установлено: файл tools/mcp-1c/MCP_HTTPService.cfe не найден'
        return
    }
    if (-not (Test-Path -LiteralPath $mcpCliPath)) {
        Write-StepEvent -Step $Step -Phase 'skipped' -Detail "Установщик не найден: $mcpCliPath"
        Write-Host "  Установщик не найден: $mcpCliPath — установка пропущена." -ForegroundColor Yellow
        Write-BslLog 'Расширение MCP_HTTPService не установлено: файл tools/mcp-1c/mcp-1c.exe не найден'
        return
    }

    $mcpExtName = [System.IO.Path]::GetFileNameWithoutExtension($mcpCfePath)
    $mcpLogDir = Join-Path $ProjectDir 'build'
    if (-not (Test-Path -LiteralPath $mcpLogDir)) {
        New-Item -ItemType Directory -Path $mcpLogDir -Force | Out-Null
    }

    $designerExe = Join-Path $PlatformDir 'bin\1cv8.exe'
    $installArgs = @('-install', $IbPath, '-platform', $designerExe)
    if ($DbUser) {
        $installArgs += '-db-user'
        $installArgs += $DbUser
        if ($DbPassword) {
            $installArgs += '-db-password'
            $installArgs += $DbPassword
        }
    }
    Write-Host "  Устанавливаю расширение $mcpExtName из $mcpCfePath (через Конфигуратор)" -ForegroundColor Yellow
    Invoke-CoreIbcmd -Ibcmd $mcpCliPath -Arguments $installArgs `
        -LogPath (Join-Path $mcpLogDir 'mcp-cfe-install.log') `
        -Title 'Установка расширения MCP_HTTPService' `
        -ErrorLabel 'mcp-1c -install (расширение MCP_HTTPService)' -Step $Step

    # HTTP-сервис должен выполняться вне безопасного режима и без защиты от
    # опасных действий. Подрежим config extension update (топ-уровневый
    # extension update 8.5.1 не принимает --user/--password).
    Write-Host "  Снимаю безопасный режим и защиту от опасных действий расширения $mcpExtName" -ForegroundColor Yellow
    $safeArgs = @('config', 'extension', 'update', ('--db-path=' + $IbPath))
    if ($DbUser) {
        $safeArgs += '--user=' + $DbUser
        if ($DbPassword) {
            $safeArgs += '--password=' + $DbPassword
        }
    }
    $safeArgs += @(('--name=' + $mcpExtName), '--safe-mode=no', '--unsafe-action-protection=no')
    Invoke-CoreIbcmd -Ibcmd $Ibcmd -Arguments $safeArgs `
        -LogPath (Join-Path $mcpLogDir 'mcp-safe-mode-off.log') `
        -Title 'Снятие безопасного режима MCP_HTTPService' `
        -ErrorLabel 'ibcmd config extension update --safe-mode=no (расширение MCP_HTTPService)' -Step $Step

    Write-StepEvent -Step $Step -Phase 'success' -Detail "Расширение $mcpExtName установлено и применено"
    Write-Host "  Расширение $mcpExtName установлено и применено." -ForegroundColor Green
    Write-BslLog "Установлено и применено расширение $mcpExtName из tools/mcp-1c (mcp-1c -install)"
}
