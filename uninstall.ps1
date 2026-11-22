$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/pi-mnemonic-install.mjs') --uninstall @args
exit $LASTEXITCODE
