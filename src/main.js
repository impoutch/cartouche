// Cartouche — processus principal (Electron)
// Rôle : fenêtre, réglages, scan des jeux, lancement de RetroArch avec le bon cœur.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { installAll } = require('./installer');
const { listSaves, prepareSession, finishSession } = require('./saves');
const { identify, inspectArchive } = require('./identify');
const controls = require('./controls');
const gameWindow = require('./window');
const { DISC_EXT, detectFile } = require('./disc');
const dolphin = require('./dolphin');
const ARCHIVES = ['.zip', '.7z'];

// ---------- Consoles prises en charge ----------
const GB_CORES = ['sameboy_libretro.dll', 'gambatte_libretro.dll', 'mgba_libretro.dll'];
const SYSTEMS = {
  gb:  { label: 'Game Boy',       ext: ['.gb'],          thumbs: 'Nintendo - Game Boy',       cores: GB_CORES },
  gbc: { label: 'Game Boy Color', ext: ['.gbc'],         thumbs: 'Nintendo - Game Boy Color', cores: GB_CORES },
  gba: { label: 'Game Boy Advance', ext: ['.gba'],      thumbs: 'Nintendo - Game Boy Advance',
         cores: ['mgba_libretro.dll', 'vbam_libretro.dll', 'vba_next_libretro.dll'] },
  nds: { label: 'Nintendo DS',    ext: ['.nds', '.dsi'], thumbs: 'Nintendo - Nintendo DS',
         cores: ['melondsds_libretro.dll', 'melonds_libretro.dll', 'desmume_libretro.dll'] },
  // Consoles sur disque : la console est reconnue en lisant le disque (voir disc.js)
  ps1: { label: 'PlayStation',    ext: [], disc: true, thumbs: 'Sony - PlayStation',
         cores: ['swanstation_libretro.dll', 'pcsx_rearmed_libretro.dll', 'mednafen_psx_hw_libretro.dll'] },
  ps2: { label: 'PlayStation 2',  ext: [], disc: true, thumbs: 'Sony - PlayStation 2', cores: ['pcsx2_libretro.dll'] },
  gc:  { label: 'GameCube',       ext: [], disc: true, thumbs: 'Nintendo - GameCube', cores: [] }, // via Dolphin
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
const DEFAULT_CONFIG = { retroarch: '', gamesDirs: [], fullscreen: true, externalSaves: true, volume: 100, mute: false, lowLatency: false, menuSounds: false, bindings: {}, language: 'fr', favorites: [], recent: {}, lastSave: {}, pendingSession: null };

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
    if (ARCHIVES.includes(path.extname(e.name).toLowerCase())) {
      // Archive : la console sera déterminée en lisant son contenu
      out.push({ path: full, raw: e.name.slice(0, -path.extname(e.name).length), system: null, archive: true });
      continue;
    }
    if (DISC_EXT.includes(path.extname(e.name).toLowerCase())) {
      out.push({ path: full, raw: e.name.slice(0, -path.extname(e.name).length), system: null, disc: true });
      continue;
    }
    const system = systemForFile(e.name);
    if (system) {
      const raw = e.name.slice(0, -path.extname(e.name).length);
      out.push({ path: full, raw, system, thumbs: SYSTEMS[system].thumbs });
    }
  }
}

// Reconnaissance d'un disque, avec mémoire (pour ne pas relire les disques à chaque scan)
let discCache = null;
const discCachePath = () => path.join(app.getPath('userData'), 'disques.json');
function detectDisc(file) {
  if (!discCache) { try { discCache = JSON.parse(fs.readFileSync(discCachePath(), 'utf8')); } catch { discCache = {}; } }
  const st = fs.statSync(file);
  const c = discCache[file];
  if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.info;
  let info = null;
  try { info = detectFile(file); } catch { info = null; }
  discCache[file] = { size: st.size, mtime: st.mtimeMs, info };
  try { fs.writeFileSync(discCachePath(), JSON.stringify(discCache)); } catch { /* pas grave */ }
  return info;
}

