// Cartouche — interface
const $ = (s) => document.querySelector(s);
const LABELS = { gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance', nds: 'Nintendo DS' };
const TITLES = { all: 'Tous les jeux', fav: 'Favoris', recent: 'Récents', gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance', nds: 'Nintendo DS' };

let config = null;
let games = [];
let filter = 'all';
let query = '';

// « Pokemon - Yellow Version (USA, Europe) » → « Pokemon - Yellow Version »
const cleanTitle = (raw) => raw.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').trim() || raw;
// Jaquettes : base communautaire libretro-thumbnails (fonctionne avec les noms de fichiers « No-Intro »)
const thumbUrl = (system, name) =>
  `https://thumbnails.libretro.com/${encodeURIComponent(system)}/Named_Boxarts/${encodeURIComponent(name.replace(/[&*\/:`<>?\\|"]/g, '_'))}.png`;
// On essaie d'abord le nom officiel (identifié depuis la cartouche), puis le nom du fichier
const coverUrls = (g) => [...new Set([g.official, g.raw, ...(g.alts || [])].filter(Boolean))].map((n) => thumbUrl(g.thumbs, n));
const titleOf = (g) => cleanTitle(g.official || g.raw);

// Langues d'un jeu, d'après son nom officiel (convention No-Intro) :
//  - liste explicite : « (En,Fr,De,Es,It) »
//  - sinon déduite de la région : « (France) » → français, « (USA) » ou « (Europe) » → anglais…
const LANG_NAMES = { en: 'anglais', fr: 'français', de: 'allemand', es: 'espagnol', it: 'italien', ja: 'japonais',
  nl: 'néerlandais', sv: 'suédois', da: 'danois', no: 'norvégien', fi: 'finnois', pt: 'portugais', ko: 'coréen',
  zh: 'chinois', pl: 'polonais', ru: 'russe' };
const REGION_LANG = { france: 'fr', germany: 'de', spain: 'es', italy: 'it', japan: 'ja', usa: 'en', europe: 'en',
  uk: 'en', australia: 'en', canada: 'en', world: 'en', netherlands: 'nl', sweden: 'sv', denmark: 'da', norway: 'no',
  finland: 'fi', portugal: 'pt', brazil: 'pt', korea: 'ko', china: 'zh', taiwan: 'zh', 'hong kong': 'zh',
  russia: 'ru', poland: 'pl', quebec: 'fr', belgium: 'fr' };
function languagesOf(name) {
  if (!name) return [];
  const groups = [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  for (const grp of groups) {
    const parts = grp.split(/\s*[,+]\s*/).map((x) => x.toLowerCase());
    if (parts.length && parts.every((x) => LANG_NAMES[x])) return parts;   // liste de langues explicite
  }
  for (const grp of groups) {
    const langs = grp.split(/\s*,\s*/).map((x) => REGION_LANG[x.toLowerCase()]).filter(Boolean);
    if (langs.length) return [langs[0]];                                    // une seule langue par région
  }
  return [];
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function visibleGames() {
  let list = games;
  if (filter === 'fav') list = list.filter((g) => config.favorites.includes(g.path));
  else if (filter === 'recent') list = list.filter((g) => config.recent[g.path]).sort((a, b) => config.recent[b.path] - config.recent[a.path]);
  else if (filter !== 'all') list = list.filter((g) => g.system === filter);
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((g) => (g.raw + ' ' + (g.official || '')).toLowerCase().includes(q));
  }
  return list;
}

function updateCounts() {
  const set = (id, n) => ($(id).textContent = n || '');
  set('#c-all', games.length);
  set('#c-fav', games.filter((g) => config.favorites.includes(g.path)).length);
  set('#c-recent', games.filter((g) => config.recent[g.path]).length);
  for (const k of ['gb', 'gbc', 'gba', 'nds']) set('#c-' + k, games.filter((g) => g.system === k).length);
}

function card(g) {
  const el = document.createElement('article');
  el.className = `card sys-${g.system}`;
  el.tabIndex = 0;
  const title = titleOf(g);
  const fav = config.favorites.includes(g.path);

  const cover = document.createElement('div');
  cover.className = 'cover';
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.textContent = title.slice(0, 2).toUpperCase();
  cover.appendChild(ph);
  const urls = coverUrls(g);
  const img = new Image();
  img.loading = 'lazy';
  img.alt = '';
  img.onload = () => { cover.classList.add('has-img'); };
  img.onerror = () => { urls.shift(); if (urls.length) img.src = urls[0]; else img.remove(); };
  img.src = urls[0];
  cover.appendChild(img);

  const play = document.createElement('div');
  play.className = 'play';
  play.textContent = '▶ Jouer';
  cover.appendChild(play);

  const star = document.createElement('button');
  star.className = 'star' + (fav ? ' on' : '');
  star.title = fav ? 'Retirer des favoris' : 'Ajouter aux favoris';
  star.textContent = '★';
  star.onclick = async (e) => {
    e.stopPropagation();
    const favs = new Set(config.favorites);
    favs.has(g.path) ? favs.delete(g.path) : favs.add(g.path);
    config = await window.api.setConfig({ favorites: [...favs] });
    render();
  };
  cover.appendChild(star);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const h = document.createElement('div');
  h.className = 'title';
  h.textContent = title;
  h.title = g.official ? `${g.official}\nFichier : ${g.raw}` : g.raw;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = LABELS[g.system];
  meta.append(h, badge);
  if (g.saves) {
    const sv = document.createElement('span');
    sv.className = 'badge save' + (g.savesEmpty ? ' empty' : '');
    sv.textContent = g.savesEmpty ? '💾 vide' : (g.saves > 1 ? `💾 ${g.saves}` : '💾');
    sv.title = g.savesEmpty ? 'Fichier .sav présent, mais sans partie dedans'
      : `${g.saves} sauvegarde${g.saves > 1 ? 's' : ''} à côté du jeu`;
    meta.append(sv);
  }
  // Langues contenues dans le jeu (nom officiel, sinon nom du fichier)
  const langs = languagesOf(g.official) .length ? languagesOf(g.official) : languagesOf(g.raw);
  if (langs.length) {
    const lr = document.createElement('div');
    lr.className = 'langs';
    lr.title = 'Langues du jeu : ' + langs.map((l) => LANG_NAMES[l]).join(', ')
      + (g.official ? '' : ' (d’après le nom du fichier)');
    for (const l of langs) {
      const chip = document.createElement('span');
      chip.className = 'lang' + (l === (config.language || 'fr') ? ' mine' : '');
      chip.textContent = l.toUpperCase();
      lr.append(chip);
    }
    meta.append(lr);
  }

  el.append(cover, meta);
  const go = () => launch(g);
  el.onclick = go;
  el.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  return el;
}

function render() {
  $('#view-title').textContent = TITLES[filter];
  const grid = $('#grid');
  const empty = $('#empty');
  grid.replaceChildren();
  updateCounts();
  const list = visibleGames();

  if (!list.length) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    if (!config.gamesDirs.length) empty.innerHTML = '<div class="big">▣</div><p>Ajoute ton dossier de jeux dans les <b>Réglages</b> pour remplir ta bibliothèque.</p>';
    else if (query) empty.innerHTML = '<p>Aucun jeu ne correspond à ta recherche.</p>';
    else if (filter === 'fav') empty.innerHTML = '<p>Pas encore de favoris. Clique sur l’étoile ★ d’un jeu.</p>';
    else if (filter === 'recent') empty.innerHTML = '<p>Aucun jeu lancé pour l’instant.</p>';
    else empty.innerHTML = '<p>Aucun jeu trouvé dans tes dossiers (.gb, .gbc, .gba, .nds, .zip, .7z).</p>';
    return;
  }
  empty.classList.add('hidden');
  grid.classList.remove('hidden');
  const frag = document.createDocumentFragment();
  list.forEach((g) => frag.appendChild(card(g)));
  grid.appendChild(frag);
}

async function launch(g) {
  if (config.externalSaves === false) return startGame(g, null);
  openPicker(g);
}

async function startGame(g, choice) {
  const r = await window.api.launch(g.path, g.system, choice, titleOf(g));
  if (!r.ok) { toast(r.error, 5000); return; }
  toast(`Lancement de ${titleOf(g)}…`);
  config = await window.api.getConfig();
}

// ---------- Choix de la sauvegarde ----------
let pickerGame = null;
const fmtDate = (ms) => new Date(ms).toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' });

function saveOption(value, title, sub, checked, extra) {
  const label = document.createElement('label');
  label.className = 'save-opt';
  const input = document.createElement('input');
  input.type = 'radio'; input.name = 'save'; input.value = value; input.checked = checked;
  const txt = document.createElement('div');
  const t = document.createElement('div'); t.className = 'save-title'; t.textContent = title;
  const st = document.createElement('div'); st.className = 'muted small'; st.textContent = sub;
  txt.append(t, st);
  if (extra) txt.append(extra);
  label.append(input, txt);
  return label;
}

async function openPicker(g) {
  pickerGame = g;
  $('#picker-title').textContent = titleOf(g);
  const { saves, last } = await window.api.listSaves(g.path);
  const list = $('#picker-list');
  list.replaceChildren();
  // Présélection : la dernière utilisée, sinon la plus récente non vide, sinon « nouvelle »
  const pre = (saves.find((x) => x.file === last) || saves.find((x) => !x.empty) || {}).file || 'new';
  saves.forEach((x) => list.append(saveOption(x.file, x.label,
    `Modifiée le ${fmtDate(x.mtime)}${x.empty ? ' · vide (aucune partie dedans)' : ''}`, x.file === pre)));
  const name = document.createElement('input');
  name.type = 'text'; name.id = 'new-save-name'; name.className = 'text-input';
  name.placeholder = saves.length ? 'Nom (ex. Nuzlocke)' : 'Nom (facultatif)';
  name.addEventListener('focus', () => { list.querySelector('input[value="new"]').checked = true; });
  list.append(saveOption('new', '+ Nouvelle sauvegarde', 'Commence une partie et la garde dans un nouveau fichier .sav', pre === 'new', name));
  list.append(saveOption('none', 'Jouer sans sauvegarde', 'La cartouche telle quelle : rien n’est enregistré', false));
  $('#picker').classList.remove('hidden');
  $('#btn-play').focus();
}
const closePicker = () => { $('#picker').classList.add('hidden'); pickerGame = null; };
$('#btn-close-picker').onclick = closePicker;
$('#btn-open-folder').onclick = (e) => { e.preventDefault(); if (pickerGame) window.api.showInFolder(pickerGame.path); };
$('#btn-play').onclick = () => {
  const v = document.querySelector('#picker-list input[name="save"]:checked')?.value || 'none';
  const choice = v === 'none' ? { type: 'none' } : v === 'new' ? { type: 'new', label: $('#new-save-name').value } : { type: 'file', file: v };
  const g = pickerGame;
  closePicker();
  startGame(g, choice);
};

async function rescan() {
  games = await window.api.scanGames();
  render();
}

// ---------- Réglages ----------
async function renderSettings() {
  config = await window.api.getConfig();
  $('#ra-path').textContent = config.retroarch || 'Non défini';
  $('#opt-fullscreen').checked = !!config.fullscreen;
  $('#opt-saves').checked = config.externalSaves !== false;
  $('#opt-language').value = config.language || 'fr';
  $('#opt-volume').value = config.volume ?? 100;
  $('#volume-value').textContent = (config.volume ?? 100) + ' %';
  $('#opt-mute').checked = !!config.mute;
  $('#opt-latency').checked = !!config.lowLatency;
  $('#opt-menusounds').checked = !!config.menuSounds;

  const st = await window.api.coresStatus();
  const cores = $('#cores');
  cores.replaceChildren();
  const line = (ok, text) => {
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'ko';
    li.textContent = (ok ? '✔ ' : '✘ ') + text;
    cores.appendChild(li);
  };
  line(st.retroarchOk, st.retroarchOk ? 'RetroArch installé' : 'RetroArch pas encore installé');
  line(!!st.gb, 'Game Boy / Color : ' + (st.gb || 'moteur manquant'));
  line(!!st.gba, 'Game Boy Advance : ' + (st.gba || 'moteur manquant'));
  line(!!st.nds, 'Nintendo DS : ' + (st.nds || 'moteur manquant'));
  $('#btn-open-ra').classList.toggle('hidden', !st.retroarchOk);
  const btn = $('#btn-install');
  if (!installing) {
    const allOk = st.retroarchOk && st.gb && st.gba && st.nds;
    btn.disabled = allOk;
    btn.textContent = allOk ? 'Tout est installé ✔' : st.retroarchOk ? 'Installer les moteurs manquants' : 'Tout installer automatiquement';
  }
  $('#version').textContent = 'Cartouche v' + (await window.api.version());
  renderControls();

  const dirs = $('#dirs');
  dirs.replaceChildren();
  config.gamesDirs.forEach((d) => {
    const li = document.createElement('li');
    const span = document.createElement('code');
    span.className = 'path';
    span.textContent = d;
    const rm = document.createElement('button');
    rm.className = 'ghost';
    rm.textContent = 'Retirer';
    rm.onclick = async () => {
      config = await window.api.setConfig({ gamesDirs: config.gamesDirs.filter((x) => x !== d) });
      renderSettings();
    };
    li.append(span, rm);
    dirs.appendChild(li);
  });
  if (!config.gamesDirs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Aucun dossier pour l’instant.';
    dirs.appendChild(li);
  }
}
const openSettings = () => { renderSettings(); $('#settings').classList.remove('hidden'); };
const closeSettings = () => { $('#settings').classList.add('hidden'); rescan(); };

// ---------- Événements ----------
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  document.querySelectorAll('#nav button').forEach((x) => x.classList.toggle('active', x === b));
  filter = b.dataset.filter;
  render();
});
$('#search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
$('#btn-refresh').onclick = () => { rescan(); toast('Bibliothèque mise à jour'); };
$('#btn-settings').onclick = openSettings;
$('#btn-close-settings').onclick = closeSettings;
$('#btn-done').onclick = closeSettings;
$('#btn-pick-ra').onclick = async () => {
  const p = await window.api.pickRetroArch();
  if (p) { await window.api.setConfig({ retroarch: p }); renderSettings(); }
};
$('#btn-open-ra').onclick = async () => { if (!(await window.api.openRetroArch())) toast('Installe d’abord les moteurs (bouton violet).'); };
let installing = false;
$('#btn-install').onclick = async () => {
  installing = true;
  const btn = $('#btn-install');
  btn.disabled = true;
  btn.textContent = 'Installation en cours…';
  $('#install-box').classList.remove('hidden');
  const r = await window.api.installAll();
  installing = false;
  if (r.ok) { toast('Installation terminée ! Tu peux jouer.'); setTimeout(() => $('#install-box').classList.add('hidden'), 1500); }
  else { $('#install-label').textContent = 'Erreur : ' + r.error; btn.disabled = false; }
  renderSettings();
};
window.api.onSetupProgress(({ label, frac }) => {
  $('#install-label').textContent = label;
  const bar = $('#install-bar').parentElement;
  bar.classList.toggle('indeterminate', frac == null);
  if (frac != null) $('#install-bar').style.width = Math.round(frac * 100) + '%';
});
$('#btn-add-dir').onclick = async () => {
  const d = await window.api.pickGamesDir();
  if (d && !config.gamesDirs.includes(d)) { await window.api.setConfig({ gamesDirs: [...config.gamesDirs, d] }); renderSettings(); }
};
$('#opt-fullscreen').onchange = (e) => window.api.setConfig({ fullscreen: e.target.checked });
$('#opt-saves').onchange = (e) => window.api.setConfig({ externalSaves: e.target.checked });
$('#opt-language').onchange = async (e) => { config = await window.api.setConfig({ language: e.target.value }); render(); };
$('#opt-volume').oninput = (e) => { $('#volume-value').textContent = e.target.value + ' %'; };
$('#opt-volume').onchange = async (e) => { config = await window.api.setConfig({ volume: Number(e.target.value) }); };
$('#opt-mute').onchange = async (e) => { config = await window.api.setConfig({ mute: e.target.checked }); };
$('#opt-latency').onchange = async (e) => { config = await window.api.setConfig({ lowLatency: e.target.checked }); };
$('#opt-menusounds').onchange = async (e) => { config = await window.api.setConfig({ menuSounds: e.target.checked }); };
document.addEventListener('keydown', (e) => {
  if (capturing) return;
  if (e.key === 'Escape' && !$('#settings').classList.contains('hidden')) closeSettings();
  if (e.key === 'Escape' && !$('#picker').classList.contains('hidden')) closePicker();
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); }
});
// Barre « jeu en cours »
const showPlaying = (t) => { $('#playing-title').textContent = t; $('#playing-bar').classList.remove('hidden'); };
window.api.onStarted(showPlaying);
window.api.currentGame().then((t) => { if (t) showPlaying(t); });
$('#btn-restore').onclick = () => window.api.restoreGame();
$('#btn-close-game').onclick = () => window.api.closeGame();

