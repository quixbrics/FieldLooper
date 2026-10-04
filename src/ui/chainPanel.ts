/*
 * The FX tab: the master Wet/Dry and load meter, the chain of slots (each a
 * card: drag by the grip to reorder, ● to record automation, a switch, its own
 * wet/dry and controls) and the Add-effect sheet.
 *
 * Automation, from the card's point of view:
 *   ● on a slot with nothing recorded arms it. Move any of its controls: the
 *     clock starts at the first touch. Tap ● again to close the loop.
 *   ● on a slot that already loops punches in: whatever you move replaces that
 *     part of the loop. The ring round ● shows where the loop is.
 *   While a finger is on a control, the hand wins; let go and the loop takes over.
 */
import type { Engine } from '../audio/engine';
import { FAMILIES, FX, automatable, costOf, fmtValue, fromNorm, fxDef, toNorm, COST_BUDGET, type ParamDef } from '../fx/registry';
import { MAX_SLOTS, type Slot } from '../fx/slot';
import { pills, slider, type Controllable } from './controls';
import { fmtTime, h } from './dom';

/** which slot cards are open (survives a rebuild of the list) */
const expanded = new Set<string>();

export interface ChainPanel {
  el: HTMLElement;
  /** the Add-effect sheet (lives at the top level of the page) */
  sheet: HTMLElement;
  /** slots were added, removed, moved or switched */
  render(): void;
  /** automation frame from the engine (~30 Hz) */
  onAuto(frame: Map<string, { phase: number; values: Record<string, number> }>): void;
  /** a slot was armed or disarmed */
  onArmed(): void;
}

interface Hooks {
  say(msg: string): void;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const fmtWet = (v: number) => (v <= 0.005 ? 'dry' : v >= 0.995 ? 'WET' : pct(v));

type ParamCtl = Controllable & { key: string; auto: boolean };

class SlotCard {
  readonly root: HTMLElement;
  private ctls = new Map<string, ParamCtl>();
  private held = new Set<string>();
  private armBtn: HTMLButtonElement;
  private armText = h('span', { class: 'arm-t mono' });
  private armHint = h('p', { class: 'hint arm-hint', hidden: true });
  private sw: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  readonly grip: HTMLButtonElement;

