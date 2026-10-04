/*
 * The Seq tab: a generative sequencer that walks a Resonator in the FX chain
 * through a scale. With no Resonator in the chain it offers to add one; with
 * several, you pick which it plays.
 */
import { Engine, NOTE_NAMES } from '../audio/engine';
import { MODES, MODE_ORDER } from '../music/theory';
import { MOTIONS, type Motion } from '../music/sequencer';
import type { Slot } from '../fx/slot';
import { h } from './dom';
import { pills, slider } from './controls';

/** step length slider position (0–1) ⇄ seconds, 0.15 s – 30 s */
const rateFrom = (v: number) => 0.15 * Math.pow(200, v);
const posFromRate = (r: number) => Math.log(r / 0.15) / Math.log(200);
/** glide slider position ⇄ seconds, 5 ms – 4 s */
const glideFrom = (v: number) => 0.005 * Math.pow(800, v);
const posFromGlide = (g: number) => Math.log(Math.max(0.005, g) / 0.005) / Math.log(800);

const fmtSec = (t: number) => (t < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(t < 10 ? 1 : 0)} s`);

/** The Seq tab. Rebuild it (call again) when the chain changes shape. */
export function buildSeqPanel(engine: Engine, life: AbortSignal, hp: { say(msg: string): void; showFx(): void }): HTMLElement {
  const q = engine.sequencer;
  const target = engine.seqSlot();
  const resos = engine.chain.filter((s) => s.type === 'resonator');

  if (!target) {
    if (engine.seq.on) engine.setSeqOn(false);
    return h('div', { class: 'fx-panel' },
      h('section', { class: 'fx-card' },
        h('header', {}, h('h2', {}, 'Sequencer'), h('span', { class: 'sub' }, 'needs a Resonator')),
        h('p', { class: 'hint' }, 'The sequencer plays a Resonator in your FX chain: a bank of tuned strings that the loop rings. Add one and it walks it through a scale.'),
        h('button', { class: 'btn primary', onclick: () => {
          if (!engine.addSlot('resonator')) return hp.say('The chain is full — remove an effect first.');
          hp.say('Resonator added to the end of the chain.');
        } }, '＋  Add a Resonator'),
      ),
    );
  }
  const t: Slot = target;

  /* ---- on/off + now playing ---- */
  const nowName = h('b', { class: 'now-note mono' }, '–');
  const nowSub = h('span', { class: 'sub' }, 'stopped');
  const onBtn = h('button', { class: 'big-toggle', 'aria-pressed': engine.seq.on, onclick: () => engine.setSeqOn(!engine.seq.on) }, 'Sequencer');
  const which = resos.length > 1
    ? [h('div', { class: 'label-row' }, 'Plays'), pills(resos.map((r) => ({ label: `Resonator ${engine.chain.indexOf(r) + 1}`, value: engine.chain.indexOf(r) })), engine.chain.indexOf(t), (i) => engine.setSeqTarget(engine.chain[i].id))]
    : [];
  const head = h('section', { class: 'fx-card' },
    h('div', { class: 'seq-head' }, onBtn, h('div', { class: 'now' }, nowName, nowSub)),
    ...which,
    h('p', { class: 'hint' }, `Moves Resonator ${engine.chain.indexOf(t) + 1} (in the FX chain) through the scale. Set its Decay short and turn Pluck up to hear each step as a plucked note.`),
    h('button', { class: 'btn', onclick: () => hp.showFx() }, 'Show the Resonator'),
  );

  /* ---- the note strip ---- */
  const strip = h('div', { class: 'note-strip', role: 'group', 'aria-label': 'Scale notes — tap to play' });
  let stripBtns: HTMLButtonElement[] = [];
  const buildStrip = () => {
    const steps = MODES[q.s.scale].steps;
    stripBtns = [];
    for (let i = 0; i <= q.max; i++) {
      const semis = steps[i % steps.length] + 12 * Math.floor(i / steps.length);
      const name = NOTE_NAMES[(Math.round(t.p.root) + semis) % 12];
      const b = h('button', { class: `note${i % steps.length === 0 ? ' tonic' : ''}`, 'aria-label': `${name}, play`, onclick: () => engine.seqSet(i) }, name);
      stripBtns.push(b);
    }
    strip.replaceChildren(...stripBtns);
  };

  /* ---- settings ---- */
  const keys = pills(NOTE_NAMES.map((n, i) => ({ label: n, value: i })), Math.round(t.p.root), (v) => engine.setSlotParam(t.id, 'root', v), 'chips keys');
  const oct = slider('Octave', 1, 5, 1, Math.round(t.p.octave), (v) => `Oct ${v}`, (v) => engine.setSlotParam(t.id, 'octave', v), 'Octave of the lowest string (3 puts A at 220 Hz)');
  const glide = slider('Glide', 0, 1, 0.005, posFromGlide(t.p.glide), (v) => (v < 0.05 ? 'hop' : fmtSec(glideFrom(v))), (v) => engine.setSlotParam(t.id, 'glide', Math.max(0.004, glideFrom(v))), 'How the resonator slides between notes. “hop” jumps.');
  const scaleFeel = h('p', { class: 'hint' }, MODES[q.s.scale].feel);
  const motionTip = h('p', { class: 'hint' }, MOTIONS.find((m) => m.id === q.s.motion)?.tip ?? '');
  const scaleIds = MODE_ORDER;
  const scalePills = pills(scaleIds.map((id, i) => ({ label: MODES[id].name, value: i })), scaleIds.indexOf(q.s.scale), (i) => {
    engine.updateSeq({ scale: scaleIds[i] });
    scaleFeel.textContent = MODES[scaleIds[i]].feel;
  });
  const motionPills = pills(MOTIONS.map((m, i) => ({ label: m.label, value: i })), MOTIONS.findIndex((m) => m.id === q.s.motion), (i) => {
    engine.updateSeq({ motion: MOTIONS[i].id as Motion });
    motionTip.textContent = MOTIONS[i].tip;
  });
  const chordPills = pills([{ label: 'Resonator chord', value: 0 }, { label: 'Triad', value: 3 }, { label: '7th', value: 4 }, { label: '9th', value: 5 }], q.s.chordSize, (v) => engine.updateSeq({ chordSize: v as 0 | 3 | 4 | 5 }));
  const seedOut = h('span', { class: 'mono seed' }, String(q.s.seed));

  const settings = h('section', { class: 'fx-card' },
    h('div', { class: 'label-row' }, 'Key'),
    keys,
    oct,
    h('div', { class: 'label-row' }, 'Scale'),
    scalePills,
    scaleFeel,
    h('div', { class: 'label-row' }, 'Motion'),
    motionPills,
    motionTip,
    slider('Step', 0, 1, 0.005, posFromRate(engine.seq.rate), (v) => fmtSec(rateFrom(v)), (v) => engine.updateSeq({ rate: rateFrom(v) }), 'Time between notes'),
    glide,
    slider('Chance', 0, 1, 0.01, q.s.chance, (v) => `${Math.round(v * 100)}%`, (v) => engine.updateSeq({ chance: v }), 'Chance each step plays; otherwise it rests'),
    h('div', { class: 'label-row' }, 'Range'),
    pills([{ label: '1 octave', value: 1 }, { label: '2 octaves', value: 2 }, { label: '3 octaves', value: 3 }], q.s.range, (v) => engine.updateSeq({ range: v })),
    h('div', { class: 'label-row' }, 'Chord'),
    chordPills,
    h('div', { class: 'seed-row' }, h('button', { class: 'btn', onclick: () => engine.reseed() }, '🎲  New line'), h('span', { class: 'hint' }, 'seed'), seedOut),
  );

  const stripCard = h('section', { class: 'fx-card' },
    h('header', {}, h('h2', {}, 'Notes'), h('span', { class: 'sub' }, 'tap a note to play it')),
    strip,
  );

  // keep the visible state in step with the engine (the FX tab can change the Key too)
  const stripKey = () => `${q.s.scale}|${q.s.range}|${Math.round(t.p.root)}`;
  let lastKey = '';
  engine.onFxChange(() => {
    onBtn.setAttribute('aria-pressed', String(engine.seq.on));
    seedOut.textContent = String(q.s.seed);
    keys.set(Math.round(t.p.root));
    oct.set(Math.round(t.p.octave));
    glide.set(posFromGlide(t.p.glide));
    if (stripKey() !== lastKey) {
      lastKey = stripKey();
      buildStrip();
    }
    nowSub.textContent = engine.seq.on ? `${NOTE_NAMES[Math.round(t.p.root)]} ${MODES[q.s.scale].name}` : engine.holding ? 'holding' : 'stopped';
  }, life);
  buildStrip();
  lastKey = stripKey();

  // the LED: light whichever note is sounding
  let shown = -2;
  const tick = () => {
    if (life.aborted) return;
    const st = engine.seq.on || engine.holding ? engine.currentStep() : null;
    const idx = st ? st.index : -1;
    if (idx !== shown) {
      shown = idx;
      stripBtns.forEach((b, i) => b.classList.toggle('lit', i === idx));
      nowName.textContent = st ? NOTE_NAMES[(Math.round(t.p.root) + st.semis) % 12] : '–';
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return h('div', { class: 'fx-panel' }, head, stripCard, settings);
}
