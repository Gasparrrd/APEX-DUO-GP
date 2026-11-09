# launch.ps1 — Lanceur autonome d'APEX DUO GP
$ErrorActionPreference = 'SilentlyContinue'
$gameDir = $PSScriptRoot
$port = 8765
$url = "http://127.0.0.1:$port/index.html?v=6"

# Vérifie instantanément si le port 8765 est déjà ouvert
$isListening = $false
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $iar = $tcp.BeginConnect("127.0.0.1", $port, $null, $null)
  if ($iar.AsyncWaitHandle.WaitOne(200, $false) -and $tcp.Connected) {
    $isListening = $true
  }
  $tcp.Close()
} catch {}

if (-not $isListening) {
  Start-Process -FilePath "python" -ArgumentList "server.py" -WorkingDirectory $gameDir -WindowStyle Hidden
  Start-Sleep -Milliseconds 450
}

# Ouvre le jeu en mode application plein écran (sans onglets ni barre d'adresse)
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if (Test-Path $chrome) {
  Start-Process -FilePath $chrome -ArgumentList "--app=$url --start-maximized"
} elseif (Test-Path $edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$url --start-maximized"
} else {
  Start-Process $url
}