  constructor(private engine: Engine, private slot: Slot, index: number, count: number, hooks: Hooks) {
    const def = fxDef(slot.type)!;
    const id = slot.id;
    const open = expanded.has(id);

    /* ---- header ---- */
    this.grip = h('button', { class: 'grip', 'aria-label': `Drag to move ${def.name}`, title: 'Drag to move it in the chain' }, '⠿');
    const title = h('button', { class: 'slot-title', 'aria-expanded': open, onclick: () => {
      const now = !this.root.classList.contains('open');
      this.root.classList.toggle('open', now);
      title.setAttribute('aria-expanded', String(now));
      if (now) expanded.add(id);
      else expanded.delete(id);
    } }, h('span', { class: 'slot-num mono' }, String(index + 1)), h('b', {}, def.name), def.wild ? h('i', { class: 'wild' }, 'wild') : null);
    this.armBtn = h('button', { class: 'arm', 'aria-label': `Record automation on ${def.name}`, onclick: () => {
      if (!engine.started) return hooks.say('Tap to start first.');
      if (engine.armedId === id) engine.disarm(true);
      else engine.arm(id);
    } }, h('i', {}), this.armText);
    this.sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': slot.on, 'aria-label': `${def.name} on or off`, onclick: () => engine.setSlotOn(id, !slot.on) }, h('i', {}));
    const header = h('header', {}, this.grip, title, this.armBtn, this.sw);

    /* ---- body ---- */
    const mix = this.param({ key: 'mix', label: 'Wet', min: 0, max: 1, def: def.mix, unit: '%', tip: 'This effect’s own wet/dry. 0 = it passes the sound through untouched.' }, slot.mix);
    mix.classList.add('wetdry');
    const basic = def.params.filter((q) => q.basic);
    const adv = def.params.filter((q) => !q.basic);
    const advBox = adv.length ? h('details', { class: 'more' }, h('summary', {}, `More controls (${adv.length})`), ...adv.map((q) => this.param(q, slot.p[q.key]))) : null;

    const move = (d: number) => engine.moveSlot(id, index + d);
    this.clearBtn = h('button', { class: 'btn', hidden: !slot.auto, onclick: () => {
      engine.clearAuto(id);
      this.syncAuto();
      hooks.say('Automation cleared.');
    } }, 'Clear automation');
    let delArmed = 0;
    const del = h('button', { class: 'btn danger', onclick: () => {
      if (!slot.auto || delArmed) {
        window.clearTimeout(delArmed);
        engine.removeSlot(id);
        return;
      }
      // a slot with recorded automation asks once
      del.textContent = 'Remove? Tap again';
      delArmed = window.setTimeout(() => { delArmed = 0; del.textContent = 'Remove'; }, 3000);
    } }, 'Remove');
    const actions = h('div', { class: 'slot-actions' },
      h('button', { class: 'btn sq', 'aria-label': 'Move up the chain', disabled: index === 0, onclick: () => move(-1) }, '↑'),
      h('button', { class: 'btn sq', 'aria-label': 'Move down the chain', disabled: index === count - 1, onclick: () => move(1) }, '↓'),
      this.clearBtn,
      del,
    );

    const body = h('div', { class: 'slot-body' }, h('p', { class: 'hint' }, def.blurb), this.armHint, mix, ...basic.map((q) => this.param(q, slot.p[q.key])), advBox, actions);
    this.root = h('section', { class: `slot${open ? ' open' : ''}${slot.on ? '' : ' off'}`, 'data-id': id, 'aria-label': def.name }, header, body);
    this.syncAuto();
    this.syncArm();
  }

