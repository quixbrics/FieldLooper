/*
 * FieldLooper — mobile UI. Portrait, one hand: the Loop tab (record, stretch),
 * the FX tab (the chain), the Seq tab, a fixed transport at the bottom with
 * Performance Record, and settings in a sheet.
 */
import { Engine, MAX_PERF_SECONDS, PERF_WARN_SECONDS } from '../audio/engine';
import { MAX_SECONDS } from '../audio/loopfx';
import { stamp } from '../io/project';
import { loadSaved } from '../io/autosave';
import { buildChainPanel } from './chainPanel';
import { buildSeqPanel } from './seqPanel';
import { buildSheet } from './settings';
import { TrackCard } from './trackCard';
import { fmtTime, h } from './dom';

/** survives a rebuild of the UI (a project opening or a preset applying re-creates every control) */
let activeTab = 0;
let pendingMessage = '';
let uiLife: AbortController | null = null;

export function mountApp(root: HTMLElement, engine: Engine) {
  uiLife?.abort();
  uiLife = new AbortController();
  const life = uiLife.signal;
  engine.clearUiListeners();

  let toastTimer = 0;
  const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  const banner = h('button', { class: 'banner', hidden: true, onclick: () => void engine.start() }, 'Audio paused — tap to resume');
  const micNote = h('p', { class: 'mic-note', hidden: true });
  const inputBar = h('i', { class: 'in-bar' });
  const limiter = h('span', { class: 'led', title: 'Safety limiter', 'aria-label': 'Safety limiter' });
  let inputHold = 0;

  const say = (msg: string) => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
  };
  const busy = () => {
    if (engine.recTrack >= 0) {
      say('Stop recording first.');
      return true;
    }
    if (engine.performing) {
      say('Stop the performance recording first.');
      return true;
    }
    return false;
  };

  /* ------------------------------------------------------------- loop -- */

  const showMicNote = () => {
    micNote.textContent = engine.micError ? `${engine.micError} Tap the red button to try again.` : '';
    micNote.hidden = !engine.micError;
  };
  const syncAll = () => {
    card.syncState();
    playBtn.disabled = engine.recTrack >= 0;
  };

  async function onRec(i: number) {
    if (!engine.started) await engine.start();
    if (engine.recTrack === i) return stopRec();
    if (engine.recTrack >= 0) return;
    // the loop is claimed at once; the mic may take a moment to open on a phone
    const started = engine.startRecording(i);
    card.wave.setRecLevel(0, '00:00');
    syncAll();
    if (!(await started)) {
      syncAll();
      say(engine.micError ?? 'Could not start the microphone.');
      showMicNote();
    } else {
      micNote.hidden = true;
    }
  }

  async function stopRec() {
    if (engine.recTrack < 0) return;
    const r = await engine.stopRecording();
    syncAll();
    if (r.ok) return;
    if (r.reason === 'quiet') say('No signal heard — check the microphone.');
    else if (r.reason === 'short') say('Too short — hold on for at least ¼ second.');
  }

  const card = new TrackCard(engine, 0, { say, rec: (k) => void onRec(k) });

  /* ---------------------------------------------------------- transport -- */

  const playBtn = h('button', { class: 'play', onclick: () => {
    engine.setPlaying(!engine.playing);
    syncPlay();
  } });
  const syncPlay = () => {
    playBtn.textContent = engine.playing ? '■  Stop' : '▶  Play';
    playBtn.setAttribute('aria-pressed', String(engine.playing));
  };
  const master = h('input', { class: 'range', type: 'range', min: 0, max: 1, step: 0.01, value: engine.masterLevel, 'aria-label': 'Master level' });
  master.addEventListener('input', () => engine.setMaster(Number(master.value)));

  /* ----------------------------------------------------------- settings -- */

  const sheet = buildSheet(engine, { say, busy, after: (m) => (pendingMessage = m) });

  /* ---- Performance Record: everything you hear, while you play ---- */
  const perfBtn = h('button', { class: 'mixrec', 'aria-pressed': false, 'aria-label': 'Performance record: record everything you hear while you play', onclick: () => void togglePerf() }, '● REC');
  const showPerf = (sec: number | null) => {
    perfBtn.setAttribute('aria-pressed', String(sec !== null));
    perfBtn.classList.toggle('warn', sec !== null && sec >= PERF_WARN_SECONDS);
    perfBtn.textContent = sec === null ? '● REC' : `■ ${fmtTime(sec)}`;
  };
  if (engine.performing) showPerf(0);
  async function togglePerf() {
    if (!engine.started) return say('Tap to start first.');
    if (!engine.performing) {
      if (engine.startPerformance()) {
        showPerf(0);
        say('Recording everything you hear — play away.');
      }
      return;
    }
    perfBtn.disabled = true;
    const out = await engine.stopPerformance();
    perfBtn.disabled = false;
    showPerf(null);
    if (!out) return say('Nothing was recorded.');
    sheet.offerFile(out.wav, `FieldLooper-${stamp()}.wav`, `Performance ${fmtTime(out.seconds)}`);
  }

  /* ------------------------------------------------------------- layout -- */

  const header = h('header', { class: 'top' },
    h('h1', {}, 'Field', h('b', {}, 'Looper')),
    h('div', { class: 'in-meter', title: 'Microphone level' }, inputBar),
    limiter,
    h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => sheet.open() }, '⚙'),
  );
  const transport = h('footer', { class: 'transport' }, playBtn, perfBtn, h('label', { class: 'master' }, h('span', {}, 'Vol'), master));

  const chain = buildChainPanel(engine, { say });
  const loopTab = h('main', { class: 'tracks', id: 'tab-loop' }, micNote, card.root);
  const fxTab = h('main', { class: 'tracks', id: 'tab-fx', hidden: true }, chain.el);
  const seqTab = h('main', { class: 'tracks', id: 'tab-seq', hidden: true });
  const panels = [loopTab, fxTab, seqTab];
  const select = (k: number) => {
    activeTab = k;
    tabBtns.forEach((b, j) => b.setAttribute('aria-selected', String(j === k)));
    panels.forEach((p, j) => (p.hidden = j !== k));
  };
  const tabBtns = ['Loop', 'FX', 'Seq'].map((label, k) => h('button', { class: 'tab', role: 'tab', 'aria-selected': k === activeTab, onclick: () => select(k) }, label));
  const fxCount = h('span', { class: 'tab-n mono' });
  tabBtns[1].append(fxCount);
  const syncCount = () => (fxCount.textContent = engine.chain.length ? ` ${engine.chain.length}` : '');

  // the Seq tab depends on which resonators are in the chain: rebuild it when the chain changes shape
  let seqLife: AbortController | null = null;
  life.addEventListener('abort', () => seqLife?.abort());
  const buildSeq = () => {
    seqLife?.abort();
    seqLife = new AbortController();
    seqTab.replaceChildren(buildSeqPanel(engine, seqLife.signal, { say, showFx: () => select(1) }));
  };
  buildSeq();
  syncCount();
  panels.forEach((p, j) => (p.hidden = j !== activeTab));
  const tabs = h('nav', { class: 'tabs', role: 'tablist' }, ...tabBtns);
  const shell = h('div', { class: 'shell' }, header, tabs, banner, loopTab, fxTab, seqTab, transport, sheet.el, chain.sheet, toast);

  /* ------------------------------------------------------------- splash -- */

  const splash = h('div', { class: 'splash' },
    h('div', { class: 'splash-card' },
      h('img', { class: 'splash-icon', src: `${import.meta.env.BASE_URL}icon-192.png`, alt: '', width: 72, height: 72 }),
      h('h1', {}, 'Field', h('b', {}, 'Looper')),
      h('p', {}, 'Record the world into a loop, stretch it into a drone, and play it through a chain of effects you build yourself. Record your moves on any effect and they loop too.'),
      h('p', { class: 'hint' }, 'Headphones recommended. FieldLooper needs your microphone to record — nothing leaves your phone.'),
      h('button', { class: 'btn primary big', onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        b.textContent = 'Starting…';
        try {
          await engine.start();
        } catch (err) {
          b.disabled = false;
          b.textContent = 'Try again';
          say(`Could not start audio: ${(err as Error).message}`);
          return;
        }
        // bring back the last session, if there is one
        const saved = await loadSaved();
        if (saved && (saved.loop || saved.project.chain?.length)) {
          pendingMessage = 'Restored your last session';
          engine.applyProject(saved.project, saved.loop, saved.sampleRate);
        }
        splash.remove();
        syncPlay();
        showMicNote();
      } }, 'Tap to start'),
    ),
  );

  root.replaceChildren(...(engine.started ? [shell] : [shell, splash]));
  root.removeAttribute('aria-busy');
  showMicNote();
  if (pendingMessage) {
    say(pendingMessage);
    pendingMessage = '';
  }
  syncPlay();
  syncAll();

  /* ------------------------------------------------------------- events -- */

  engine.events = {
    level(peak) {
      // fast rise, slow fall
      inputHold = Math.max(peak, inputHold * 0.85);
      inputBar.style.transform = `scaleX(${Math.min(1, Math.sqrt(inputHold))})`;
      inputBar.classList.toggle('hot', peak > 0.9);
      if (engine.recTrack >= 0) card.wave.setRecLevel(peak);
    },
    pos(_track, v) {
      card.wave.setPos(v);
    },
    limiter(gr) {
      limiter.classList.toggle('on', gr < -1);
    },
    ctxState(state) {
      banner.hidden = state === 'running';
    },
    recTime(_track, sec) {
      card.wave.setRecLevel(0, `${fmtTime(sec)} / ${fmtTime(MAX_SECONDS)}`);
    },
    recAutoStop() {
      void stopRec();
      say(`Reached ${MAX_SECONDS} seconds.`);
    },
    blowup() {
      say('Audio glitch caught and reset.');
    },
    track() {
      card.refresh();
      syncAll();
    },
    trackParams() {
      card.syncControls();
    },
    // a project, preset or new project replaced the state: rebuild every control from it
    project() {
      mountApp(root, engine);
    },
    chain() {
      chain.render();
      buildSeq();
      syncCount();
    },
    auto(frame) {
      if (!fxTab.hidden) chain.onAuto(frame);
    },
    armed() {
      chain.onArmed();
    },
    perfTime(sec) {
      showPerf(sec);
    },
    perfAutoStop() {
      void togglePerf();
      say(`Reached ${MAX_PERF_SECONDS / 60} minutes — saved what you played.`);
    },
  };
}
