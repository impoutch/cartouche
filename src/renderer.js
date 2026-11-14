// Cartouche — interface
const $ = (s) => document.querySelector(s);
const LABELS = { gb: 'Game Boy', gbc: 'Game Boy Color', nds: 'Nintendo DS' };
const TITLES = { all: 'Tous les jeux', fav: 'Favoris', recent: 'Récents', gb: 'Game Boy', gbc: 'Game Boy Color', nds: 'Nintendo DS' };

let config = null;
let games = [];
let filter = 'all';
let query = '';

// « Pokemon - Yellow Version (USA, Europe) » → « Pokemon - Yellow Version »
const cleanTitle = (raw) => raw.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').trim() || raw;
// Jaquettes : base communautaire libretro-thumbnails (fonctionne avec les noms de fichiers « No-Intro »)
const coverUrl = (g) =>
  `https://thumbnails.libretro.com/${encodeURIComponent(g.thumbs)}/Named_Boxarts/${encodeURIComponent(g.raw.replace(/[&*\/:`<>?\\|"]/g, '_'))}.png`;

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
    list = list.filter((g) => g.raw.toLowerCase().includes(q));
  }
  return list;
}

function updateCounts() {
  const set = (id, n) => ($(id).textContent = n || '');
  set('#c-all', games.length);
  set('#c-fav', games.filter((g) => config.favorites.includes(g.path)).length);
  set('#c-recent', games.filter((g) => config.recent[g.path]).length);
  for (const k of ['gb', 'gbc', 'nds']) set('#c-' + k, games.filter((g) => g.system === k).length);
}

function card(g) {
  const el = document.createElement('article');
  el.className = `card sys-${g.system}`;
  el.tabIndex = 0;
  const title = cleanTitle(g.raw);
  const fav = config.favorites.includes(g.path);

  const cover = document.createElement('div');
  cover.className = 'cover';
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.textContent = title.slice(0, 2).toUpperCase();
  cover.appendChild(ph);
  const img = new Image();
  img.loading = 'lazy';
  img.alt = '';
  img.onload = () => { cover.classList.add('has-img'); };
  img.onerror = () => img.remove();
  img.src = coverUrl(g);
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
  h.title = g.raw;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = LABELS[g.system];
  meta.append(h, badge);

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
    else empty.innerHTML = '<p>Aucun jeu trouvé dans tes dossiers (.gb, .gbc, .nds).</p>';
    return;
  }
  empty.classList.add('hidden');
  grid.classList.remove('hidden');
  const frag = document.createDocumentFragment();
  list.forEach((g) => frag.appendChild(card(g)));
  grid.appendChild(frag);
}

async function launch(g) {
  const r = await window.api.launch(g.path, g.system);
  if (!r.ok) { toast(r.error, 5000); return; }
  toast(`Lancement de ${cleanTitle(g.raw)}…`);
  config = await window.api.getConfig();
}

async function rescan() {
  games = await window.api.scanGames();
  render();
}

// ---------- Réglages ----------
async function renderSettings() {
  config = await window.api.getConfig();
  $('#ra-path').textContent = config.retroarch || 'Non défini';
  $('#opt-fullscreen').checked = !!config.fullscreen;

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
  line(!!st.nds, 'Nintendo DS : ' + (st.nds || 'moteur manquant'));
  $('#btn-open-ra').classList.toggle('hidden', !st.retroarchOk);
  const btn = $('#btn-install');
  if (!installing) {
    const allOk = st.retroarchOk && st.gb && st.nds;
    btn.disabled = allOk;
    btn.textContent = allOk ? 'Tout est installé ✔' : st.retroarchOk ? 'Installer les moteurs manquants' : 'Tout installer automatiquement';
  }
  $('#version').textContent = 'Cartouche v' + (await window.api.version());

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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#settings').classList.contains('hidden')) closeSettings();
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); }
});
window.api.onExited(async () => { config = await window.api.getConfig(); render(); });
window.api.onError((msg) => toast('Erreur au lancement : ' + msg, 6000));

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
  if (r === 'à jour') toast('Tu as déjà la dernière version 👍');
  else if (r === 'trouvée') toast('Nouvelle version trouvée : téléchargement en cours (bandeau en haut).');
  else toast('Impossible de vérifier pour l’instant. Réessaie plus tard.');
};

// ---------- Démarrage ----------
(async () => {
  config = await window.api.getConfig();
  await rescan();
  const st = await window.api.coresStatus();
  if (!st.retroarchOk || !config.gamesDirs.length || !st.gb || !st.nds) openSettings();
})();