// ---------- Cœurs (moteurs) ----------
function coresDir() { return config.retroarch ? path.join(path.dirname(config.retroarch), 'cores') : ''; }
function systemDir() { return config.retroarch ? path.join(path.dirname(config.retroarch), 'system') : ''; }
const PS1_BIOS = ['scph5500.bin', 'scph5501.bin', 'scph5502.bin', 'scph1001.bin', 'scph7001.bin', 'scph7003.bin', 'scph101.bin', 'psxonpsp660.bin'];
const ps1BiosFound = () => !!systemDir() && PS1_BIOS.some((b) => fs.existsSync(path.join(systemDir(), b)));
const ps2BiosDir = () => path.join(systemDir(), 'pcsx2', 'bios');
function ps2BiosFound() {
  try { return fs.readdirSync(ps2BiosDir()).some((n) => fs.statSync(path.join(ps2BiosDir(), n)).size >= 4 * 1024 * 1024); } catch { return false; }
}
function findCore(system) {
  if (system === 'gc') return dolphin.findExe() ? 'Dolphin' : null;
  const dir = coresDir();
  if (!dir) return null;
  let cores = SYSTEMS[system].cores;
  // PS1 : SwanStation est le meilleur moteur mais exige un BIOS ; sans BIOS, PCSX ReARMed fonctionne
  if (system === 'ps1' && !ps1BiosFound()) cores = ['pcsx_rearmed_libretro.dll', ...cores];
  return cores.find(c => fs.existsSync(path.join(dir, c))) || null;
}

// ---------- Son ----------
// Réglages audio transmis à RetroArch à chaque lancement (volume en décibels pour RetroArch)
function writeAudioConfig() {
  const v = Math.max(0, Math.min(100, Number(config.volume ?? 100)));
  const db = v > 0 ? (20 * Math.log10(v / 100)).toFixed(1) : '-80.0';
  const file = path.join(app.getPath('userData'), 'cartouche-son.cfg');
  fs.writeFileSync(file, [
    `audio_volume = "${db}"`,
    `audio_mute_enable = "${config.mute || v === 0 ? 'true' : 'false'}"`,
    `audio_latency = "${config.lowLatency ? 32 : 64}"`,
    `audio_enable_menu = "${config.menuSounds ? 'true' : 'false'}"`,
    '',
  ].join('\n'));
  return file;
}

// ---------- Contrôles ----------
function writeControlsConfig() {
  const file = path.join(app.getPath('userData'), 'cartouche-touches.cfg');
  fs.writeFileSync(file, controls.configLines(config.bindings).lines.join('\n') + '\n');
  return file;
}

// ---------- Vidéo ----------
// La PS2 (LRPS2) a besoin de Vulkan ; les autres moteurs utilisent OpenGL, le réglage habituel.
function writeVideoConfig(system) {
  const file = path.join(app.getPath('userData'), 'cartouche-video.cfg');
  fs.writeFileSync(file, `video_driver = "${system === 'ps2' ? 'vulkan' : 'gl'}"\n`);
  return file;
}

// ---------- Langue ----------
// Langue de la console DS émulée (et du menu en jeu). Le moteur melonDS DS suit la langue de
// RetroArch ; on la règle aussi directement dans les options du moteur.
const LANGUAGES = { en: 0, ja: 1, fr: 2, es: 3, de: 4, it: 5 }; // codes de langue libretro
function writeLanguageConfig() {
  const lang = LANGUAGES[config.language] !== undefined ? config.language : 'fr';
  try {
    const optDir = path.join(path.dirname(config.retroarch), 'config', 'melonDS DS');
    const opt = path.join(optDir, 'melonDS DS.opt');
    fs.mkdirSync(optDir, { recursive: true });
    let text = fs.existsSync(opt) ? fs.readFileSync(opt, 'utf8') : '';
    const line = `melonds_firmware_language = "${lang}"`;
    text = /^melonds_firmware_language\s*=.*$/m.test(text)
      ? text.replace(/^melonds_firmware_language\s*=.*$/m, line)
      : text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
    fs.writeFileSync(opt, text);
  } catch { /* le réglage de RetroArch ci-dessous suffit en général */ }
  const file = path.join(app.getPath('userData'), 'cartouche-langue.cfg');
  fs.writeFileSync(file, `user_language = "${LANGUAGES[lang]}"\n`);
  return file;
}

