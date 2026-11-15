// GameCube : on utilise le vrai Dolphin (plus fiable que la version intégrée à RetroArch).
// Cartouche le télécharge depuis le site officiel et l'installe en mode « portable »
// dans son propre dossier : ses réglages et les cartes mémoire restent avec lui.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const FALLBACK = 'https://dl.dolphin-emu.org/releases/2603a/dolphin-2603a-x64.7z';
const root = () => path.join(app.getPath('userData'), 'dolphin');

function findExe(dir = root(), depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'dolphin.exe');
  if (hit) return path.join(dir, hit.name);
  if (depth >= 2) return null;
  for (const e of entries) if (e.isDirectory()) { const r = findExe(path.join(dir, e.name), depth + 1); if (r) return r; }
  return null;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Cartouche' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => resolve(t));
    }).on('error', reject).setTimeout(20000, function () { this.destroy(new Error('délai dépassé')); });
  });
}

// Dernière version officielle (« release ») pour Windows x64
async function latestUrl() {
  try {
    const html = await fetchText('https://dolphin-emu.org/download/');
    const m = /https:\/\/dl\.dolphin-emu\.org\/releases\/([0-9]{4}[a-z]?)\/dolphin-\1-x64\.7z/.exec(html);
    if (m) return m[0];
  } catch { /* site injoignable : version connue */ }
  return FALLBACK;
}

// Raccourcis clavier de Dolphin : on retire « Échap = arrêter » (Échap ×2 sert à réduire le jeu)
// et on aligne les sauvegardes rapides sur celles de RetroArch (F2 / F4).
function writeHotkeys(exe) {
  const file = path.join(path.dirname(exe), 'User', 'Config', 'Hotkeys.ini');
  if (fs.existsSync(file)) return; // on ne touche pas aux réglages de l'utilisateur
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '[Hotkeys]',
    'Device = DInput/0/Keyboard Mouse',
    'General/Toggle Pause = F10',
    'General/Toggle Fullscreen = @(Alt+RETURN)',
    'Save State/Save State Slot 1 = F2',
    'Load State/Load State Slot 1 = F4',
    '',
  ].join('\r\n'));
}

async function install(progress) {
  // Outils de téléchargement et de décompression partagés avec l'installation de RetroArch
  const { download, sevenZip, extract7z } = require('./installer');
  progress('Recherche de la dernière version de Dolphin (GameCube)…', null);
  const url = await latestUrl();
  const archive = path.join(app.getPath('temp'), 'Cartouche-Dolphin.7z');
  await download(url, archive, (d, t) =>
    progress(`Téléchargement de Dolphin (GameCube)… (${Math.round(d / 1e6)} Mo${t ? ' / ' + Math.round(t / 1e6) + ' Mo' : ''})`, t ? d / t : null));
  progress('Décompression de Dolphin…', null);
  const tmp = root() + '-tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  await extract7z(await sevenZip(progress), archive, tmp);
  fs.rmSync(archive, { force: true });
  fs.rmSync(root(), { recursive: true, force: true });
  fs.renameSync(tmp, root());
  const exe = findExe();
  if (!exe) throw new Error('Dolphin a été téléchargé, mais Dolphin.exe est introuvable.');
  fs.writeFileSync(path.join(path.dirname(exe), 'portable.txt'), ''); // réglages rangés à côté de Dolphin
  writeHotkeys(exe);
  return exe;
}

// Codes de langue de la GameCube dans Dolphin
const GC_LANG = { en: 0, de: 1, fr: 2, es: 3, it: 4, nl: 5 };

function launch(exe, gamePath, { fullscreen, volume, language }) {
  writeHotkeys(exe);
  const args = ['-b', '-e', gamePath,
    '-C', `Dolphin.Display.Fullscreen=${fullscreen ? 'True' : 'False'}`,
    '-C', 'Dolphin.Interface.ConfirmStop=False',
    '-C', `Dolphin.DSP.Volume=${Math.max(0, Math.min(100, Math.round(volume)))}`];
  if (GC_LANG[language] !== undefined) args.push('-C', `Dolphin.Core.SelectedLanguage=${GC_LANG[language]}`);
  return spawn(exe, args, { cwd: path.dirname(exe), detached: false });
}

// Ouvre Dolphin seul, pour régler manettes et graphismes
function openSettings() {
  const exe = findExe();
  if (!exe) return false;
  spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = { findExe: () => findExe(), install, launch, openSettings };
