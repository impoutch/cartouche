// Installation automatique : RetroArch + moteurs (SameBoy, melonDS DS)
// Tout est téléchargé depuis le serveur officiel libretro et rangé dans le dossier de Cartouche.

const { app, net } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const BUILDBOT = 'https://buildbot.libretro.com';
const CORES_URL = `${BUILDBOT}/nightly/windows/x86_64/latest`;
const WANTED_CORES = ['sameboy_libretro.dll', 'mgba_libretro.dll', 'melondsds_libretro.dll'];

const installRoot = () => path.join(app.getPath('userData'), 'retroarch');
// 7-Zip : on utilise la version officielle la plus récente (7zr.exe, 7-zip.org), car l'archive
// de RetroArch est créée avec un 7-Zip récent. Repli : la version intégrée à l'app.
const bundled7z = () => require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');
async function sevenZip(progress) {
  const exe = path.join(app.getPath('userData'), 'outils', '7zr.exe');
  if (fs.existsSync(exe) && fs.statSync(exe).size > 100e3) return exe;
  try {
    progress('Préparation de l’outil de décompression…', null);
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    await download('https://www.7-zip.org/a/7zr.exe', exe + '.part');
    if (fs.statSync(exe + '.part').size < 100e3) throw new Error('fichier trop petit');
    fs.renameSync(exe + '.part', exe);
    return exe;
  } catch {
    return bundled7z();
  }
}

const cmpVer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

// Téléchargement avec le module https de Node (et non net.fetch d'Electron) :
// chaque morceau reçu a sa propre mémoire, donc aucun risque de mélange des données.
// (Avec net.fetch, des morceaux étaient parfois écrits en double et d'autres perdus :
// fichier de la bonne taille, mais abîmé → « Data Error » à la décompression.)
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Cartouche' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('Trop de redirections.'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Téléchargement impossible (${res.statusCode}) : ${url}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        if (total && done !== total) reject(new Error(`Téléchargement incomplet (${done} octets sur ${total}).`));
        else resolve(done);
      });
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Le serveur ne répond plus.')));
  });
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

function extract7z(sevenZipExe, archive, outDir) {
  return new Promise((resolve, reject) => {
    // -bso0 -bsp0 : 7-Zip n'écrit rien à l'écran. Sinon, sa longue liste de fichiers remplit
    // le tuyau de sortie que personne ne lit, et la décompression se bloque indéfiniment.
    const p = spawn(sevenZipExe, ['x', archive, `-o${outDir}`, '-y', '-bso0', '-bsp0'], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve()
      : reject(new Error(`Décompression échouée (code ${code}) ${err.trim().slice(0, 200)}`))));
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
    const label = { sameboy: 'moteur Game Boy (SameBoy)', mgba: 'moteur Game Boy Advance (mGBA)', melondsds: 'moteur DS (melonDS DS)' }[core.split('_')[0]];
    await download(`${CORES_URL}/${core}.zip`, zipPath, (d, t) =>
      progress(`Téléchargement du ${label}…`, t ? (i + d / t) / WANTED_CORES.length : null));
    new AdmZip(zipPath).extractAllTo(coresDir, true);
    fs.rmSync(zipPath, { force: true });
  }
}

// Installation complète : RetroArch (si besoin) + moteurs
async function installAll(currentExe, progress) {
  // Un RetroArch installé par Cartouche n'est fiable que si l'installation est allée au bout
  // (fichier témoin). Sinon, c'est un reste d'essai raté : on recommence proprement.
  const marker = path.join(installRoot(), '.installation-terminee');
  const ownExe = fs.existsSync(marker) ? findExe(installRoot()) : null;
  let exe = currentExe && fs.existsSync(currentExe) && !currentExe.startsWith(installRoot()) ? currentExe : ownExe;

  if (!exe) {
    const root = installRoot();
    progress('Recherche de la dernière version de RetroArch…', null);
    const url = await findRetroArchUrl();
    const archive = path.join(app.getPath('temp'), 'Cartouche-RetroArch.7z');
    const tmpDir = root + '-tmp';
    const zipTool = await sevenZip(progress);

    // Deux essais : si l'archive est abîmée, on la retélécharge une fois
    for (let attempt = 1; ; attempt++) {
      try {
        fs.rmSync(archive, { force: true });
        const size = await download(url, archive, (d, t) =>
          progress(`Téléchargement de RetroArch… (${Math.round(d / 1e6)} Mo${t ? ' / ' + Math.round(t / 1e6) + ' Mo' : ''})${attempt > 1 ? ' — 2e essai' : ''}`, t ? d / t : null));
        if (size < 50e6) throw new Error('Le fichier RetroArch reçu est incomplet.');
        progress('Décompression de RetroArch (quelques minutes)…', null);
        // On décompresse dans un dossier temporaire, puis on le renomme : une installation
        // interrompue ne laisse jamais un RetroArch à moitié décompressé.
        fs.rmSync(tmpDir, { recursive: true, force: true });
        await extract7z(zipTool, archive, tmpDir);
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        progress('Le fichier semble abîmé, nouvel essai…', null);
      }
    }
    fs.rmSync(archive, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(tmpDir, root);
    fs.writeFileSync(marker, new Date().toISOString());
    exe = findExe(root);
    if (!exe) throw new Error('RetroArch a été téléchargé, mais retroarch.exe est introuvable.');
  }

  await installCores(exe, (label, frac) => progress(label, frac));
  progress('Terminé !', 1);
  return exe;
}

module.exports = { installAll, installCores };
