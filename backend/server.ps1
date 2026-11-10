<#
Кабинет 1С-разверток: HTTP API + раздача статики (dist) без внешних модулей.
Свой TcpListener — то же, что внутри Pode, но без установки (decisions.md, D2/D9).
Слушает только 127.0.0.1, порт > 1024. Запуск:
  powershell -NoProfile -ExecutionPolicy Bypass -File backend\server.ps1 [-Port 8180]

API (D8, начальный состав):
  GET  /api/settings              — настройки (settings.json)
  PUT  /api/settings              — сохранить настройки
  POST /api/tools/check           — { path, kind: file|dir } -> { exists }
  POST /api/tools/detect          — { id } -> { found, path }   (автопоиск)
  POST /api/tools/browse          — { kind: file|dir } -> { found, path } (проводник)
  GET  /api/platforms             — { platforms: [ { version, binPath, ibcmdPath } ] }
  POST /api/deploy                — манифест визарда -> { runId, runDir, manifestPath }
#>
[CmdletBinding()]
param(
    [int]$Port = 8180,
    [string]$Address = '127.0.0.1',
    [switch]$NoOpenBrowser
)

$ErrorActionPreference = 'Stop'

$RepoRoot        = Split-Path -Parent $PSScriptRoot
$DistDir         = Join-Path $RepoRoot 'dist'
$DataDir         = Join-Path $env:LOCALAPPDATA '1c-deploy-cabinet'
$SettingsPath    = Join-Path $DataDir 'settings.json'
$UsersPath       = Join-Path $DataDir 'users.json'
# Корень реестра разверток — decisions.md, D7 (registry.json и runs/ рядом с базами)
$DeployRoot      = 'C:\1C_Bases\AI'
$PlatformRoot    = 'C:\Program Files\1cv8'

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Разрешение дочернему процессу стать передним планом (иначе диалог проводника,
# открытый фоновым процессом, Windows рисует под активными окнами)
Add-Type -Namespace Cabinet -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint dwProcessId);'
$ContentTypes = @{
    '.html'  = 'text/html; charset=utf-8'
    '.js'    = 'text/javascript; charset=utf-8'
    '.mjs'   = 'text/javascript; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.svg'   = 'image/svg+xml'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.ico'   = 'image/x-icon'
    '.json'  = 'application/json; charset=utf-8'
    '.woff2' = 'font/woff2'
    '.map'   = 'application/json; charset=utf-8'
}

function Get-StatusReason([int]$Code) {
    switch ($Code) {
        200 { 'OK' }
        400 { 'Bad Request' }
        404 { 'Not Found' }
        405 { 'Method Not Allowed' }
        500 { 'Internal Server Error' }
        default { 'OK' }
    }
}

function Send-Bytes {
    param($Stream, [int]$Code, [string]$ContentType, [byte[]]$BodyBytes)
    $head = "HTTP/1.1 $Code $(Get-StatusReason $Code)`r`nContent-Type: $ContentType`r`nContent-Length: $($BodyBytes.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n`r`n"
    $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
    $Stream.Write($headBytes, 0, $headBytes.Length)
    if ($BodyBytes.Length -gt 0) { $Stream.Write($BodyBytes, 0, $BodyBytes.Length) }
    $Stream.Flush()
}

function Send-JsonText {
    param($Stream, [int]$Code, [string]$Json)
    Send-Bytes $Stream $Code 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($Json))
}

function Send-Json {
    param($Stream, [int]$Code = 200, [object]$Value)
    Send-JsonText $Stream $Code (ConvertTo-Json -InputObject $Value -Depth 20 -Compress)
}

function ConvertFrom-JsonSafe {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    try { return ($Text | ConvertFrom-Json) } catch { return $null }
}

