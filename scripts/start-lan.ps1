param(
  [int]$Port = 3100
)

$ErrorActionPreference = 'Stop'
$env:PORT = $Port
$env:NODE_ENV = 'development'
# Empty APP_ORIGIN makes same-origin checks follow the host used by the phone.
$env:APP_ORIGIN = ''

Write-Host "NEXUS ARENA LAN mode: http://<电脑局域网IP>:$Port"
Write-Host '手机和电脑需要连接同一个 Wi-Fi；不要使用 localhost。'
node server.js
