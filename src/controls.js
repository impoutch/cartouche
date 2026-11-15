// Contrôles au clavier : actions de la console et raccourcis, transmis à RetroArch.
// Les touches sont identifiées par leur position physique (comme RetroArch sous Windows).

const ACTIONS = [
  // [clé RetroArch, libellé, touche par défaut (nom RetroArch), libellé par défaut]
  ['input_player1_up', 'Haut', 'up', '↑'],
  ['input_player1_down', 'Bas', 'down', '↓'],
  ['input_player1_left', 'Gauche', 'left', '←'],
  ['input_player1_right', 'Droite', 'right', '→'],
  ['input_player1_a', 'A  ·  ○ (PS)', 'x', 'X'],
  ['input_player1_b', 'B  ·  ✕ (PS)', 'z', 'Z'],
  ['input_player1_x', 'X  ·  △ (PS)', 's', 'S'],
  ['input_player1_y', 'Y  ·  □ (PS)', 'a', 'A'],
  ['input_player1_l', 'L  ·  L1', 'q', 'Q'],
  ['input_player1_r', 'R  ·  R1', 'w', 'W'],
  ['input_player1_l2', 'L2 (PS)', 'e', 'E'],
  ['input_player1_r2', 'R2 (PS)', 'r', 'R'],
  ['input_player1_start', 'Start', 'enter', 'Entrée'],
  ['input_player1_select', 'Select', 'rshift', 'Maj droite'],
];
const HOTKEYS = [
  ['input_menu_toggle', 'Menu (sauvegardes, manettes…)', 'f1', 'F1'],
  ['input_save_state', 'Sauvegarde rapide', 'f2', 'F2'],
  ['input_load_state', 'Chargement rapide', 'f4', 'F4'],
  ['input_toggle_fast_forward', 'Avance rapide (activer/couper)', 'space', 'Espace'],
];
// Raccourcis RetroArch sur des lettres qu'on désactive pour éviter les conflits avec tes touches
const DISABLED_HOTKEYS = [
  // Échap ne quitte plus le jeu : un double Échap le réduit (géré par Cartouche)
  'input_exit_emulator',
  'input_pause_toggle', 'input_hold_fast_forward', 'input_rewind', 'input_reset', 'input_frame_advance',
  'input_shader_next', 'input_shader_prev', 'input_hold_slowmotion', 'input_toggle_slowmotion',
  'input_movie_record_toggle', 'input_cheat_toggle', 'input_osk_toggle', 'input_netplay_game_watch',
  'input_toggle_fullscreen', 'input_ai_service', 'input_recording_toggle', 'input_streaming_toggle',
  'input_disk_eject_toggle', 'input_disk_next', 'input_disk_prev',
];

function defaults() {
  const out = {};
  for (const [key, , rk, label] of [...ACTIONS, ...HOTKEYS]) out[key] = { rk, label };
  return out;
}

function configLines(bindings) {
  const b = { ...defaults(), ...(bindings || {}) };
  const lines = [];
  for (const [key] of [...ACTIONS, ...HOTKEYS]) lines.push(`${key} = "${(b[key] && b[key].rk) || 'nul'}"`);
  const used = new Set(Object.values(b).map((x) => x && x.rk));
  for (const key of DISABLED_HOTKEYS) lines.push(`${key} = "nul"`);
  // Pas de touche « d'activation » requise pour les raccourcis
  lines.push('input_enable_hotkey = "nul"');
  return { lines, used };
}

module.exports = { ACTIONS, HOTKEYS, defaults, configLines };
