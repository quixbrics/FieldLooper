/*
 * The Settings sheet: presets (stock and your own), project files, and the
 * audio facts. It also hosts the "your file is ready" card, so
 * the Share / Save tap is a real tap (the share sheet needs one).
 */
import { Engine, MAX_PERF_SECONDS, type Preset } from '../audio/engine';
import { MAX_SECONDS } from '../audio/loopfx';
import { clearSaved } from '../io/autosave';
import { packProject, shareOrDownload, stamp, unpackProject } from '../io/project';
import { PRESETS } from '../io/presets';
import { deleteUserPreset, loadUserPresets, saveUserPreset } from '../io/userPresets';
import { getTheme, setTheme, type Theme } from './theme';
import { h } from './dom';

export interface SheetHelpers {
  say(msg: string): void;
  /** true (and says so) if something is recording */
  busy(): boolean;
  /** a message to show once the UI has been rebuilt from new state */
  after(msg: string): void;
}

export interface Sheet {
  el: HTMLElement;
  open(): void;
  close(): void;
  offerFile(blob: Blob, name: string, what: string): void;
}

export function buildSheet(engine: Engine, hp: SheetHelpers): Sheet {
  const el = h('div', { class: 'sheet', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' });
  const close = () => (el.hidden = true);

  /* ---- a finished file, waiting for a tap ---- */
  const fileSlot = h('div', { class: 'file-ready', hidden: true });
  const offerFile = (blob: Blob, name: string, what: string) => {
    const mb = (blob.size / 1048576).toFixed(1);
    const go = h('button', { class: 'btn primary', onclick: async () => {
      const r = await shareOrDownload(blob, name);
      if (r !== 'cancelled') {
        fileSlot.hidden = true;
        hp.say(r === 'shared' ? 'Shared.' : 'Saved to your downloads.');
      }
    } }, 'Share / Save');
    fileSlot.replaceChildren(h('p', {}, h('b', {}, what), ` · ${mb} MB`), h('p', { class: 'hint mono' }, name), h('div', { class: 'row actions' }, go, h('button', { class: 'btn', onclick: () => (fileSlot.hidden = true) }, 'Discard')));
    fileSlot.hidden = false;
    el.hidden = false;
    fileSlot.scrollIntoView({ block: 'nearest' });
  };

  /* ---- presets ---- */
  const grid = h('div', { class: 'scenes' });
  const apply = (sc: Preset) => {
    if (hp.busy()) return;
    hp.after(`Preset: ${sc.name}`);
    engine.applyPreset(sc);
  };
  const renderScenes = () => {
    const cell = (sc: Preset) => {
      const b = h('button', { class: 'scene', onclick: () => apply(sc) }, h('b', {}, sc.name), h('span', {}, sc.blurb));
      if (!sc.user) return b;
      let armed = 0;
      const del = h('button', { class: 'scene-del', 'aria-label': `Delete preset ${sc.name}`, onclick: () => {
        if (!armed) {
          del.textContent = 'Delete?';
          armed = window.setTimeout(() => { armed = 0; del.textContent = '✕'; }, 3000);
          return;
        }
        window.clearTimeout(armed);
        deleteUserPreset(sc.name);
        renderScenes();
      } }, '✕');
      return h('div', { class: 'scene-wrap' }, b, del);
    };
    grid.replaceChildren(...PRESETS.map(cell), ...loadUserPresets().map(cell));
  };
  renderScenes();
  const nameBox = h('input', { class: 'text', type: 'text', maxlength: 40, placeholder: 'Name this preset', 'aria-label': 'Preset name', autocomplete: 'off' });
  const saveScene = () => {
    const name = nameBox.value.trim();
    if (!name) return hp.say('Give the preset a name first.');
    if (PRESETS.some((s) => s.name === name)) return hp.say('That name is used by a built-in preset.');
    if (!saveUserPreset(engine.capturePreset(name))) return hp.say('Could not save (is storage full or blocked?).');
    nameBox.value = '';
    renderScenes();
    hp.say(`Saved preset “${name}”.`);
  };

  /* ---- project ---- */
  const openFile = h('input', { type: 'file', accept: '.fieldlooper,.zip,application/zip', hidden: true });
  openFile.addEventListener('change', async () => {
    const f = openFile.files?.[0];
    openFile.value = '';
    if (!f || hp.busy()) return;
    try {
      const { project, loop, sampleRate } = unpackProject(await f.arrayBuffer());
      hp.after(`Opened ${f.name}`);
      const { dropped } = engine.applyProject(project, loop, sampleRate);
      if (dropped) hp.after(`Opened ${f.name} — ${dropped} effect${dropped > 1 ? 's' : ''} this version does not have ${dropped > 1 ? 'were' : 'was'} left out`);
    } catch (e) {
      hp.say((e as Error).message || 'Could not open that file.');
    }
  });
  let eraseArmed = 0;
  const eraseBtn = h('button', { class: 'btn danger', onclick: async () => {
    if (hp.busy()) return;
    if (!eraseArmed) {
      eraseBtn.textContent = 'Tap again to erase everything';
      eraseArmed = window.setTimeout(() => { eraseArmed = 0; eraseBtn.textContent = 'New project'; }, 3500);
      return;
    }
    window.clearTimeout(eraseArmed);
    eraseArmed = 0;
    eraseBtn.textContent = 'New project';
    await clearSaved();
    hp.after('New project');
    engine.newProject();
  } }, 'New project');

  /* ---- appearance and audio ---- */
  const themeBtns = (['dark', 'light'] as Theme[]).map((t) =>
    h('button', { class: 'seg-btn', 'aria-pressed': getTheme() === t, onclick: () => {
      setTheme(t);
      themeBtns.forEach((b, k) => b.setAttribute('aria-pressed', String((['dark', 'light'] as Theme[])[k] === t)));
    } }, t === 'dark' ? 'Dark' : 'Light'),
  );
  const info = h('p', { class: 'hint mono' });
  const refreshInfo = () => {
    const d = engine.diag;
    const t = d.take;
    info.textContent =
      `Audio ${d.ctxRate || '–'} Hz · mic ${d.micRate ?? 'n/a'} Hz · session ${d.session} · mic ${engine.micOpen ? 'open' : 'closed'}` +
      (t ? ` · last take ${t.heardSeconds.toFixed(1)} s heard / ${t.realSeconds.toFixed(1)} s real${t.repaired !== 1 ? ` — speed corrected ×${(1 / t.repaired).toFixed(2)}` : ''}` : '');
  };

  el.append(
    h('div', { class: 'sheet-body' },
      h('h2', {}, 'Settings'),
      fileSlot,
      h('h3', {}, 'Presets'),
      h('p', { class: 'hint' }, 'Starting points: a stretch mode and a whole FX chain, with any automation. Applying one replaces the chain; your recording stays. Save your own below.'),
      grid,
      h('div', { class: 'save-row' }, nameBox, h('button', { class: 'btn', onclick: saveScene }, 'Save current as preset')),
      h('h3', {}, 'Project'),
      h('p', { class: 'hint' }, 'Your session is kept on this phone automatically. Save a project file to back it up or move it: it is a zip with the loop as a WAV inside, and the FX chain with its automation.'),
      h('div', { class: 'row actions' },
        h('button', { class: 'btn', onclick: async () => {
          if (hp.busy()) return;
          if (!engine.loops[0] && !engine.chain.length) return hp.say('Record a sound or build a chain first.');
          offerFile(await packProject(engine.getProject(), engine.loops[0]), `FieldLooper-${stamp()}.fieldlooper`, 'Project');
        } }, 'Save project'),
        h('button', { class: 'btn', onclick: () => openFile.click() }, 'Open project…'),
        openFile,
      ),
      eraseBtn,
      h('h3', {}, 'Appearance'),
      h('div', { class: 'seg' }, ...themeBtns),
      h('h3', {}, 'Recording'),
      h('p', { class: 'hint' }, `Use headphones so the mic does not hear the speaker. Takes run up to ${MAX_SECONDS} seconds and are recorded as they are: use Normalise (under More) to bring a quiet one up. ● REC next to Play is Performance Record: everything you hear while you play, every move included, up to ${MAX_PERF_SECONDS / 60} minutes, as a 24-bit WAV.`),
      info,
      h('h3', {}, 'If something goes wrong'),
      h('button', { class: 'btn', onclick: () => { engine.panic(); close(); hp.say('Reset.'); } }, 'Reset audio engine'),
      h('button', { class: 'btn primary', onclick: close }, 'Done'),
    ),
  );
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  return {
    el,
    open: () => {
      refreshInfo();
      renderScenes();
      el.hidden = false;
    },
    close,
    offerFile,
  };
}
