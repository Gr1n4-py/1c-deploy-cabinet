# Core.Publish — веб-публикация файловой ИБ через portable Apache 2.4.
# Перенос раздела «Публикация ИБ»: патч httpd.conf, блок публикации в
# conf/1c-publications.conf, default.vrd, перезапуск httpd, проверка ответа.

function Convert-ToApachePath {
    param([string]$Path)
    return $Path -replace '\\', '/'
}

# Перезаписывает блок '# project: <id>' / '# end project: <id>' в include-файле
# Apache (перенос Set-ApachePublicationBlock). Идемпотентно.
function Set-ApachePublicationBlock {
    param(
        [string]$FilePath,
        [string]$BlockId,
        [string]$BlockText
    )
    $begin = '# project: ' + $BlockId
    $end = '# end project: ' + $BlockId
    $content = ''
    if (Test-Path -LiteralPath $FilePath) {
        $content = [System.IO.File]::ReadAllText($FilePath)
    }
    $pattern = [regex]::Escape($begin) + '[\s\S]*?' + [regex]::Escape($end)
    $m = [regex]::Match($content, $pattern)
    if ($m.Success) {
        $content = $content.Remove($m.Index, $m.Length)
    }
    $content = $content.TrimEnd("`r", "`n")
    if ($content) {
        $content = $content + "`r`n`r`n"
    }
    $content = $content + $begin + "`r`n" + $BlockText + "`r`n" + $end + "`r`n"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FilePath, $content, $utf8)
}

