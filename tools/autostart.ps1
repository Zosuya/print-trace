# 設定開機自動在背景待命（Windows）：登入後隱藏執行 server.mjs --with-slicer，
# 切片軟體開著才真的啟動，關掉就停止。
#   pwsh tools/autostart.ps1 install     安裝並立刻在背景啟動
#   pwsh tools/autostart.ps1 uninstall   移除並停止
#   pwsh tools/autostart.ps1 status      看狀態
param([ValidateSet('install', 'uninstall', 'status')] [string]$Action = 'status')

$root = Split-Path $PSScriptRoot -Parent
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'PRINT-TRACE.vbs'
$node = (Get-Command node -ErrorAction Stop).Source

function Stop-Server {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server\.mjs' -and $_.CommandLine -notmatch '--sim' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

switch ($Action) {
  'install' {
    # 用 VBScript 啟動才不會跳出黑色主控台視窗
    @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$root"
sh.Run """$node"" ""$root\server.mjs"" --with-slicer", 0, False
"@ | Set-Content $vbs -Encoding ascii
    Stop-Server
    Start-Process wscript.exe -ArgumentList "`"$vbs`""
    "已安裝：$vbs"
    "已在背景啟動，開 OrcaSlicer／Bambu Studio 後就會連印表機。紀錄：$root\cache\server.log"
  }
  'uninstall' {
    Remove-Item $vbs -ErrorAction SilentlyContinue
    Stop-Server
    "已移除開機啟動並停止背景程式"
  }
  'status' {
    "開機啟動：" + ($(if (Test-Path $vbs) { "已安裝（$vbs）" } else { '未安裝' }))
    $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server\.mjs' }
    "背景程式：" + ($(if ($p) { "執行中（PID $($p.ProcessId -join ', ')）" } else { '沒有在跑' }))
  }
}
