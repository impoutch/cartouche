// Identification des jeux pour retrouver leur nom officiel (et donc leur jaquette),
// quel que soit le nom du fichier.
//  - GBA et DS : code du jeu inscrit dans la cartouche (ex. « BPEF » = Pokémon Émeraude FR)
//  - Game Boy / Color : empreinte CRC32 du fichier
// Les correspondances viennent de la base No-Intro maintenue par libretro.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFile } = require('child_process');

const DB_URL = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/';
const DB_FILES = {
  gb: 'no-intro/Nintendo - Game Boy', gbc: 'no-intro/Nintendo - Game Boy Color',
  gba: 'no-intro/Nintendo - Game Boy Advance', nds: 'no-intro/Nintendo - Nintendo DS',
  ps1: 'redump/Sony - PlayStation', ps2: 'redump/Sony - PlayStation 2', gc: 'redump/Nintendo - GameCube',
};
const DISC_SYSTEMS = ['ps1', 'ps2', 'gc'];
const MAX_AGE = 30 * 24 * 3600 * 1000; // on rafraîchit la base une fois par mois

const dbDir = () => path.join(app.getPath('userData'), 'base-jeux');
const cachePath = () => path.join(app.getPath('userData'), 'identifications.json');

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Cartouche' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject).setTimeout(30000, function () { this.destroy(new Error('délai dépassé')); });
  });
}

// Lit (et télécharge si besoin) la base d'une console → { byCrc, bySerial }
const dbs = {};
async function loadDb(system) {
  if (dbs[system]) return dbs[system];
  const file = path.join(dbDir(), path.basename(DB_FILES[system]) + '.dat');
  let text = null;
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE;
  if (!fresh) {
    try {
      text = await fetchText(DB_URL + DB_FILES[system].split('/').map(encodeURIComponent).join('/') + '.dat');
      fs.mkdirSync(dbDir(), { recursive: true });
      fs.writeFileSync(file, text);
    } catch { /* hors ligne : on garde l'ancienne base si elle existe */ }
  }
  if (!text && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  const db = { byCrc: new Map(), bySerial: new Map(), byPrefix: new Map(), crcSerial: new Map() };
  if (text) {
    for (const block of text.split(/\ngame \(/)) {
      const name = /\n\tname "([^"]+)"/.exec(block);
      if (!name) continue;
      const crc = /\bcrc ([0-9A-Fa-f]{8})/.exec(block);
      const serial = /\n\tserial "([^"]+)"/.exec(block);
      if (crc) db.byCrc.set(crc[1].toUpperCase(), name[1]);
      if (crc && serial) db.crcSerial.set(crc[1].toUpperCase(), serial[1]);
      // Jeux sur disque : un même jeu peut avoir plusieurs codes (« SLUS-00892, SLUS-00894 »)
      if (serial && DISC_SYSTEMS.includes(system)) {
        for (const one of serial[1].split(/[,\s]+/).filter(Boolean)) {
          const gc = /DOL-([A-Z0-9]{4})/.exec(one);          // GameCube : « DL-DOL-GZLP-EUR » → GZLP
          const key = gc ? gc[1] : one.toUpperCase();
          if (!db.bySerial.has(key)) db.bySerial.set(key, name[1]);
        }
      }
      if (serial && !db.bySerial.has(serial[1])) db.bySerial.set(serial[1], name[1]);
      // Même jeu dans d'autres régions : les 3 premiers caractères du code sont communs (BPE* = Émeraude)
      if (serial && serial[1].length === 4) {
        const k = serial[1].slice(0, 3);
        if (!db.byPrefix.has(k)) db.byPrefix.set(k, []);
        db.byPrefix.get(k).push(name[1]);
      }
    }
  }
  return (dbs[system] = db);
}

function readBytes(file, offset, length) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(length); fs.readSync(fd, b, 0, length, offset); return b; } finally { fs.closeSync(fd); }
}

function crc32File(file) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    fs.createReadStream(file).on('data', (c) => { crc = zlib.crc32(c, crc); })
      .on('end', () => resolve((crc >>> 0).toString(16).toUpperCase().padStart(8, '0'))).on('error', reject);
  });
}

