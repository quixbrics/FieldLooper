import { PRESETS } from '../src/io/presets';
import { chainLoad, defaultSound, focusToContrast, type Preset } from '../src/audio/engine';
import { deleteUserPreset, loadUserPresets, saveUserPreset } from '../src/io/userPresets';
import { MAX_SLOTS, newSlot, readSlot, cloneSlots } from '../src/fx/slot';
import { fxDef } from '../src/fx/registry';

// a minimal localStorage for Node
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

describe('slots', () => {
  it('a new slot has the effect’s defaults and its usual wet/dry', () => {
    const s = newSlot('delay');
    expect(s.mix).toBe(fxDef('delay')!.mix);
    expect(s.p.feedback).toBe(0.55);
    expect(s.on).toBe(true);
    expect(s.auto).toBeNull();
    expect(newSlot('delay').id).not.toBe(s.id);
  });
  it('reading a saved slot clamps every value and fills in what is missing', () => {
    const s = readSlot({ type: 'delay', mix: 7, p: { feedback: 99, timeL: 'x', pingpong: 0.7 } })!;
    expect(s.mix).toBe(1);
    expect(s.p.feedback).toBe(1.3);
    expect(s.p.timeL).toBe(380);
    expect(s.p.pingpong).toBe(1); // a switch comes back whole
  });
  it('an effect this version does not have is refused', () => {
    expect(readSlot({ type: 'reverb' })).toBeNull();
    expect(readSlot(null)).toBeNull();
  });
  it('automation is kept when sound, cleaned when not, and only for controls that can be automated', () => {
    const s = readSlot({
      type: 'filter',
      auto: {
        len: 4,
        lanes: [
          { key: 'cutoff', t: [0, 1, 0.5, 2], v: [100, 99999, 300, 400] },
          { key: 'type', t: [0], v: [2] },
          { key: 'mix', t: [0, 2], v: [0, 1] },
          { key: 'nope', t: [0], v: [1] },
        ],
      },
    })!;
    expect(s.auto!.lanes.map((l) => l.key)).toEqual(['cutoff', 'mix']);
    const cut = s.auto!.lanes[0];
    expect(cut.t).toEqual([0, 1, 2]); // the out-of-order point is dropped
    expect(cut.v[1]).toBe(20000); // clamped to the control's range
    expect(readSlot({ type: 'filter', auto: { len: -1, lanes: [] } })!.auto).toBeNull();
  });
  it('cloning can give fresh ids', () => {
    const a = [newSlot('chorus')];
    expect(cloneSlots(a)[0].id).toBe(a[0].id);
    expect(cloneSlots(a, true)[0].id).not.toBe(a[0].id);
  });
  it('the load counts only effects that are on', () => {
    const a = newSlot('shimmer');
    const b = { ...newSlot('shimmer'), on: false };
    expect(chainLoad([a, b])).toBeCloseTo(chainLoad([a]), 9);
    expect(chainLoad([])).toBe(0);
  });
});

describe('stock presets', () => {
  it('have names, blurbs and valid chains whose settings are in range', () => {
    const names = new Set<string>();
    for (const p of PRESETS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.blurb.length).toBeGreaterThan(0);
      expect(names.has(p.name)).toBe(false);
      names.add(p.name);
      expect(p.chain.length).toBeLessThanOrEqual(MAX_SLOTS);
      expect(chainLoad(p.chain.map((s) => ({ type: s.type, on: s.on ?? true })))).toBeLessThanOrEqual(1);
      for (const ps of p.chain) {
        const def = fxDef(ps.type);
        expect(def, `${p.name}: ${ps.type}`).toBeDefined();
        for (const [k, v] of Object.entries(ps.p ?? {})) {
          const q = def!.params.find((x) => x.key === k);
          expect(q, `${p.name}: ${ps.type}.${k}`).toBeDefined();
          expect(v).toBeGreaterThanOrEqual(q!.min);
          expect(v).toBeLessThanOrEqual(q!.max);
        }
        // the automation in a preset survives being read back
        if (ps.auto) expect(readSlot({ ...ps, auto: ps.auto })!.auto).toEqual(ps.auto);
      }
    }
  });
  it('a preset that turns the sequencer on has a resonator for it to play', () => {
    for (const p of PRESETS.filter((x) => x.seqOn)) expect(p.chain.some((s) => s.type === 'resonator')).toBe(true);
  });
  it('the first preset is a plain loop with an empty chain', () => {
    expect(PRESETS[0].chain).toEqual([]);
    expect(PRESETS[0].track?.stretch).toBe(1);
  });
  it('every non-tape loop in a preset is unlinked, so its pitch and stretch are independent', () => {
    for (const p of PRESETS) if (p.track?.engine && p.track.engine !== 'tape') expect(p.track.link).toBe(false);
  });
  it('focus maps 0 → diffuse, 0.5 → unchanged, 1 → tonal', () => {
    expect(focusToContrast(0)).toBe(0.5);
    expect(focusToContrast(0.5)).toBe(1);
    expect(focusToContrast(1)).toBe(2.5);
    expect(defaultSound().spectral.focus).toBe(0.5);
  });
});

describe('your own presets', () => {
  beforeEach(() => store.clear());
  const mk = (name: string): Preset => ({ name, blurb: 'b', chain: [{ type: 'chorus' }] });
  it('save, list, replace by name, delete', () => {
    expect(saveUserPreset(mk('One'))).toBe(true);
    expect(saveUserPreset(mk('Two'))).toBe(true);
    expect(saveUserPreset({ ...mk('One'), blurb: 'new' })).toBe(true);
    const list = loadUserPresets();
    expect(list.map((x) => x.name)).toEqual(['Two', 'One']);
    expect(list.find((x) => x.name === 'One')!.blurb).toBe('new');
    expect(list.every((x) => x.user)).toBe(true);
    deleteUserPreset('Two');
    expect(loadUserPresets().map((x) => x.name)).toEqual(['One']);
  });
  it('refuses an empty name and survives damaged storage', () => {
    expect(saveUserPreset(mk('   '))).toBe(false);
    store.set('fieldlooper.presets', '{not json');
    expect(loadUserPresets()).toEqual([]);
    store.set('fieldlooper.presets', JSON.stringify([{ nope: true }, mk('Ok')]));
    expect(loadUserPresets().map((x) => x.name)).toEqual(['Ok']);
  });
});
