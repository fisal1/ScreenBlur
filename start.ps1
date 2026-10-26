# Runs npm scripts. Uses Node.js from PATH if installed, otherwise a portable copy in tools\node
# (downloaded on first run).
# Usage: .\start.ps1            -> npm start
#        .\start.ps1 verbose    -> npm run verbose (logs every result)
#        .\start.ps1 selftest   -> npm run selftest
#        .\start.ps1 test       -> npm test
param([string]$Script = 'start')

$ErrorActionPreference = 'Stop'
$NodeVersion = 'v24.22.1'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$portableNode = Join-Path $root 'tools\node'
Set-Location $root

function Install-PortableNode {
    $name = "node-$NodeVersion-win-x64"
    $zip = Join-Path $env:TEMP "$name.zip"
    Write-Host "Node.js not found. Downloading portable Node.js $NodeVersion..."
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/$name.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath (Join-Path $root 'tools') -Force
    Rename-Item (Join-Path $root "tools\$name") 'node'
    Remove-Item $zip
}

if (Test-Path "$portableNode\node.exe") {
    $env:Path = "$portableNode;$env:Path"
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Install-PortableNode
    $env:Path = "$portableNode;$env:Path"
}

if (-not (Test-Path "$root\node_modules")) { npm install }
# npm may block dependency install scripts, so fetch the Electron binary and model explicitly.
if (-not (Test-Path "$root\node_modules\electron\dist\electron.exe")) { node "$root\node_modules\electron\install.js" }
if (-not (Test-Path "$root\models\320n.onnx")) { node "$root\scripts\fetch-model.js" }
if ($Script -eq 'start' -or $Script -eq 'test') { npm $Script } else { npm run $Script }