// ---------- GameCube : Dolphin ----------
function launchDolphin(gamePath, title) {
  const exe = dolphin.findExe();
  if (!exe) return { ok: false, error: 'Dolphin n’est pas installé. Va dans Réglages pour l’installer.' };
  try {
    running = dolphin.launch(exe, gamePath, {
      fullscreen: config.fullscreen, volume: config.mute ? 0 : Number(config.volume ?? 100), language: config.language,
    });
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
  config.recent[gamePath] = Date.now();
  saveConfig(config);
  const stopWatch = gameWindow.watchEscape(running.pid);
  runningTitle = title || path.basename(gamePath);
  if (win && !win.isDestroyed()) win.webContents.send('game:started', runningTitle);
  running.on('exit', () => {
    stopWatch();
    running = null;
    if (win && !win.isDestroyed()) { win.webContents.send('game:exited', null); win.show(); }
  });
  running.on('error', (err) => { running = null; if (win && !win.isDestroyed()) win.webContents.send('game:error', String(err.message || err)); });
  return { ok: true, core: 'Dolphin' };
}

// ---------- Fenêtre ----------
let win;
let running = null;
let runningTitle = null;

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
  // Cartouche a été fermée pendant une partie : on récupère la sauvegarde restée en cours
  if (config.pendingSession) {
    try { finishSession(config.pendingSession); } catch { /* tant pis */ }
    config.pendingSession = null;
    saveConfig(config);
  }

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

  ipcMain.handle('games:scan', async () => {
    const out = [];
    for (const d of config.gamesDirs) scanDir(d, 0, out);
    const games = [];
    // Fichiers déjà listés par une playlist .m3u (disques 1, 2…) : on n'affiche que la playlist
    const refs = new Set();
    for (const g of out) {
      if (!g.disc) continue;
      const info = detectDisc(g.path);
      if (!info || !SYSTEMS[info.system]) { g.skip = true; continue; }
      Object.assign(g, { system: info.system, thumbs: SYSTEMS[info.system].thumbs, serial: info.serial });
      for (const r of info.refs || []) refs.add(path.resolve(r));
    }
    for (const g of out) {
      if (g.skip || (g.disc && refs.has(path.resolve(g.path)))) continue;
      if (g.archive) {
        const info = await inspectArchive(g.path, systemForFile);
        if (!info) continue;                 // archive sans jeu Game Boy / GBA / DS
        Object.assign(g, { system: info.system, thumbs: SYSTEMS[info.system].thumbs, crc: info.crc, inner: info.inner });
      }
      games.push(g);
      const id = await identify(g);     // nom officiel (pour la jaquette), ou null
      g.official = id.name;
      g.alts = id.alts;
      const saves = listSaves(g.path);
      g.saves = saves.length;
      g.savesEmpty = saves.length > 0 && saves.every((x) => x.empty);
    }
    return games.sort((a, b) => a.raw.localeCompare(b.raw, 'fr'));
  });

  ipcMain.handle('saves:list', (_e, gamePath) => ({
    saves: listSaves(gamePath),
    last: config.lastSave[gamePath] || null,
  }));

  ipcMain.handle('cores:status', () => {
    const status = { retroarchOk: !!config.retroarch && fs.existsSync(config.retroarch) };
    for (const k of Object.keys(SYSTEMS)) status[k] = k === 'gc' || status.retroarchOk ? findCore(k) : null;
    status.ps1Bios = status.retroarchOk && ps1BiosFound();
    status.ps2Bios = status.retroarchOk && ps2BiosFound();
    return status;
  });

  // Import des BIOS : 512 Ko = PlayStation (dossier system), 4 Mo et plus = PS2 (system/pcsx2/bios)
  ipcMain.handle('bios:import', async () => {
    if (!config.retroarch) return { ok: false, error: 'Installe d’abord les moteurs (bouton violet).' };
    const r = await dialog.showOpenDialog(win, { title: 'Choisis tes fichiers BIOS (PS1 et/ou PS2)', properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return { ok: false };
    let ps1 = 0, ps2 = 0, ignored = 0;
    for (const f of r.filePaths) {
      const size = fs.statSync(f).size;
      if (size === 512 * 1024) {
        fs.mkdirSync(systemDir(), { recursive: true });
        // SwanStation reconnaît les BIOS par leur nom standard : on garde le nom d'origine
        fs.copyFileSync(f, path.join(systemDir(), path.basename(f).toLowerCase()));
        ps1++;
      } else if (size >= 4 * 1024 * 1024 && size <= 16 * 1024 * 1024) {
        fs.mkdirSync(ps2BiosDir(), { recursive: true });
        fs.copyFileSync(f, path.join(ps2BiosDir(), path.basename(f)));
        ps2++;
      } else ignored++;
    }
    return { ok: true, ps1, ps2, ignored };
  });
  ipcMain.handle('dolphin:open', () => dolphin.openSettings());

  ipcMain.handle('game:launch', async (_e, gamePath, system, choice, title) => {
    if (running) return { ok: false, error: 'Un jeu est déjà ouvert. Ferme-le d’abord.' };
    if (!config.retroarch || !fs.existsSync(config.retroarch)) return { ok: false, error: 'RetroArch introuvable. Vérifie les réglages.' };
    const core = findCore(system);
    if (!core) return { ok: false, error: `Aucun moteur installé pour ${SYSTEMS[system].label}. Va dans Réglages pour l’installer.` };
    if (system === 'ps2' && !ps2BiosFound()) return { ok: false, error: 'Il manque le BIOS de ta PS2. Va dans Réglages → « Importer des fichiers BIOS ».' };
    if (system === 'gc') return launchDolphin(gamePath, title);
    const args = ['-L', path.join(coresDir(), core), gamePath];
    if (config.fullscreen) args.push('-f');
    const extraConfigs = [];
    try { extraConfigs.push(writeAudioConfig()); } catch { /* son par défaut */ }
    try { extraConfigs.push(writeControlsConfig()); } catch { /* touches par défaut */ }
    try { extraConfigs.push(writeLanguageConfig()); } catch { /* langue par défaut */ }
    try { extraConfigs.push(writeVideoConfig(system)); } catch { /* pilote par défaut */ }
    // Sauvegardes externes : la sauvegarde choisie est copiée dans un dossier de travail
    let session = null;
    if (config.externalSaves && choice) {
      try {
        // Jeu dans une archive : RetroArch peut nommer la sauvegarde d'après le fichier intérieur
        let innerBase = null;
        if (ARCHIVES.includes(path.extname(gamePath).toLowerCase())) {
          const info = await inspectArchive(gamePath, systemForFile);
          if (info) innerBase = path.basename(info.inner, path.extname(info.inner));
        }
        session = prepareSession(gamePath, choice, path.join(app.getPath('userData'), 'partie-en-cours'), innerBase);
        extraConfigs.push(session.cfg);
        config.pendingSession = session;           // pour récupérer la sauvegarde si Cartouche plante
        if (choice.type === 'file') config.lastSave[gamePath] = choice.file;
      } catch (err) {
        return { ok: false, error: 'Préparation de la sauvegarde impossible : ' + err.message };
      }
    }
    if (extraConfigs.length) args.push('--appendconfig', extraConfigs.join('|'));
    try {
      running = spawn(config.retroarch, args, { cwd: path.dirname(config.retroarch), detached: false });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    config.recent[gamePath] = Date.now();
    saveConfig(config);
    const stopWatch = gameWindow.watchEscape(running.pid);
    runningTitle = title || path.basename(gamePath);
    if (win && !win.isDestroyed()) win.webContents.send('game:started', runningTitle);
    running.on('exit', () => {
      stopWatch();
      running = null;
      const saved = session ? finishSession(session) : null;
      if (saved && saved.file) config.lastSave[gamePath] = saved.file;
      config.pendingSession = null;
      saveConfig(config);
      if (win && !win.isDestroyed()) { win.webContents.send('game:exited', saved); win.show(); }
    });
    running.on('error', (err) => { running = null; if (win && !win.isDestroyed()) win.webContents.send('game:error', String(err.message || err)); });
    return { ok: true, core };
  });

  // Ouvre RetroArch seul (pour installer les moteurs ou régler les manettes)
  ipcMain.handle('retroarch:open', () => {
    if (!config.retroarch || !fs.existsSync(config.retroarch)) return false;
    spawn(config.retroarch, [], { cwd: path.dirname(config.retroarch), detached: true, stdio: 'ignore' }).unref();
    return true;
  });

  ipcMain.handle('shell:showItem', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
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
      if (!dolphin.findExe()) await dolphin.install(send);
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
  ipcMain.handle('game:restore', () => (running ? gameWindow.restore(running.pid) : false));
  ipcMain.handle('game:close', () => (running ? gameWindow.close(running.pid) : false));
  ipcMain.handle('game:current', () => (running ? runningTitle : null));
  ipcMain.handle('controls:list', () => ({
    actions: controls.ACTIONS.map(([key, label]) => ({ key, label })),
    hotkeys: controls.HOTKEYS.map(([key, label]) => ({ key, label })),
    defaults: controls.defaults(),
  }));

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
  // Vérifie aussi toutes les 2 heures si l'app reste ouverte
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 2 * 60 * 60 * 1000);
}
ipcMain.handle('update:install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return 'indisponible';
  try {
    const r = await autoUpdater.checkForUpdates();
    return r && r.updateInfo && r.updateInfo.version !== app.getVersion() ? 'trouvée' : 'à jour';
  } catch { return 'erreur'; }
});

app.on('window-all-closed', () => app.quit());