function Read-Request {
    param($Stream)
    $data = New-Object 'System.Collections.Generic.List[byte]'
    $buf = New-Object byte[] 65536
    $headerEnd = -1
    $contentLength = 0
    while ($true) {
        $read = $Stream.Read($buf, 0, $buf.Length)
        if ($read -le 0) { break }
        for ($i = 0; $i -lt $read; $i++) { $data.Add($buf[$i]) }
        if ($headerEnd -lt 0) {
            $probe = [System.Text.Encoding]::ASCII.GetString($data.ToArray())
            $idx = $probe.IndexOf("`r`n`r`n")
            if ($idx -ge 0) {
                $headerEnd = $idx + 4
                foreach ($line in ($probe.Substring(0, $idx) -split "`r`n")) {
                    if ($line -match '^\s*Content-Length\s*:\s*(\d+)\s*$') { $contentLength = [int]$Matches[1] }
                }
            }
        }
        if ($headerEnd -ge 0 -and (($data.Count - $headerEnd) -ge $contentLength)) { break }
    }
    if ($headerEnd -lt 0) { return $null }
    $all = $data.ToArray()
    $headText = [System.Text.Encoding]::ASCII.GetString($all, 0, $headerEnd)
    $bodyText = ''
    if ($all.Length -gt $headerEnd) {
        $bodyText = [System.Text.Encoding]::UTF8.GetString($all, $headerEnd, $all.Length - $headerEnd)
    }
    [pscustomobject]@{ Head = $headText; Body = $bodyText }
}

# ---------- настройки ----------

function Read-CabinetSettings {
    if (Test-Path -LiteralPath $SettingsPath -PathType Leaf) {
        try { return (Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
    }
    return $null
}

function Write-CabinetSettings {
    param([object]$Settings)
    if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
        New-Item -Path $DataDir -ItemType Directory -Force | Out-Null
    }
    $json = ConvertTo-Json -InputObject $Settings -Depth 20
    [System.IO.File]::WriteAllText($SettingsPath, $json, $Utf8NoBom)
}

# ---------- обнаружение ПО ----------

function Get-PlatformDirs {
    Get-ChildItem -LiteralPath $PlatformRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\1cv8.exe') -PathType Leaf } |
        Sort-Object { $v = [version]'0.0'; [void][version]::TryParse($_.Name, [ref]$v); $v } -Descending
}

function Find-ToolPath {
    param([string]$Id)
    $c = @()
    switch ($Id) {
        'vscode' {
            $c = @(Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe')
        }
        'git' {
            $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
            if ($cmd) { $c += $cmd.Source }
            $c += (Join-Path $env:ProgramFiles 'Git\bin\git.exe')
        }
        'platform1c' {
            $d = Get-PlatformDirs | Select-Object -First 1
            if ($d) { $c = @(Join-Path $d.FullName 'bin\1cv8.exe') }
        }
        'ibcmd' {
            $d = Get-PlatformDirs | Select-Object -First 1
            if ($d) { $c = @(Join-Path $d.FullName 'bin\ibcmd.exe') }
        }
        'apache' {
            $c = @('C:\1C_Bases\AI\tools\apache_portable\Apache24\bin\httpd.exe')
        }
        'java' {
            $cmd = Get-Command java.exe -ErrorAction SilentlyContinue
            if ($cmd) { $c += $cmd.Source }
            if ($env:JAVA_HOME) { $c += (Join-Path $env:JAVA_HOME 'bin\java.exe') }
        }
        'bslAnalyzer' {
            $c = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter '*.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'bsl' } |
                Select-Object -First 1 -ExpandProperty FullName)
        }
        default { $c = @() }
    }
    foreach ($p in $c) {
        if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) {
            return @{ found = $true; path = $p }
        }
    }
    return @{ found = $false; path = '' }
}

# Диалог выбора пути: браузер абсолютный путь не возвращает, открывает процесс сервера
# (кабинет локальный — сервер и браузер на одной машине). STA-дочерний powershell с
# browse-dialog.ps1: диалог TopMost (сторож-таймер поднимает окно наверх) и таймаут
# 2 минуты, чтобы не блокировать однопоточный сервер.
function Open-BrowseDialog {
    param([string]$Kind)
    $kindSafe = if ($Kind -eq 'dir') { 'dir' } else { 'file' }
    $tmp = [System.IO.Path]::GetTempFileName()
    $dialogScript = Join-Path $PSScriptRoot 'browse-dialog.ps1'
    $watchdogScript = Join-Path $PSScriptRoot 'dialog-watchdog.ps1'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -STA -NonInteractive -ExecutionPolicy Bypass -File `"$dialogScript`" -Kind $kindSafe -OutFile `"$tmp`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    # Дополнительно разрешаем дочернему процессу перехватить передний план
    [void][Cabinet.Native]::AllowSetForegroundWindow([uint32]$proc.Id)
    # Сторож: поднимает окно диалога наверх, если Windows оставил его под другими окнами
    $watchdogPsi = New-Object System.Diagnostics.ProcessStartInfo
    $watchdogPsi.FileName = 'powershell.exe'
    $watchdogPsi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dialogScript`" -TargetPid $($proc.Id) -TimeoutSec 60"
    $watchdogPsi.UseShellExecute = $false
    $watchdogPsi.CreateNoWindow = $true
    $watchdog = [System.Diagnostics.Process]::Start($watchdogPsi)
    $answered = $proc.WaitForExit(120000)
    try {
        if (-not $answered) {
            $proc.Kill()
            return @{ found = $false; path = '' }
        }
        $path = ''
        if (Test-Path -LiteralPath $tmp -PathType Leaf) {
            $path = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8).Trim()
        }
        if ($path) { return @{ found = $true; path = $path } }
        return @{ found = $false; path = '' }
    } finally {
        try {
            if ($watchdog -and -not $watchdog.HasExited) { $watchdog.Kill() }
        } catch { }
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
}

