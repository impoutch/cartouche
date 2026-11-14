// Gestion de la fenêtre du jeu sous Windows (via PowerShell, sans module natif) :
//  - double appui sur Échap dans le jeu → la fenêtre est réduite (le jeu se met en pause)
//  - « Revenir au jeu » et « Fermer le jeu » depuis Cartouche
// Échap n'est jamais « volé » aux autres programmes : on observe seulement le clavier,
// et uniquement quand la fenêtre du jeu est au premier plan.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const isWin = process.platform === 'win32';

const USER32 = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
`;

const WATCHER = `param([int]$TargetPid)
${USER32}
$p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $p) { exit }
$last = 0; $down = $false
while (-not $p.HasExited) {
  $isDown = ([W]::GetAsyncKeyState(0x1B) -band 0x8000) -ne 0
  if ($isDown -and -not $down) {
    $fg = [W]::GetForegroundWindow(); [uint32]$fp = 0
    [void][W]::GetWindowThreadProcessId($fg, [ref]$fp)
    if ($fp -eq $TargetPid) {
      $now = [Environment]::TickCount
      if (($now - $last) -lt 500) { [void][W]::ShowWindow($fg, 6); $last = 0 } else { $last = $now }
    }
  }
  $down = $isDown
  Start-Sleep -Milliseconds 25
}
`;

function scriptPath(name, content) {
  const file = path.join(app.getPath('userData'), name);
  fs.writeFileSync(file, content);
  return file;
}

function powershell(args, opts = {}) {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { windowsHide: true, stdio: 'ignore', ...opts });
}

// Démarre la surveillance du double Échap pour ce processus. Renvoie une fonction d'arrêt.
function watchEscape(pid) {
  if (!isWin) return () => {};
  try {
    const p = powershell(['-File', scriptPath('fenetre-echap.ps1', WATCHER), '-TargetPid', String(pid)]);
    p.on('error', () => {});
    return () => { try { p.kill(); } catch { /* déjà arrêté */ } };
  } catch { return () => {}; }
}

function runInline(code) {
  return new Promise((resolve) => {
    if (!isWin) return resolve(false);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', code],
      { windowsHide: true }, (err) => resolve(!err));
  });
}

// Ramène la fenêtre du jeu au premier plan
const restore = (pid) => runInline(`${USER32}
$h = (Get-Process -Id ${Number(pid)}).MainWindowHandle
[void][W]::ShowWindow($h, 9); [void][W]::SetForegroundWindow($h)`);

// Ferme proprement le jeu (comme la petite croix : la sauvegarde est bien écrite)
const close = (pid) => runInline(`$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
if ($p) { [void]$p.CloseMainWindow() }`);

module.exports = { watchEscape, restore, close };
