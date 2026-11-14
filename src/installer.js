// Installation automatique : RetroArch + moteurs (SameBoy, melonDS DS)
// Tout est téléchargé depuis le serveur officiel libretro et rangé dans le dossier de Cartouche.

const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const BUILDBOT = 'https://buildbot.libretro.com';
const CORES_URL = `${BUILDBOT}/nightly/windows/x86_64/latest`;
const WANTED_CORES = ['sameboy_libretro.dll', 'melondsds_libretro.dll'];

const installRoot = () => path.join(app.getPath('userData'), 'retroarch');
// 7-Zip est fourni avec l'app (dézippé hors de l'archive asar pour pouvoir s'exécuter)
const sevenZip = () => require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');

const cmpVer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

async function download(url, dest, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
  await pipeline(stream, fs.createWriteStream(dest));
  return done;
}

async function headSize(url) {
  try {
    const r = await net.fetch(url, { method: 'HEAD' });
    return r.ok ? Number(r.headers.get('content-length')) || -1 : 0;
  } catch { return 0; }
}

// Trouve la version stable la plus récente réellement disponible (sinon la nightly)
async function findRetroArchUrl() {
  const candidates = [];
  try {
    const html = await (await net.fetch(`${BUILDBOT}/stable/`)).text();
    const versions = [...new Set([...html.matchAll(/(\d+\.\d+\.\d+)\//g)].map((m) => m[1]))].sort(cmpVer).reverse();
    for (const v of versions.slice(0, 5)) candidates.push(`${BUILDBOT}/stable/${v}/windows/x86_64/RetroArch.7z`);
  } catch { /* on passe à la nightly */ }
  candidates.push(`${BUILDBOT}/nightly/windows/x86_64/RetroArch.7z`);
  for (const url of candidates) {
    const size = await headSize(url);
    if (size > 50e6 || size === -1) return url; // -1 : taille inconnue mais fichier présent
  }
  return candidates[0];
}

function extract7z(archive, outDir) {
  return new Promise((resolve, reject) => {
    const p = spawn(sevenZip(), ['x', archive, `-o${outDir}`, '-y'], { windowsHide: true });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Décompression échouée (code ${code})`))));
  });
}

function findExe(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'retroarch.exe');
  if (hit) return path.join(dir, hit.name);
  if (depth >= 3) return null;
  for (const e of entries) {
    if (e.isDirectory()) { const r = findExe(path.join(dir, e.name), depth + 1); if (r) return r; }
  }
  return null;
}

// Installe les moteurs manquants dans le dossier « cores » d'un RetroArch existant
async function installCores(retroarchExe, progress) {
  const coresDir = path.join(path.dirname(retroarchExe), 'cores');
  fs.mkdirSync(coresDir, { recursive: true });
  const tmp = app.getPath('temp');
  for (let i = 0; i < WANTED_CORES.length; i++) {
    const core = WANTED_CORES[i];
    if (fs.existsSync(path.join(coresDir, core))) continue;
    const zipPath = path.join(tmp, `${core}.zip`);
    const label = core.startsWith('sameboy') ? 'moteur Game Boy (SameBoy)' : 'moteur DS (melonDS DS)';
    await download(`${CORES_URL}/${core}.zip`, zipPath, (d, t) =>
      progress(`Téléchargement du ${label}…`, t ? (i + d / t) / WANTED_CORES.length : null));
    new AdmZip(zipPath).extractAllTo(coresDir, true);
    fs.rmSync(zipPath, { force: true });
  }
}

// Installation complète : RetroArch (si besoin) + moteurs
async function installAll(currentExe, progress) {
  let exe = currentExe && fs.existsSync(currentExe) ? currentExe : findExe(installRoot());

  if (!exe) {
    const root = installRoot();
    fs.mkdirSync(root, { recursive: true });
    progress('Recherche de la dernière version de RetroArch…', null);
    const url = await findRetroArchUrl();
    const archive = path.join(app.getPath('temp'), 'RetroArch.7z');
    const size = await download(url, archive, (d, t) =>
      progress(`Téléchargement de RetroArch… (${Math.round(d / 1e6)} Mo${t ? ' / ' + Math.round(t / 1e6) + ' Mo' : ''})`, t ? d / t : null));
    if (size < 50e6) throw new Error('Le fichier RetroArch reçu est incomplet. Réessaie plus tard.');
    progress('Décompression de RetroArch (1 à 2 minutes)…', null);
    await extract7z(archive, root);
    fs.rmSync(archive, { force: true });
    exe = findExe(root);
    if (!exe) throw new Error('RetroArch a été téléchargé, mais retroarch.exe est introuvable.');
  }

  await installCores(exe, (label, frac) => progress(label, frac));
  progress('Terminé !', 1);
  return exe;
}

module.exports = { installAll, installCores };
