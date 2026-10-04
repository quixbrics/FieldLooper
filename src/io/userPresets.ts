/*
 * Presets the user saves: the loop's settings and the whole FX chain (with its
 * automation), never audio. Kept in this browser's localStorage; a failure to
 * read or write is treated as "none saved".
 */
import type { Preset } from '../audio/engine';

const KEY = 'fieldlooper.presets';

export function loadUserPresets(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s): s is Preset => !!s && typeof s.name === 'string' && Array.isArray(s.chain)).map((s) => ({ ...s, user: true })) : [];
  } catch {
    return [];
  }
}

function write(list: Preset[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Save under a name; a preset with the same name is replaced. */
export function saveUserPreset(preset: Preset): boolean {
  const name = preset.name.trim().slice(0, 40);
  if (!name) return false;
  const list = loadUserPresets().filter((s) => s.name !== name);
  list.push({ ...preset, name, user: true });
  return write(list);
}

export function deleteUserPreset(name: string): boolean {
  return write(loadUserPresets().filter((s) => s.name !== name));
}