# ---------- деплой (манифест; исполнение шагов — runner.ps1, этап 0) ----------

function Invoke-DeployRoute {
    param($Stream, [string]$BodyText)
    $m = ConvertFrom-JsonSafe $BodyText
    if ($null -eq $m) {
        Send-Json $Stream 400 @{ errors = @('Тело запроса должно быть JSON-манифестом') }
        return
    }
    $errors = @()
    $name       = [string]$m.name
    $projectDir = [string]$m.projectDir
    $dtPath     = [string]$m.dtPath
    $platform   = [string]$m.platformVersion
    $dbUser     = [string]$m.dbUser
    $prefix     = [string]$m.prefix
    $apacheDir  = [string]$m.apacheDir

    if (-not $name.Trim())       { $errors += 'Не указано имя проекта' }
    if (-not $projectDir.Trim()) { $errors += 'Не указана папка проекта' }
    if (-not $dtPath.Trim())     { $errors += 'Не указан файл .dt' }
    elseif (-not (Test-Path -LiteralPath $dtPath -PathType Leaf)) { $errors += "Файл .dt не найден: $dtPath" }
    if (-not $platform.Trim())   { $errors += 'Не выбрана платформа' }
    if (-not $dbUser.Trim())     { $errors += 'Не указан пользователь ИБ' }
    if (-not $prefix.Trim())     { $errors += 'Не указан префикс' }

    $port = 0
    if (-not [int]::TryParse([string]$m.publishPort, [ref]$port)) {
        $errors += 'Порт публикации должен быть числом'
    } elseif ($port -le 1024 -or $port -gt 65535) {
        $errors += 'Порт публикации должен быть в диапазоне 1025–65535'
    }

    if (-not $apacheDir.Trim()) { $errors += 'Не указан каталог Apache' }
    elseif (-not (Test-Path -LiteralPath $apacheDir -PathType Container)) { $errors += "Каталог Apache не найден: $apacheDir" }

    if ($errors.Count -gt 0) {
        Send-Json $Stream 400 @{ errors = $errors }
        return
    }

    $runId = [guid]::NewGuid().ToString('N')
    $runDir = Join-Path $DeployRoot "runs\$runId"
    New-Item -Path $runDir -ItemType Directory -Force | Out-Null

    # Пароль ИБ в манифест не попадает (D7: секреты в открытом виде не храним, DPAPI — этап 0)
    $manifest = [ordered]@{
        name             = $name
        projectDir       = $projectDir
        templateDir      = [string]$m.templateDir
        dtPath           = $dtPath
        platformVersion  = $platform
        platformBinPath  = [string]$m.platformBinPath
        ibcmdPath        = [string]$m.ibcmdPath
        dbUser           = $dbUser
        dbPasswordStored = 'нет — пароль сохраняется отдельно (DPAPI, этап 0)'
        prefix           = $prefix
        publishPort      = $port
        apacheDir        = $apacheDir
        features         = [ordered]@{
            rulesAi         = [bool]$m.features.rulesAi
            bslAnalyzer     = [bool]$m.features.bslAnalyzer
            platformContext = [bool]$m.features.platformContext
        }
        createdAt        = (Get-Date).ToString('o')
    }
    $manifestPath = Join-Path $runDir 'manifest.json'
    [System.IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest -Depth 20), $Utf8NoBom)

    $evt = @{ ts = (Get-Date).ToString('o'); step = 'prepare'; phase = 'manifest-saved'; detail = $manifestPath } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText((Join-Path $runDir 'steps.jsonl'), $evt + "`r`n", $Utf8NoBom)

    Send-Json $Stream 200 @{ runId = $runId; runDir = $runDir; manifestPath = $manifestPath }
}