  /** One control. Continuous ones can be automated: a finger on them is reported to the engine. */
  private param(q: ParamDef, value: number): ParamCtl {
    const e = this.engine;
    const id = this.slot.id;
    const isMix = q.key === 'mix';
    const set = (v: number) => (isMix ? e.setSlotMix(id, v) : e.setSlotParam(id, q.key, v));
    let ctl: Controllable;
    let canAuto = false;
    if (q.choices) {
      ctl = pills(q.choices.map((c, i) => ({ label: c, value: i })), Math.round(value), (v) => set(v), q.choices.length === 12 ? 'chips keys' : 'chips wrap');
      ctl = Object.assign(h('div', { class: 'pill-row', title: q.tip }, h('div', { class: 'label-row' }, q.label), ctl), { set: ctl.set });
    } else if (q.curve === 'int') {
      ctl = slider(q.label, q.min, q.max, 1, value, (v) => fmtValue(q, v), (v) => set(v), q.tip);
    } else {
      canAuto = isMix || automatable(q);
      const s = slider(q.label, 0, 1, 0.001, toNorm(q, value), (t) => fmtValue(q, fromNorm(q, t)), (t) => set(fromNorm(q, t)), q.tip);
      const toPos = s.set;
      ctl = Object.assign(s, { set: (v: number) => toPos(toNorm(q, v)) });
      // the hand wins while held: tell the engine when a finger lands on and leaves the slider
      const input = s.input;
      input.addEventListener('pointerdown', () => {
        if (this.held.has(q.key)) return;
        this.held.add(q.key);
        e.grab(id, q.key);
        const up = () => {
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          this.held.delete(q.key);
          e.release(id, q.key);
          this.syncAuto();
        };
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
    }
    const pc = Object.assign(ctl, { key: q.key, auto: canAuto });
    if (canAuto) pc.classList.add('can-auto');
    this.ctls.set(q.key, pc);
    return pc;
  }

  /** Which controls have a lane (a dot by the label), and the Clear button. */
  syncAuto() {
    const lanes = new Set(this.slot.auto?.lanes.map((l) => l.key) ?? []);
    for (const [k, c] of this.ctls) c.classList.toggle('automated', lanes.has(k));
    this.clearBtn.hidden = !this.slot.auto;
    this.root.classList.toggle('has-auto', !!this.slot.auto);
  }

  /** The ● button and the hint under it. */
  syncArm() {
    const e = this.engine;
    const armed = e.armedId === this.slot.id;
    this.root.classList.toggle('armed', armed);
    this.armBtn.setAttribute('aria-pressed', String(armed));
    this.armHint.hidden = !armed;
    if (!armed) {
      this.armText.textContent = '';
      return;
    }
    if (e.punching) {
      this.armText.textContent = 'IN';
      this.armHint.textContent = 'Punch-in: whatever you move now replaces that stretch of the loop. Tap ● when done.';
    } else {
      const el = e.armedElapsed();
      this.armText.textContent = el ? fmtTime(el).replace(/^00:/, '0:') : '';
      this.armHint.textContent = el ? 'Recording. Tap ● to close the loop here.' : 'Armed: move any control to start recording.';
    }
    if (!this.root.classList.contains('open')) {
      this.root.classList.add('open');
      expanded.add(this.slot.id);
    }
  }

  /** Follow the automation: the ring round ● and the sliders it moves. */
  follow(f: { phase: number; values: Record<string, number> } | undefined) {
    this.armBtn.style.setProperty('--ph', f ? String(f.phase) : '0');
    this.armBtn.classList.toggle('looping', !!f);
    if (!f || !this.root.classList.contains('open')) return;
    for (const [k, v] of Object.entries(f.values)) {
      if (this.held.has(k)) continue;
      this.ctls.get(k)?.set(v);
    }
  }

  /** Values changed elsewhere (the Seq tab moves a resonator's Key). Automated controls follow their lanes instead. */
  syncValues() {
    const lanes = new Set(this.slot.auto?.lanes.map((l) => l.key) ?? []);
    this.sw.setAttribute('aria-checked', String(this.slot.on));
    for (const [k, c] of this.ctls) {
      if (lanes.has(k) || this.held.has(k)) continue;
      c.set(k === 'mix' ? this.slot.mix : this.slot.p[k]);
    }
  }
}

export function buildChainPanel(engine: Engine, hooks: Hooks): ChainPanel {
  /* ---- master ---- */
  const wet = slider('Wet', 0, 1, 0.01, engine.wet, fmtWet, (v) => engine.setWet(v), 'Dry = the loop alone. Wet = only what comes out of the chain.');
  wet.classList.add('wetdry');
  const loadBar = h('i', {});
  const loadText = h('span', { class: 'mono' });
  const masterHint = h('p', { class: 'hint' });
  const master = h('section', { class: 'fx-card master-card' },
    h('header', {}, h('h2', {}, 'Chain'), h('span', { class: 'sub' }, 'master wet / dry')),
    wet,
    h('div', { class: 'load', title: 'A rough guide to how hard the effects work the phone.' }, h('span', { class: 'label-row' }, 'Load'), h('div', { class: 'load-meter' }, loadBar), loadText),
    masterHint,
  );

  const list = h('div', { class: 'slots' });
  const addBtn = h('button', { class: 'add-fx', onclick: () => openSheet() }, '＋  Add effect');
  const el = h('div', { class: 'fx-panel' }, master, list, addBtn);
  let cards: SlotCard[] = [];

  /* ---- the add sheet ---- */
  const sheetBody = h('div', { class: 'sheet-body' });
  const sheet = h('div', { class: 'sheet', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add effect' }, sheetBody);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.hidden = true;
  });
  const openSheet = () => {
    const full = engine.chain.length >= MAX_SLOTS;
    sheetBody.replaceChildren(
      h('h2', {}, 'Add effect'),
      h('p', { class: 'hint' }, full ? `The chain is full (${MAX_SLOTS} effects). Remove one to add another.` : 'It goes at the end of the chain; drag it by its grip to move it.'),
      ...FAMILIES.flatMap((fam) => {
        const defs = FX.filter((d) => d.family === fam.id);
        if (!defs.length) return [];
        return [
          h('h3', {}, fam.id),
          h('div', { class: 'fx-pick' }, ...defs.map((d) => {
            const ok = engine.canAdd(d.type);
            return h('button', { class: 'fx-opt', disabled: !ok, onclick: () => {
              const s = engine.addSlot(d.type);
              sheet.hidden = true;
              if (!s) return hooks.say('That would overload the phone. Remove or switch off an effect first.');
              expanded.add(s.id);
              requestAnimationFrame(() => list.querySelector(`[data-id="${s.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
            } }, h('b', {}, d.name, d.wild ? h('i', { class: 'wild' }, 'wild') : null), h('span', {}, d.blurb), h('span', { class: 'cost mono' }, `load ${Math.round((costOf(d.type) / COST_BUDGET) * 100)}%`));
          })),
        ];
      }),
      h('button', { class: 'btn primary', onclick: () => (sheet.hidden = true) }, 'Close'),
    );
    sheet.hidden = false;
  };

  /* ---- drag to reorder (pointer events: HTML drag-and-drop does not work on a phone) ---- */
  const startDrag = (card: SlotCard, id: string, e: PointerEvent) => {
    e.preventDefault();
    const node = card.root;
    const grip = card.grip;
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const top0 = node.offsetTop;
    node.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const want = top0 + (ev.clientY - startY);
      const mid = want + node.offsetHeight / 2;
      // pass a neighbour's middle and swap with it (as many as a fast flick went past)
      for (;;) {
        const prev = node.previousElementSibling as HTMLElement | null;
        const next = node.nextElementSibling as HTMLElement | null;
        if (prev && mid < prev.offsetTop + prev.offsetHeight / 2) list.insertBefore(node, prev);
        else if (next && mid > next.offsetTop + next.offsetHeight / 2) list.insertBefore(next, node);
        else break;
      }
      node.style.transform = `translateY(${want - node.offsetTop}px)`;
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      node.classList.remove('dragging');
      node.style.transform = '';
      const to = [...list.children].indexOf(node);
      const from = engine.chain.findIndex((s) => s.id === id);
      if (to >= 0 && to !== from) engine.moveSlot(id, to);
      else render();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };

  /* ---- render ---- */
  const syncMaster = () => {
    const load = engine.load;
    loadBar.style.transform = `scaleX(${Math.min(1, load)})`;
    loadBar.classList.toggle('hot', load > 0.7);
    loadText.textContent = `${Math.round(load * 100)}%`;
    const n = engine.chain.length;
    const anyOn = engine.chain.some((s) => s.on);
    masterHint.textContent = !n
      ? 'The chain is empty: you hear the loop as it is. Add an effect to start building.'
      : !anyOn
        ? 'Every effect is switched off, so you hear the loop dry.'
        : `${n} effect${n > 1 ? 's' : ''}, top to bottom in signal order.`;
    addBtn.disabled = n >= MAX_SLOTS;
    addBtn.textContent = n >= MAX_SLOTS ? `Chain full (${MAX_SLOTS})` : '＋  Add effect';
  };
  const render = () => {
    cards = engine.chain.map((s, i) => new SlotCard(engine, s, i, engine.chain.length, hooks));
    cards.forEach((c, i) => {
      const id = engine.chain[i].id;
      c.grip.addEventListener('pointerdown', (e) => startDrag(c, id, e));
    });
    list.replaceChildren(...cards.map((c) => c.root));
    syncMaster();
  };
  render();

  engine.onFxChange(() => {
    wet.set(engine.wet);
    cards.forEach((c) => {
      c.syncValues();
      c.syncAuto();
    });
  });

  return {
    el,
    sheet,
    render,
    onAuto(frame) {
      cards.forEach((c, i) => c.follow(frame.get(engine.chain[i]?.id)));
      if (engine.armedId && !engine.punching) cards.forEach((c) => c.syncArm());
    },
    onArmed() {
      cards.forEach((c) => {
        c.syncArm();
        c.syncAuto();
      });
    },
  };
}