window.api.onExited(async (saved) => {
  $('#playing-bar').classList.add('hidden');
  config = await window.api.getConfig();
  if (saved && saved.status === 'enregistree') toast('Sauvegarde enregistrée 💾 ' + saved.file.split(/[\\/]/).pop());
  else if (saved && saved.status === 'erreur') toast('Attention, la sauvegarde n’a pas pu être écrite : ' + saved.error, 8000);
  rescan();
});
window.api.onError((msg) => toast('Erreur au lancement : ' + msg, 6000));

// ---------- Contrôles ----------
// Position physique de la touche (KeyboardEvent.code) → nom de touche RetroArch
function codeToRetroArch(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^Digit(\d)$/.exec(code))) return 'num' + m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return 'keypad' + m[1];
  if ((m = /^F(\d{1,2})$/.exec(code))) return 'f' + m[1];
  return {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', NumpadEnter: 'kp_enter',
    Space: 'space', ShiftLeft: 'shift', ShiftRight: 'rshift', ControlLeft: 'ctrl', ControlRight: 'rctrl', AltLeft: 'alt',
    AltRight: 'ralt', Tab: 'tab', Backspace: 'backspace', Escape: 'escape', Comma: 'comma', Period: 'period',
    Semicolon: 'semicolon', Slash: 'slash', Backslash: 'backslash', Minus: 'minus', Equal: 'equals',
    BracketLeft: 'leftbracket', BracketRight: 'rightbracket', Quote: 'quote', Backquote: 'tilde', Insert: 'insert',
    Delete: 'del', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', NumpadAdd: 'add',
    NumpadSubtract: 'subtract', NumpadMultiply: 'multiply', NumpadDivide: 'divide', NumpadDecimal: 'kp_period',
  }[code] || null;
}
const keyLabel = (e) => ({ ' ': 'Espace', Enter: 'Entrée', Escape: 'Échap', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←',
  ArrowRight: '→', Shift: e.code === 'ShiftRight' ? 'Maj droite' : 'Maj', Control: e.code === 'ControlRight' ? 'Ctrl droit' : 'Ctrl',
  Alt: 'Alt', Tab: 'Tab', Backspace: 'Retour' }[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key));