# ---------- статика ----------

function Send-StaticFile {
    param($Stream, [string]$UrlPath)
    $rel = if ([string]::IsNullOrEmpty($UrlPath) -or $UrlPath -eq '/') { 'index.html' } else { $UrlPath.TrimStart('/') }
    $distFull = [System.IO.Path]::GetFullPath($DistDir)
    $full = [System.IO.Path]::GetFullPath((Join-Path $DistDir $rel))
    if (-not $full.StartsWith($distFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Json $Stream 404 @{ error = 'not found' }
        return
    }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        # SPA-фолбэк: путь без расширения отдаем как index.html
        if ($rel -notmatch '\.[A-Za-z0-9]+$') {
            $full = Join-Path $DistDir 'index.html'
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            Send-Json $Stream 404 @{ error = 'dist не собран: npm.cmd run build' }
            return
        }
    }
    $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
    $ct = if ($ContentTypes.ContainsKey($ext)) { $ContentTypes[$ext] } else { 'application/octet-stream' }
    Send-Bytes $Stream 200 $ct ([System.IO.File]::ReadAllBytes($full))
}

function Test-CabinetPort {
    param([string]$Address, [int]$Port)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $tcp.BeginConnect($Address, $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(1500) -and $tcp.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        $tcp.Close()
    }
}

# ---------- пользователи кабинета (users.json; этап 1) ----------

function Read-CabinetUsers {
    if (Test-Path -LiteralPath $UsersPath -PathType Leaf) {
        try {
            $u = Get-Content -LiteralPath $UsersPath -Raw -Encoding UTF8 | ConvertFrom-Json
            return @($u)
        } catch { return @() }
    }
    return @()
}

function Write-CabinetUsers {
    param([object[]]$Users)
    if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
        New-Item -Path $DataDir -ItemType Directory -Force | Out-Null
    }
    $json = ConvertTo-Json -InputObject @($Users) -Depth 10
    [System.IO.File]::WriteAllText($UsersPath, $json, $Utf8NoBom)
}

# ---------- главный цикл ----------

Write-Host "[cabinet] API и статика: http://$Address`:$Port/  (dist: $DistDir)"
Write-Host "[cabinet] настройки: $SettingsPath"
Write-Host "[cabinet] пользователи: $UsersPath"

# --- порт: сначала пробуем занять; занят — проверяем, не наш ли кабинет там.
# Браузер открываем только после того, как сервер реально слушает порт.
$listener = $null
try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Address), $Port)
    $listener.Start()
} catch {
    if (Test-CabinetPort -Address $Address -Port $Port) {
        Write-Host "[cabinet] Кабинет уже запущен на http://$Address`:$Port/ — открыл в браузере, этот экземпляр завершается."
        if (-not $NoOpenBrowser) { Start-Process "http://$Address`:$Port/" }
        exit 0
    }
    Write-Host "[cabinet] Не удалось занять порт ${Port}: $($_.Exception.Message)"
    Write-Host "[cabinet] Порт занят другим приложением. Закройте его и запустите снова, либо укажите другой: -Port <номер>"
    exit 1
}

if (-not $NoOpenBrowser) {
    Start-Process "http://$Address`:$Port/"
}

