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

const DB_URL = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/';
const DB_FILES = {
  gb: 'Nintendo - Game Boy', gbc: 'Nintendo - Game Boy Color',
  gba: 'Nintendo - Game Boy Advance', nds: 'Nintendo - Nintendo DS',
};
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
  const file = path.join(dbDir(), DB_FILES[system] + '.dat');
  let text = null;
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE;
  if (!fresh) {
    try {
      text = await fetchText(DB_URL + encodeURIComponent(DB_FILES[system]) + '.dat');
      fs.mkdirSync(dbDir(), { recursive: true });
      fs.writeFileSync(file, text);
    } catch { /* hors ligne : on garde l'ancienne base si elle existe */ }
  }
  if (!text && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  const db = { byCrc: new Map(), bySerial: new Map(), byPrefix: new Map() };
  if (text) {
    for (const block of text.split(/\ngame \(/)) {
      const name = /\n\tname "([^"]+)"/.exec(block);
      if (!name) continue;
      const crc = /\bcrc ([0-9A-Fa-f]{8})/.exec(block);
      const serial = /\n\tserial "([^"]+)"/.exec(block);
      if (crc) db.byCrc.set(crc[1].toUpperCase(), name[1]);
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
    if (game.system === 'gba') serial = readBytes(game.path, 0xAC, 4).toString('latin1');
    if (game.system === 'nds') serial = readBytes(game.path, 0x0C, 4).toString('latin1');
    if (serial) result.name = db.bySerial.get(serial) || null;
    if (!result.name && st.size <= 64 * 1024 * 1024) result.name = db.byCrc.get(await crc32File(game.path)) || null;
    if (serial && /^[A-Z0-9]{4}$/.test(serial)) {
      const rank = (n) => (/\((USA|World)/.test(n) ? 0 : /Europe/.test(n) ? 1 : 2); // versions les plus illustrées d'abord
      result.alts = (db.byPrefix.get(serial.slice(0, 3)) || []).filter((n) => n !== result.name)
        .sort((a, b) => rank(a) - rank(b)).slice(0, 4);
    }
  } catch { /* hors ligne ou fichier illisible */ }

  c[key] = { v: 2, size: st.size, mtime: st.mtimeMs, result };
  try { fs.writeFileSync(cachePath(), JSON.stringify(c)); } catch { /* pas grave */ }
  return result;
}

module.exports = { identify };
