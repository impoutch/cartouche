// Jeux sur disque : reconnaître la console (PS1, PS2, GameCube) et lire le code du jeu,
// sans jamais lire le disque en entier (quelques Ko seulement).
//  - PS1 / PS2 : fichier SYSTEM.CNF du disque (BOOT = PS1, BOOT2 = PS2) → code « SCES-00867 »
//  - GameCube  : identifiant inscrit au début du disque (« GZLP01 »)

const fs = require('fs');
const path = require('path');

const DISC_EXT = ['.cue', '.chd', '.iso', '.gcm', '.rvz', '.wia', '.ciso', '.gcz', '.m3u', '.pbp', '.cso'];

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n < len ? b.subarray(0, n) : b;
}

// --- GameCube ---
const GC_MAGIC = 0xc2339f3d;
const WII_MAGIC = 0x5d1c9ea3;
function gcFromHeader(h) {
  if (h.length < 0x20) return null;
  if (h.readUInt32BE(0x1c) === GC_MAGIC) return { system: 'gc', serial: h.toString('latin1', 0, 6) };
  if (h.readUInt32BE(0x18) === WII_MAGIC) return { system: 'wii' };
  return null;
}

// --- ISO 9660 (CD/DVD de PlayStation) ---
function isoReader(fd, layout) {
  return (sector, count = 1) => {
    const out = [];
    for (let i = 0; i < count; i++) out.push(readAt(fd, layout.start + (sector + i) * layout.size + layout.offset, 2048));
    return Buffer.concat(out);
  };
}

function detectLayout(fd) {
  const candidates = [
    { size: 2048, offset: 0, start: 0 },
    { size: 2352, offset: 24, start: 0 }, // MODE2/2352
    { size: 2352, offset: 16, start: 0 }, // MODE1/2352
  ];
  for (const l of candidates) {
    const pvd = readAt(fd, l.start + 16 * l.size + l.offset, 8);
    if (pvd.toString('latin1', 1, 6) === 'CD001') return l;
  }
  return null;
}

function readSystemCnf(fd, layout) {
  const read = isoReader(fd, layout);
  const pvd = read(16);
  const rootLba = pvd.readUInt32LE(156 + 2), rootSize = pvd.readUInt32LE(156 + 10);
  const dir = read(rootLba, Math.min(Math.ceil(rootSize / 2048), 16));
  for (let p = 0; p < dir.length;) {
    const len = dir[p];
    if (!len) { p = (Math.floor(p / 2048) + 1) * 2048; continue; }
    const nameLen = dir[p + 32];
    const name = dir.toString('latin1', p + 33, p + 33 + nameLen).toUpperCase();
    if (name.startsWith('SYSTEM.CNF')) {
      const lba = dir.readUInt32LE(p + 2), size = Math.min(dir.readUInt32LE(p + 10), 4096);
      return read(lba, Math.ceil(size / 2048)).toString('latin1', 0, size);
    }
    p += len;
  }
  return null;
}

function serialFromBoot(line) {
  const m = /([A-Z]{4})[_-]?(\d{3})\.?(\d{2})/i.exec(line);
  return m ? `${m[1].toUpperCase()}-${m[2]}${m[3]}` : null;
}

function playstationFrom(fd, layout, fileSize) {
  let cnf = null;
  try { cnf = readSystemCnf(fd, layout); } catch { cnf = null; }
  if (cnf) {
    const boot2 = /BOOT2\s*=\s*(.+)/i.exec(cnf);
    if (boot2) return { system: 'ps2', serial: serialFromBoot(boot2[1]) };
    const boot = /BOOT\s*=\s*(.+)/i.exec(cnf);
    if (boot) return { system: 'ps1', serial: serialFromBoot(boot[1]) };
  }
  return { system: fileSize > 1e9 ? 'ps2' : 'ps1', serial: null };
}

// Indice tiré du nom des dossiers (utile pour les .chd, compressés)
function folderHint(file) {
  const p = file.toLowerCase().replace(/\\/g, '/');
  if (/(^|[^a-z])(ps2|playstation ?2)([^a-z0-9]|$)/.test(p)) return 'ps2';
  if (/(^|[^a-z])(gamecube|ngc|gcn)([^a-z]|$)/.test(p)) return 'gc';
  if (/(^|[^a-z])(ps1|psx|psone|playstation ?1?)([^a-z0-9]|$)/.test(p)) return 'ps1';
  return null;
}

function detectFile(file, depth = 0) {
  const ext = path.extname(file).toLowerCase();
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    if (ext === '.m3u') {
      if (depth > 0) return null;
      const first = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!first) return null;
      const inner = path.resolve(path.dirname(file), first);
      const r = fs.existsSync(inner) ? detectFile(inner, depth + 1) : null;
      return r && { ...r, refs: fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')).map((l) => path.resolve(path.dirname(file), l)) };
    }
    if (ext === '.cue') {
      const cue = fs.readFileSync(file, 'utf8');
      const m = /FILE\s+"([^"]+)"/i.exec(cue) || /FILE\s+(\S+)/i.exec(cue);
      if (!m) return null;
      const bin = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(bin)) return null;
      const bfd = fs.openSync(bin, 'r');
      try {
        const layout = detectLayout(bfd);
        if (!layout) return { system: folderHint(file) === 'ps2' ? 'ps2' : 'ps1', serial: null };
        return playstationFrom(bfd, layout, fs.statSync(bin).size);
      } finally { fs.closeSync(bfd); }
    }
    if (ext === '.chd') {
      const h = readAt(fd, 0, 0x30);
      if (h.toString('latin1', 0, 8) !== 'MComprHD') return null;
      const logical = h.readUInt32BE(12) >= 5 ? Number(h.readBigUInt64BE(0x20)) : st.size;
      return { system: folderHint(file) || (logical > 1e9 ? 'ps2' : 'ps1'), serial: null };
    }
    if (ext === '.pbp') return { system: 'ps1', serial: null };
    if (ext === '.cso') return { system: 'ps2', serial: null };
    if (ext === '.rvz' || ext === '.wia') return gcFromHeader(readAt(fd, 0x58, 0x20));
    if (ext === '.ciso') return gcFromHeader(readAt(fd, 0x8000, 0x20));
    if (ext === '.gcz') return { system: 'gc', serial: null };
    if (ext === '.iso' || ext === '.gcm') {
      const gc = gcFromHeader(readAt(fd, 0, 0x20));
      if (gc) return gc;
      const layout = detectLayout(fd);
      if (layout) return playstationFrom(fd, layout, st.size);
      return null;
    }
    return null;
  } finally { fs.closeSync(fd); }
}

module.exports = { DISC_EXT, detectFile };
