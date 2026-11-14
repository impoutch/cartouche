// Sauvegardes externes : les sauvegardes sont des fichiers .sav rangés à côté du jeu.
//
//   Pokemon Emeraude.gba
//   Pokemon Emeraude.sav               ← sauvegarde « principale »
//   Pokemon Emeraude - Nuzlocke.sav    ← autre sauvegarde (le nom après « - » est libre)
//
// Avant de jouer, on choisit une sauvegarde (ou une nouvelle, ou aucune). Cartouche la copie
// dans un dossier de travail sous le nom attendu par RetroArch (.srm), puis la recopie dans
// le bon .sav à la fin de la partie. Rien d'autre n'apparaît à côté du jeu.
// Avant d'écraser un .sav, l'ancien est gardé en .sav.bak.

const fs = require('fs');
const path = require('path');

const baseOf = (romPath) => path.basename(romPath, path.extname(romPath));

function isEmptySave(file) {
  const b = fs.readFileSync(file);
  if (!b.length) return true;
  const first = b[0];
  if (first !== 0xff && first !== 0x00) return false;
  for (let i = 0; i < b.length; i++) if (b[i] !== first) return false;
  return true;
}

function sameContent(a, b) {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
}

function writeWithBackup(from, target) {
  if (fs.existsSync(target)) {
    if (sameContent(from, target)) return false;
    fs.copyFileSync(target, target + '.bak');
  }
  fs.copyFileSync(from, target);
  return true;
}

// Ancienne version (0.4.0) : un .srm traînait à côté du jeu. On le range dans le .sav puis on l'efface.
function cleanupLegacySrm(romPath) {
  const dir = path.dirname(romPath), base = baseOf(romPath);
  const srm = path.join(dir, base + '.srm'), sav = path.join(dir, base + '.sav');
  if (!fs.existsSync(srm)) return;
  try {
    if (!fs.existsSync(sav) || fs.statSync(srm).mtimeMs > fs.statSync(sav).mtimeMs) writeWithBackup(srm, sav);
    fs.rmSync(srm, { force: true });
  } catch { /* on réessaiera */ }
}

// Liste des sauvegardes d'un jeu
function listSaves(romPath) {
  cleanupLegacySrm(romPath);
  const dir = path.dirname(romPath), base = baseOf(romPath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.sav')) continue;
    const stem = n.slice(0, -4);
    let label = null;
    if (stem === base) label = 'Principale';
    else if (stem.startsWith(base + ' - ')) label = stem.slice(base.length + 3);
    if (!label) continue;
    const file = path.join(dir, n);
    const st = fs.statSync(file);
    out.push({ file, label, mtime: st.mtimeMs, size: st.size, empty: isEmptySave(file) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const safeLabel = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 60);

// Chemin du .sav d'une nouvelle sauvegarde (sans écraser une existante)
function newSavePath(romPath, label) {
  const dir = path.dirname(romPath), base = baseOf(romPath);
  const clean = safeLabel(label || '');
  const main = path.join(dir, base + '.sav');
  if (!clean && !fs.existsSync(main)) return main;
  let name = clean || 'Partie 2', n = 2, file;
  while (fs.existsSync(file = path.join(dir, `${base} - ${name}.sav`))) name = `${clean || 'Partie'} ${++n}`;
  return file;
}

// Prépare le dossier de travail. choice = { type: 'file', file } | { type: 'new', label } | { type: 'none' }
function prepareSession(romPath, choice, workDir, innerBase = null) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const base = baseOf(romPath);
  let target = null;
  if (choice.type === 'file') {
    target = choice.file;
    // Les deux noms : .srm (norme RetroArch) et .sav (au cas où un moteur l'utilise directement)
    const bases = [...new Set([base, innerBase].filter(Boolean))];
    for (const b of bases) for (const ext of ['.srm', '.sav']) fs.copyFileSync(target, path.join(workDir, b + ext));
  } else if (choice.type === 'new') {
    target = newSavePath(romPath, choice.label);
  }
  const cfg = path.join(path.dirname(workDir), 'cartouche-sauvegardes.cfg');
  fs.writeFileSync(cfg, [
    `savefile_directory = "${workDir.replace(/\\/g, '/')}"`,
    'sort_savefiles_enable = "false"',
    'sort_savefiles_by_content_enable = "false"',
    'savefiles_in_content_dir = "false"',
    '',
  ].join('\n'));
  return { rom: romPath, target, workDir, base, started: Date.now(), cfg };
}

// Fin de partie : recopie la sauvegarde du dossier de travail vers le bon .sav
function finishSession(session) {
  if (!session || !session.target) return { status: 'sans-sauvegarde' };
  // Le fichier le plus récemment écrit par RetroArch dans le dossier de travail
  let names = [];
  try { names = fs.readdirSync(session.workDir); } catch { /* dossier absent */ }
  const candidates = names.filter((n) => /\.(srm|sav)$/i.test(n))
    .map((n) => path.join(session.workDir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) return { status: 'rien' };
  // Nouvelle partie où l'on n'a jamais sauvegardé : on ne crée pas de .sav vide
  if (!fs.existsSync(session.target) && isEmptySave(candidates[0])) return { status: 'rien' };
  try {
    const changed = writeWithBackup(candidates[0], session.target);
    return { status: changed ? 'enregistree' : 'inchangee', file: session.target };
  } catch (err) {
    return { status: 'erreur', error: err.message };
  }
}

module.exports = { listSaves, prepareSession, finishSession, cleanupLegacySrm };
