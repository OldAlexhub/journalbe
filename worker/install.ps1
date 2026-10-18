$ErrorActionPreference = 'Stop'
$ServerRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $ServerRoot 'scripts\prepare-worker.js')
if ($LASTEXITCODE -ne 0) { throw 'Text worker setup failed.' }