# Публикует файловую ИБ: возвращает URL публикации. Бросает исключение при
# ошибках (неинтерактивный режим). Перенос раздела публикации.
function Publish-CoreApache {
    param(
        [string]$ApacheDir,
        [int]$PublishPort,
        [string]$ProjectDir,
        [string]$IbPath,
        [string]$PlatformDir,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$DevEnvPath,
        [string]$Step = '08-publish'
    )
    $httpdExe = Join-Path $ApacheDir 'bin\httpd.exe'
    if (-not (Test-Path -LiteralPath $ApacheDir)) {
        throw "Apache portable не найден: $ApacheDir"
    }
    if (-not (Test-Path -LiteralPath $httpdExe)) {
        throw "httpd.exe не найден: $httpdExe. Проверьте apacheDir в манифесте."
    }

    # URL-safe виртуальный каталог из имени папки проекта
    $vdirName = (Split-Path -Leaf $ProjectDir) -replace '[^A-Za-z0-9_\-]', '_'
    $publishDir = Join-Path $ProjectDir 'build\publish'
    New-Item -ItemType Directory -Path $publishDir -Force | Out-Null
    $publishDirFwd = Convert-ToApachePath $publishDir
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    $wsapDll = Join-Path $PlatformDir 'bin\wsap24.dll'
    if (-not (Test-Path -LiteralPath $wsapDll)) {
        throw "Модуль веб-сервера 1С wsap24.dll не найден: $wsapDll"
    }

    # 1. httpd.conf: SRVROOT, Listen, ServerName, управляемый блок модуля 1С
    $httpdConf = Join-Path $ApacheDir 'conf\httpd.conf'
    $confText = [System.IO.File]::ReadAllText($httpdConf)
    $srvRootFwd = Convert-ToApachePath $ApacheDir
    $confText = [regex]::Replace($confText, '(?m)^(\s*Define\s+SRVROOT\s+)"[^"]*"', ('${1}"' + $srvRootFwd + '"'))
    $confText = [regex]::Replace($confText, '(?m)^(\s*Listen\s+)\S+', ('${1}' + $PublishPort))
    if ($confText -notmatch '(?m)^\s*ServerName\s+\S') {
        $confText = [regex]::Replace($confText, '(?m)^(\s*Listen\s+\S+)$', ('${1}' + "`r`n" + 'ServerName localhost:' + $PublishPort))
    }
    $wsapFwd = Convert-ToApachePath $wsapDll
    $cMarkerBegin = '# === 1C web publication module (managed by deploy-new-1c-project script)'
    $cMarkerEnd = '# === end 1C web publication module ==='
    $cBlock = $cMarkerBegin + "`r`n" +
        'LoadModule _1cws_module "' + $wsapFwd + '"' + "`r`n" +
        'Include conf/1c-publications.conf' + "`r`n" +
        $cMarkerEnd
    $cm = [regex]::Match($confText, [regex]::Escape($cMarkerBegin) + '[\s\S]*?' + [regex]::Escape($cMarkerEnd))
    if ($cm.Success) {
        $confText = $confText.Remove($cm.Index, $cm.Length)
    }
    $confText = $confText.TrimEnd("`r", "`n") + "`r`n`r`n" + $cBlock + "`r`n"
    [System.IO.File]::WriteAllText($httpdConf, $confText, $utf8NoBom)
    Write-Host "  httpd.conf обновлен: SRVROOT / Listen $PublishPort / ServerName / wsap24" -ForegroundColor Green

    # 2. Блок публикации: один Apache обслуживает несколько баз
    $pubConf = Join-Path $ApacheDir 'conf\1c-publications.conf'
    $pubBlockText =
        'Alias "/' + $vdirName + '" "' + $publishDirFwd + '/"' + "`r`n" +
        '<Directory "' + $publishDirFwd + '/">' + "`r`n" +
        '    AllowOverride All' + "`r`n" +
        '    Options None' + "`r`n" +
        '    Require all granted' + "`r`n" +
        '    SetHandler 1c-application' + "`r`n" +
        '    ManagedApplicationDescriptor "' + $publishDirFwd + '/default.vrd"' + "`r`n" +
        '</Directory>'
    Set-ApachePublicationBlock -FilePath $pubConf -BlockId $vdirName -BlockText $pubBlockText
    Write-Host "  Публикация /$vdirName добавлена в conf/1c-publications.conf" -ForegroundColor Green

    # 3. default.vrd: HTTP-сервисы публикуются по умолчанию (включая расширения);
    #    при наличии пользователя ИБ серверные учетные данные — Usr/Pwd внутри ib
    $vrdPath = Join-Path $publishDir 'default.vrd'
    $ibAttr = 'File=&quot;' + $IbPath + '&quot;;'
    $authLine = ''
    if ($DbUser) {
        $escUser = [System.Security.SecurityElement]::Escape($DbUser)
        $escPwd = [System.Security.SecurityElement]::Escape($DbPassword)
        $authLine = 'Usr=&quot;' + $escUser + '&quot;;Pwd=&quot;' + $escPwd + '&quot;;'
    }
    $vrdText = @"
<?xml version="1.0" encoding="UTF-8"?>
<point xmlns="http://v8.1c.ru/8.2/virtual-resource-system"
       xmlns:xs="http://www.w3.org/2001/XMLSchema"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       base="/$vdirName"
       ib="$ibAttr$authLine">
    <httpServices publishByDefault="true" publishExtensionsByDefault="true"/>
    <ws enable="true" pointEnableCommon="true"/>
</point>
"@
    [System.IO.File]::WriteAllText($vrdPath, $vrdText, $utf8NoBom)
    Write-Host "  default.vrd создан: $vrdPath" -ForegroundColor Green

    # 4. Перезапуск Apache: останов только экземпляров этой portable-копии,
    #    запуск httpd.exe в собственном консольном окне
    $running = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'httpd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like ($ApacheDir + '*')) })
    foreach ($p in $running) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($running.Count -gt 0) {
        Start-Sleep -Seconds 2
        Write-Host "  Остановлен предыдущий Apache portable (процессов: $($running.Count))" -ForegroundColor DarkGray
    }

    $portBusy = $null
    try {
        $portBusy = Get-NetTCPConnection -LocalPort $PublishPort -State Listen -ErrorAction Stop | Select-Object -First 1
    }
    catch { }
    if ($portBusy) {
        throw "Порт $PublishPort уже занят другим процессом (PID $($portBusy.OwningProcess)). Укажите другой publishPort."
    }

    Write-Host "  Запускаю Apache: $httpdExe (порт $PublishPort)" -ForegroundColor Yellow
    # WorkingDirectory — каталог bin Apache: иначе httpd наследует рабочий
    # каталог кабинета и блокирует пересборку exe (EBUSY)
    $apacheProc = Start-Process -FilePath $httpdExe -WorkingDirectory (Join-Path $ApacheDir 'bin') -PassThru
    Start-Sleep -Seconds 3
    $apacheErrorLog = Join-Path $ApacheDir 'logs\error_log'
    if ($apacheProc.HasExited) {
        $tail = (Get-Content -LiteralPath $apacheErrorLog -Tail 20 -ErrorAction SilentlyContinue) -join ' | '
        throw "httpd.exe завершился с кодом $($apacheProc.ExitCode). Подробности в $apacheErrorLog. Хвост: $tail"
    }

    # 5. Проверка цепочки Apache -> wsap24 -> ИБ -> HTTP-сервис.
    #    4xx тоже считается успехом маршрутизации.
    $publishUrl = 'http://localhost:' + $PublishPort + '/' + $vdirName
    $probeUrl = $publishUrl + '/hs/mcp-1c/version'
    $probeCode = 0
    try {
        $resp = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 30 -Method Get
        $probeCode = [int]$resp.StatusCode
    }
    catch {
        if ($_.Exception.Response) {
            $probeCode = [int]$_.Exception.Response.StatusCode
        }
    }

    if ($probeCode -lt 200 -or $probeCode -ge 500) {
        $tail = (Get-Content -LiteralPath $apacheErrorLog -Tail 30 -ErrorAction SilentlyContinue) -join ' | '
        throw "Веб-публикация не отвечает: $probeUrl (код $probeCode). Хвост error_log: $tail"
    }

    Write-Host "  Публикация отвечает: $probeUrl (HTTP $probeCode)" -ForegroundColor Green
    $webClientUrl = $publishUrl + '/ru_RU/'
    Write-Host "  Вход в базу через браузер: $webClientUrl" -ForegroundColor Green
    Write-BslLog "Веб-публикация: $publishUrl (vdir /$vdirName, порт $PublishPort, Apache: $ApacheDir)"
    Write-BslLog "HTTP-сервис MCP: $probeUrl"

    Set-DevEnvValue -Path $DevEnvPath -Key 'INFOBASE_PUBLISH_URL' -Value $publishUrl
    Write-Host '  Обновлено: .dev.env INFOBASE_PUBLISH_URL' -ForegroundColor Green

    return [pscustomobject]@{
        PublishUrl   = $publishUrl
        WebClientUrl = $webClientUrl
        Vdir         = $vdirName
    }
}
