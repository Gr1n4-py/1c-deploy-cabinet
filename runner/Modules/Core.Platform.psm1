# Core.Platform — поиск установленной платформы 1С и ibcmd.exe.
# Перенос Find-PlatformPath / Find-IbcmdPath без интерактива:
# версия берется из манифеста, иначе автодетект самой новой.

function Find-CorePlatform {
    param(
        [string]$PlatformPath = '',
        [string]$PlatformVersion = ''
    )
    if ($PlatformPath) {
        $leaf = Split-Path -Leaf $PlatformPath
        $version = if ($leaf -match '^\d+\.\d+\.\d+\.\d+$') { $leaf } else { $PlatformVersion }
        return [pscustomobject]@{ Path = $PlatformPath; Version = $version }
    }

    $root = 'C:\Program Files\1cv8'
    if (-not (Test-Path -LiteralPath $root)) {
        throw "Folder $root not found. Pass platformPath explicitly in the deploy manifest."
    }

    $candidates = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending

    if (-not $candidates) {
        throw "No installed platform found in $root. Pass platformPath explicitly in the deploy manifest."
    }

    $picked = $candidates[0]
    Write-Host "  Платформа (автодетект, самая новая): $($picked.Name)" -ForegroundColor Gray
    return [pscustomobject]@{ Path = $picked.FullName; Version = $picked.Name }
}

function Find-CoreIbcmd {
    param(
        [string]$IbcmdPath = '',
        [string]$PlatformDir = '',
        [string]$PlatformVersion = ''
    )
    if ($IbcmdPath) {
        if (-not (Test-Path -LiteralPath $IbcmdPath)) {
            throw "ibcmd.exe not found at $IbcmdPath. Pass ibcmdPath explicitly in the deploy manifest."
        }
        return $IbcmdPath
    }
    if (-not $PlatformDir) {
        throw "Cannot autodetect ibcmd.exe: platform version is unknown."
    }
    $ibcmd = Join-Path $PlatformDir 'bin\ibcmd.exe'
    if (-not (Test-Path -LiteralPath $ibcmd)) {
        throw "Автономный сервер ibcmd.exe не установлен для платформы $PlatformVersion по пути $ibcmd. Установите ibcmd.exe той же версии, что и платформа, или передайте ibcmdPath явно."
    }
    return $ibcmd
}
