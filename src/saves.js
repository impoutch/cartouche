// Sauvegardes externes : chaque jeu garde sa sauvegarde dans un fichier .sav à côté du jeu.
//
// RetroArch, lui, lit et écrit un fichier .srm (même contenu, autre nom). On le place au même
// endroit que le jeu, et on synchronise les deux fichiers avant et après chaque partie :
// le plus récent gagne. Avant d'écraser un .sav, on garde l'ancien en .sav.bak (filet de sécurité).

const fs = require('fs');
const path = require('path');

const base = (romPath) => romPath.slice(0, -path.extname(romPath).length);
const savPath = (romPath) => base(romPath) + '.sav';
const srmPath = (romPath) => base(romPath) + '.srm';

function sameContent(a, b) {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function copyKeepTime(from, to) {
  fs.copyFileSync(from, to);
  const t = fs.statSync(from).mtime;
  fs.utimesSync(to, t, t);
}

// Rend .sav et .srm identiques (le plus récent l'emporte). Renvoie ce qui a été fait.
function syncSaves(romPath) {
  const sav = savPath(romPath), srm = srmPath(romPath);
  const hasSav = fs.existsSync(sav), hasSrm = fs.existsSync(srm);
  try {
    if (hasSav && !hasSrm) { copyKeepTime(sav, srm); return 'sav→srm'; }
    if (hasSrm && !hasSav) { copyKeepTime(srm, sav); return 'srm→sav'; }
    if (!hasSav && !hasSrm) return 'aucune';
    if (sameContent(sav, srm)) return 'identiques';
    if (fs.statSync(srm).mtimeMs > fs.statSync(sav).mtimeMs) {
      fs.copyFileSync(sav, sav + '.bak');
      copyKeepTime(srm, sav);
      return 'srm→sav';
    }
    copyKeepTime(sav, srm);
    return 'sav→srm';
  } catch (err) {
    return 'erreur : ' + err.message;
  }
}

// Fichier de réglages ajouté à RetroArch pour cette partie : sauvegardes dans le dossier du jeu
function writeLaunchConfig(romPath, dir) {
  const file = path.join(dir, 'cartouche-sauvegardes.cfg');
  const folder = path.dirname(romPath).replace(/\\/g, '/');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    `savefile_directory = "${folder}"`,
    'sort_savefiles_enable = "false"',
    'sort_savefiles_by_content_enable = "false"',
    'savefiles_in_content_dir = "true"',
    '',
  ].join('\n'));
  return file;
}

module.exports = { syncSaves, writeLaunchConfig, savPath };