let controlsMeta = null;
let capturing = null;
async function renderControls() {
  if (!controlsMeta) controlsMeta = await window.api.controlsList();
  const b = { ...controlsMeta.defaults, ...(config.bindings || {}) };
  for (const [boxId, list] of [['#controls-actions', controlsMeta.actions], ['#controls-hotkeys', controlsMeta.hotkeys]]) {
    const box = $(boxId);
    box.replaceChildren();
    for (const { key, label } of list) {
      const name = document.createElement('span');
      name.textContent = label;
      const btn = document.createElement('button');
      btn.className = 'keycap';
      btn.textContent = b[key] ? b[key].label : '—';
      btn.onclick = () => {
        if (capturing) capturing.btn.classList.remove('listening');
        capturing = { key, btn };
        btn.classList.add('listening');
        btn.textContent = 'Appuie sur une touche…';
      };
      box.append(name, btn);
    }
  }
}
document.addEventListener('keydown', async (e) => {
  if (!capturing) return;
  e.preventDefault(); e.stopPropagation();
  const { key } = capturing;
  capturing = null;
  if (e.code === 'Escape' && key !== 'input_exit_emulator') { renderControls(); return; }
  const rk = codeToRetroArch(e.code);
  if (!rk) { toast('Cette touche n’est pas prise en charge.'); renderControls(); return; }
  const b = { ...controlsMeta.defaults, ...(config.bindings || {}) };
  // Si la touche servait déjà ailleurs, on échange les deux
  const other = Object.keys(b).find((k) => k !== key && b[k] && b[k].rk === rk);
  if (other) { b[other] = b[key]; toast('Touche échangée avec une autre action.'); }
  b[key] = { rk, label: keyLabel(e) };
  config = await window.api.setConfig({ bindings: b });
  renderControls();
}, true);
$('#btn-reset-controls').onclick = async () => { config = await window.api.setConfig({ bindings: {} }); renderControls(); toast('Touches par défaut rétablies.'); };