while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $null
    try {
        $client.ReceiveTimeout = 15000
        $stream = $client.GetStream()
        $stream.ReadTimeout = 15000
        $req = Read-Request $stream
        if ($null -eq $req) { continue }

        $first = (($req.Head -split "`r`n")[0])
        $parts = $first -split ' '
        $method = if ($parts.Length -gt 0) { $parts[0].ToUpperInvariant() } else { '' }
        $url = if ($parts.Length -gt 1) { $parts[1] } else { '/' }
        $query = @{}
        $rawPath = ($url -split '\?')[0]
        if ($url.Contains('?')) {
            foreach ($pair in (($url -split '\?', 2)[1] -split '&')) {
                $kv = $pair -split '=', 2
                $key = [uri]::UnescapeDataString($kv[0])
                $value = ''
                if ($kv.Length -gt 1) { $value = [uri]::UnescapeDataString($kv[1]) }
                $query[$key] = $value
            }
        }
        $path = [uri]::UnescapeDataString($rawPath)

        Write-Host ("[cabinet] {0} {1}" -f $method, $path)

        if ($path.StartsWith('/api')) {
            if ($path -eq '/api/settings' -and $method -eq 'GET') {
                $s = Read-CabinetSettings
                if ($null -eq $s) { $s = [pscustomobject]@{ version = 1; tools = [pscustomobject]@{} } }
                Send-Json $Stream 200 $s
            }
            elseif ($path -eq '/api/settings' -and $method -eq 'PUT') {
                $body = ConvertFrom-JsonSafe $req.Body
                if ($null -eq $body) {
                    Send-Json $Stream 400 @{ error = 'Ожидался JSON' }
                } else {
                    Write-CabinetSettings $body
                    Send-Json $Stream 200 @{ ok = $true }
                }
            }
            elseif ($path -eq '/api/tools/check' -and $method -eq 'POST') {
                $body = ConvertFrom-JsonSafe $req.Body
                $p = [string]$body.path
                $kind = [string]$body.kind
                if ([string]::IsNullOrWhiteSpace($p)) {
                    Send-Json $Stream 200 @{ exists = $false }
                } else {
                    $pathType = if ($kind -eq 'dir') { 'Container' } else { 'Leaf' }
                    $exists = Test-Path -LiteralPath $p -PathType $pathType
                    Send-Json $Stream 200 @{ exists = [bool]$exists }
                }
            }
            elseif ($path -eq '/api/tools/detect' -and $method -eq 'POST') {
                $body = ConvertFrom-JsonSafe $req.Body
                Send-Json $Stream 200 (Find-ToolPath -Id ([string]$body.id))
            }
            elseif ($path -eq '/api/tools/browse' -and $method -eq 'POST') {
                $body = ConvertFrom-JsonSafe $req.Body
                Send-Json $Stream 200 (Open-BrowseDialog -Kind ([string]$body.kind))
            }
            elseif ($path -eq '/api/platforms' -and $method -eq 'GET') {
                $platforms = @(Get-PlatformDirs | ForEach-Object {
                    [pscustomobject]@{
                        version  = $_.Name
                        binPath  = (Join-Path $_.FullName 'bin\1cv8.exe')
                        ibcmdPath = (Join-Path $_.FullName 'bin\ibcmd.exe')
                    }
                })
                Send-Json $Stream 200 @{ platforms = $platforms }
            }
            elseif ($path -eq '/api/users' -and $method -eq 'GET') {
                $prefix = ([string]$query['prefix']).Trim().ToLower()
                $users = @(Read-CabinetUsers)
                if ($prefix) {
                    $users = @($users | Where-Object { $_.name -and $_.name.ToLower().Contains($prefix) })
                }
                Send-Json $Stream 200 @{ users = $users }
            }
            elseif ($path -eq '/api/login' -and $method -eq 'POST') {
                $body = ConvertFrom-JsonSafe $req.Body
                $name = ([string]$body.name).Trim()
                if (-not $name) {
                    Send-Json $Stream 400 @{ error = 'Не указано имя пользователя' }
                } else {
                    $users = @(Read-CabinetUsers)
                    $existing = $users | Where-Object { $_.name -ieq $name } | Select-Object -First 1
                    $isNew = $true
                    $now = (Get-Date).ToString('o')
                    if ($existing) {
                        $isNew = $false
                        $existing.lastLoginAt = $now
                    } else {
                        $users = @($users) + [pscustomobject]@{ name = $name; createdAt = $now; lastLoginAt = $now }
                    }
                    Write-CabinetUsers $users
                    Send-Json $Stream 200 @{ isNew = $isNew }
                }
            }
            elseif ($path -eq '/api/deploy' -and $method -eq 'POST') {
                Invoke-DeployRoute -Stream $Stream -BodyText $req.Body
            }
            else {
                Send-Json $Stream 404 @{ error = "unknown endpoint: $method $path" }
            }
        }
        else {
            if ($method -eq 'GET' -or $method -eq 'HEAD') {
                Send-StaticFile -Stream $Stream -UrlPath $path
            } else {
                Send-Json $Stream 405 @{ error = 'method not allowed' }
            }
        }
    }
    catch {
        Write-Host "[cabinet] ошибка запроса: $($_.Exception.Message)"
        try { if ($stream) { Send-JsonText $stream 500 '{"error":"internal"}' } } catch {}
    }
    finally {
        $client.Close()
    }
}
