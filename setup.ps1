#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'EquicordImprovements'),
    [ValidateSet('auto', 'stable', 'canary', 'ptb')][string]$Channel = 'auto',
    [string]$DiscordPath,
    [switch]$DetectOnly,
    [switch]$PrepareOnly,
    [switch]$NoLaunch,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Refresh-SetupPath {
    $parts = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        $env:Path
    )
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}

# A tool can be installed but missing from this window's PATH (installed after the window opened,
# or installed for one user while PowerShell runs as another). Look in the usual install folders.
function Find-SetupTool([string]$Executable) {
    Refresh-SetupPath
    if (Get-Command $Executable -ErrorAction SilentlyContinue) { return $true }
    $folders = switch ($Executable) {
        'git.exe' { @("$env:ProgramFiles\Git\cmd", "${env:ProgramFiles(x86)}\Git\cmd", "$env:LOCALAPPDATA\Programs\Git\cmd") }
        'node.exe' { @("$env:ProgramFiles\nodejs", "${env:ProgramFiles(x86)}\nodejs", "$env:LOCALAPPDATA\Programs\nodejs") }
        default { @() }
    }
    foreach ($folder in $folders) {
        if ($folder -and (Test-Path -LiteralPath (Join-Path $folder $Executable))) {
            $env:Path = "$folder;$env:Path"
            return $true
        }
    }
    return $false
}

function Install-SetupPrerequisite([string]$PackageId, [string]$Executable) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js LTS from https://nodejs.org and Git from https://git-scm.com, then rerun this script. Windows Package Manager was not found.'
    }
    Write-Host "Installing $PackageId..."
    & winget.exe install --id $PackageId --exact --source winget --silent --accept-package-agreements --accept-source-agreements
    # -1978335189: already installed, no newer version. -1978335135: already installed.
    $alreadyInstalled = $LASTEXITCODE -in @(-1978335189, -1978335135)
    if ($LASTEXITCODE -notin @(0, 3010) -and -not $alreadyInstalled) { throw "Could not install $PackageId. Exit code: $LASTEXITCODE" }
    if (-not (Find-SetupTool $Executable)) {
        if ($alreadyInstalled) { throw "$PackageId is installed, but $Executable was not found. Open a new PowerShell window and run setup again." }
        throw "$PackageId was installed, but $Executable is not available yet. Open a new PowerShell window and run setup again."
    }
}

try {
    if (-not (Find-SetupTool 'git.exe')) {
        if ($DetectOnly) { throw 'Detection requires Node.js and Git. Run setup without -DetectOnly to install missing prerequisites.' }
        Install-SetupPrerequisite 'Git.Git' 'git.exe'
    }
    $nodeReady = $false
    if (Find-SetupTool 'node.exe') {
        $nodeVersion = & node.exe -p 'process.versions.node'
        $nodeReady = ([version]$nodeVersion -ge [version]'22.12.0')
    }
    if (-not $nodeReady) {
        if ($DetectOnly) { throw 'Detection requires Node.js 22.12 or newer. Run setup without -DetectOnly to install missing prerequisites.' }
        Install-SetupPrerequisite 'OpenJS.NodeJS.LTS' 'node.exe'
    }
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        throw 'Node.js or Git is still unavailable. Open a new PowerShell window and run setup again.'
    }

    $repository = $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $repository 'setup.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $repository '.git'))) {
        $repository = Join-Path $InstallDirectory 'repository'
        if (-not (Test-Path -LiteralPath $repository)) {
            New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
            & git.exe clone --depth 1 https://github.com/lsstomas/equicord-improvements.git $repository
            if ($LASTEXITCODE -ne 0) { throw 'Could not download equicord-improvements.' }
        } else {
            $origin = & git.exe -C $repository remote get-url origin
            if ($LASTEXITCODE -ne 0 -or $origin -ne 'https://github.com/lsstomas/equicord-improvements.git') { throw 'The setup repository folder belongs to a different repository.' }
            $changes = & git.exe -C $repository status --porcelain
            if ($LASTEXITCODE -ne 0 -or $changes) { throw 'The setup repository has local changes. Keep them safe before updating that folder.' }
            & git.exe -C $repository pull --ff-only
            if ($LASTEXITCODE -ne 0) { throw 'Could not update equicord-improvements.' }
        }
    }

    $setupArgs = @((Join-Path $repository 'setup.mjs'), '--root', $InstallDirectory, '--channel', $Channel)
    if ($DiscordPath) { $setupArgs += @('--discord-path', $DiscordPath) }
    if ($DetectOnly) { $setupArgs += '--detect-only' }
    if ($PrepareOnly) { $setupArgs += '--prepare-only' }
    if ($NoLaunch) { $setupArgs += '--no-launch' }
    if ($Yes) { $setupArgs += '--yes' }
    & node.exe @setupArgs
    if ($LASTEXITCODE -ne 0) { throw 'Setup did not complete. Check the error above.' }
} catch {
    Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