let cache = null;
function getCache() {
  if (!cache) { try { cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch { cache = {}; } }
  return cache;
}

// Renvoie { name: nom officiel No-Intro ou null, alts: mêmes jeux dans d'autres régions }
async function identify(game) {
  const st = fs.statSync(game.path);
  const key = game.path;
  const c = getCache();
  if (c[key] && c[key].v === 2 && c[key].size === st.size && c[key].mtime === st.mtimeMs) return c[key].result;

  const result = { name: null, alts: [] };
  try {
    const db = await loadDb(game.system);
    let serial = null;
    if (DISC_SYSTEMS.includes(game.system)) {
      // Disque : le code a déjà été lu sur le disque (pas d'empreinte, trop gros)
      if (game.serial) result.name = db.bySerial.get(game.system === 'gc' ? game.serial.slice(0, 4) : game.serial) || null;
    } else if (game.crc) {
      // Jeu dans une archive : l'empreinte est déjà connue (lue dans l'archive)
      result.name = db.byCrc.get(game.crc) || null;
      serial = db.crcSerial.get(game.crc) || null;
    } else {
      if (game.system === 'gba') serial = readBytes(game.path, 0xAC, 4).toString('latin1');
      if (game.system === 'nds') serial = readBytes(game.path, 0x0C, 4).toString('latin1');
      if (serial) result.name = db.bySerial.get(serial) || null;
      if (!result.name && st.size <= 64 * 1024 * 1024) result.name = db.byCrc.get(await crc32File(game.path)) || null;
    }
    if (serial && /^[A-Z0-9]{4}$/.test(serial) && !DISC_SYSTEMS.includes(game.system)) {
      const rank = (n) => (/\((USA|World)/.test(n) ? 0 : /Europe/.test(n) ? 1 : 2); // versions les plus illustrées d'abord
      result.alts = (db.byPrefix.get(serial.slice(0, 3)) || []).filter((n) => n !== result.name)
        .sort((a, b) => rank(a) - rank(b)).slice(0, 4);
    }
  } catch { /* hors ligne ou fichier illisible */ }

  c[key] = { v: 2, size: st.size, mtime: st.mtimeMs, result };
  try { fs.writeFileSync(cachePath(), JSON.stringify(c)); } catch { /* pas grave */ }
  return result;
}

// ---------- Archives .zip et .7z ----------
// On lit seulement la table des matières de l'archive (sans rien décompresser) :
// nom du jeu à l'intérieur + son empreinte CRC32.

function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return [];
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if ((cdOff === 0xffffffff || count === 0xffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
      const z = Buffer.alloc(56);
      fs.readSync(fd, z, 0, 56, Number(tail.readBigUInt64LE(eocd - 12)));
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + nlen), crc: (cd.readUInt32LE(p + 16) >>> 0).toString(16).toUpperCase().padStart(8, '0') });
      p += 46 + nlen + elen + clen;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

function sevenZipExe() {
  const own = path.join(app.getPath('userData'), 'outils', '7zr.exe');
  if (fs.existsSync(own)) return own;
  return require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');
}

function list7z(file) {
  return new Promise((resolve) => {
    execFile(sevenZipExe(), ['l', '-slt', file], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const body = stdout.split(/\r?\n----------\r?\n/)[1] || '';
      const out = [];
      for (const block of body.split(/\r?\n\r?\n/)) {
        const name = /^Path = (.+)$/m.exec(block), crc = /^CRC = ([0-9A-Fa-f]{8})$/m.exec(block);
        if (name) out.push({ name: name[1].trim(), crc: crc ? crc[1].toUpperCase() : null });
      }
      resolve(out);
    });
  });
}

// Renvoie { system, inner, crc } pour la première ROM trouvée dans l'archive, ou null
async function inspectArchive(file, systemFor) {
  const st = fs.statSync(file);
  const c = getCache();
  const key = 'archive:' + file;
  if (c[key] && c[key].size === st.size && c[key].mtime === st.mtimeMs) return c[key].info;
  let info = null;
  try {
    const entries = file.toLowerCase().endsWith('.zip') ? listZip(file) : await list7z(file);
    const hit = entries.find((e) => systemFor(e.name));
    if (hit) info = { system: systemFor(hit.name), inner: path.basename(hit.name), crc: hit.crc };
  } catch { info = null; }
  c[key] = { size: st.size, mtime: st.mtimeMs, info };
  try { fs.writeFileSync(cachePath(), JSON.stringify(c)); } catch { /* pas grave */ }
  return info;
}

module.exports = { identify, inspectArchive };
