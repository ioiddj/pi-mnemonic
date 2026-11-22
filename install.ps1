$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/pi-mnemonic-install.mjs') @args
exit $LASTEXITCODE