// ---------- Mises à jour ----------
const banner = (text) => { $('#update-text').textContent = text; $('#update-banner').classList.remove('hidden'); };
window.api.onUpdateAvailable((v) => banner(`Nouvelle version ${v} en téléchargement…`));
window.api.onUpdateProgress((p) => banner(`Téléchargement de la mise à jour… ${p} %`));
window.api.onUpdateReady((v) => { banner(`La version ${v} est prête.`); $('#btn-update').classList.remove('hidden'); });
$('#btn-update').onclick = () => window.api.installUpdate();
$('#btn-check-update').onclick = async (e) => {
  e.preventDefault();
  toast('Recherche de mises à jour…');
  const r = await window.api.checkUpdate();
  if (r === 'à jour') toast('Aucune nouvelle version pour l’instant (GitHub peut mettre quelques minutes à l’annoncer).');
  else if (r === 'trouvée') toast('Nouvelle version trouvée : téléchargement en cours (bandeau en haut).');
  else toast('Impossible de vérifier pour l’instant. Réessaie plus tard.');
};

// ---------- Démarrage ----------
(async () => {
  config = await window.api.getConfig();
  await rescan();
  const st = await window.api.coresStatus();
  if (!st.retroarchOk || !config.gamesDirs.length || !st.gb || !st.gba || !st.nds) openSettings();
})();
