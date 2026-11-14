// Cartouche — processus principal (Electron)
// Rôle : fenêtre, réglages, scan des jeux, lancement de RetroArch avec le bon cœur.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { installAll } = require('./installer');

// ---------- Consoles prises en charge ----------
const GB_CORES = ['sameboy_libretro.dll', 'gambatte_libretro.dll', 'mgba_libretro.dll'];
const SYSTEMS = {
  gb:  { label: 'Game Boy',       ext: ['.gb'],          thumbs: 'Nintendo - Game Boy',       cores: GB_CORES },
  gbc: { label: 'Game Boy Color', ext: ['.gbc'],         thumbs: 'Nintendo - Game Boy Color', cores: GB_CORES },
  nds: { label: 'Nintendo DS',    ext: ['.nds', '.dsi'], thumbs: 'Nintendo - Nintendo DS',
         cores: ['melondsds_libretro.dll', 'melonds_libretro.dll', 'desmume_libretro.dll'] },
};

// Emplacements habituels de RetroArch sous Windows (détection automatique)
function defaultRetroArchCandidates() {
  const env = process.env;
  return [
    'C:\\RetroArch-Win64\\retroarch.exe',
    'C:\\RetroArch\\retroarch.exe',
    env.APPDATA && path.join(env.APPDATA, 'RetroArch', 'retroarch.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'RetroArch', 'retroarch.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Steam', 'steamapps', 'common', 'RetroArch', 'retroarch.exe'),
  ].filter(Boolean);
}

// ---------- Réglages (sauvegardés dans un fichier JSON) ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = { retroarch: '', gamesDirs: [], fullscreen: true, favorites: [], recent: {} };

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch { /* premier lancement */ }
  if (!cfg.retroarch) {
    const found = defaultRetroArchCandidates().find(p => fs.existsSync(p));
    if (found) { cfg.retroarch = found; saveConfig(cfg); }
  }
  return cfg;
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
let config;

// ---------- Scan des jeux ----------
function systemForFile(file) {
  const ext = path.extname(file).toLowerCase();
  return Object.keys(SYSTEMS).find(k => SYSTEMS[k].ext.includes(ext));
}
function scanDir(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4) scanDir(full, depth + 1, out); continue; }
    const system = systemForFile(e.name);
    if (system) {
      const raw = e.name.slice(0, -path.extname(e.name).length);
      out.push({ path: full, raw, system, thumbs: SYSTEMS[system].thumbs });
    }
  }
}

// ---------- Cœurs (moteurs) ----------
function coresDir() { return config.retroarch ? path.join(path.dirname(config.retroarch), 'cores') : ''; }
function findCore(system) {
  const dir = coresDir();
  if (!dir) return null;
  return SYSTEMS[system].cores.find(c => fs.existsSync(path.join(dir, c))) || null;
}

// ---------- Fenêtre ----------
let win;
let running = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#0e0f14', title: 'Cartouche', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  config = loadConfig();

  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, partial) => { config = { ...config, ...partial }; saveConfig(config); return config; });

  ipcMain.handle('dialog:retroarch', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Où se trouve retroarch.exe ?', properties: ['openFile'],
      filters: [{ name: 'RetroArch', extensions: ['exe'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:gamesDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisis ton dossier de jeux', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('games:scan', () => {
    const out = [];
    for (const d of config.gamesDirs) scanDir(d, 0, out);
    return out.sort((a, b) => a.raw.localeCompare(b.raw, 'fr'));
  });

  ipcMain.handle('cores:status', () => {
    const status = { retroarchOk: !!config.retroarch && fs.existsSync(config.retroarch) };
    for (const k of Object.keys(SYSTEMS)) status[k] = status.retroarchOk ? findCore(k) : null;
    return status;
  });

  ipcMain.handle('game:launch', (_e, gamePath, system) => {
    if (running) return { ok: false, error: 'Un jeu est déjà ouvert. Ferme-le d’abord.' };
    if (!config.retroarch || !fs.existsSync(config.retroarch)) return { ok: false, error: 'RetroArch introuvable. Vérifie les réglages.' };
    const core = findCore(system);
    if (!core) return { ok: false, error: `Aucun moteur installé pour ${SYSTEMS[system].label}. Va dans Réglages pour voir comment l’installer.` };
    const args = ['-L', path.join(coresDir(), core), gamePath];
    if (config.fullscreen) args.push('-f');
    try {
      running = spawn(config.retroarch, args, { cwd: path.dirname(config.retroarch), detached: false });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    config.recent[gamePath] = Date.now();
    saveConfig(config);
    running.on('exit', () => { running = null; if (win && !win.isDestroyed()) { win.webContents.send('game:exited'); win.show(); } });
    running.on('error', (err) => { running = null; if (win && !win.isDestroyed()) win.webContents.send('game:error', String(err.message || err)); });
    return { ok: true, core };
  });

  // Ouvre RetroArch seul (pour installer les moteurs ou régler les manettes)
  ipcMain.handle('retroarch:open', () => {
    if (!config.retroarch || !fs.existsSync(config.retroarch)) return false;
    spawn(config.retroarch, [], { cwd: path.dirname(config.retroarch), detached: true, stdio: 'ignore' }).unref();
    return true;
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  // Installation automatique de RetroArch + moteurs
  let installing = false;
  ipcMain.handle('setup:install', async () => {
    if (installing) return { ok: false, error: 'Installation déjà en cours.' };
    installing = true;
    try {
      const send = (label, frac) => win && !win.isDestroyed() && win.webContents.send('setup:progress', { label, frac });
      const exe = await installAll(config.retroarch, send);
      config.retroarch = exe;
      saveConfig(config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    } finally {
      installing = false;
    }
  });

  ipcMain.handle('app:version', () => app.getVersion());

  createWindow();
  setupUpdater();
});

// ---------- Mises à jour automatiques (via les « Releases » GitHub) ----------
let autoUpdater = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  const send = (ch, v) => win && !win.isDestroyed() && win.webContents.send(ch, v);
  autoUpdater.on('update-available', (i) => send('update:available', i.version));
  autoUpdater.on('download-progress', (p) => send('update:progress', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', (i) => send('update:ready', i.version));
  autoUpdater.on('error', () => { /* pas grave : on réessaiera au prochain lancement */ });
  win.webContents.once('did-finish-load', () => autoUpdater.checkForUpdates().catch(() => {}));
}
ipcMain.handle('update:install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });

app.on('window-all-closed', () => app.quit());
