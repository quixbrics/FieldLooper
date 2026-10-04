/*
 * Starting points. A preset sets the loop's stretch mode and sound controls and
 * builds a whole FX chain (replacing the one there); it never touches the
 * recording, so any preset can be tried on whatever is in the loop. Slot
 * settings only list what differs from the effect's defaults.
 */
import type { Preset, PresetTrack } from '../audio/engine';

const plain: PresetTrack = { engine: 'tape', stretch: 1, glide: 0, pitch: 0, link: true, reverse: false, freeze: false, level: 0.8, overdub: false };
const none = { tape: { wow: 0, flutter: 0, drive: 0, age: 0, hiss: 0 } };

export const PRESETS: Preset[] = [
  {
    name: 'Just the Loop',
    blurb: 'Plain looping at normal speed and an empty chain.',
    track: { ...plain, sound: none },
    chain: [],
    wet: 1,
    seqOn: false,
  },
  {
    name: 'Worn Cassette',
    blurb: 'Tape at normal speed, but wobbling, dull and hissy, like a tape left in a car.',
    track: { ...plain, glide: 0.6, sound: { tape: { wow: 0.6, flutter: 0.35, drive: 0.4, age: 0.65, hiss: 0.3 } } },
    chain: [
      { type: 'wow', mix: 1 },
      { type: 'infinite', mix: 0.2, p: { decay: 2, size: 0.6, damping: 0.8 } },
    ],
    wet: 1,
    seqOn: false,
  },
  {
    name: 'Glass Hour',
    blurb: 'Slow shimmering drones over a drifting Lydian resonator.',
    track: { engine: 'spectral', link: false, stretch: 64, glide: 4, pitch: 0, level: 0.7, sound: { spectral: { window: 14, spread: 0.9, tilt: 0.4, focus: 0.7 } } },
    chain: [
      { type: 'resonator', mix: 0.6, p: { chord: 2, decay: 0.8, bright: 0.6, glide: 1.5 } },
      { type: 'delay', mix: 0.35, p: { timeL: 620, timeR: 620, feedback: 0.55, pingpong: 1, highcut: 6800 } },
      { type: 'shimmer', mix: 0.5, p: { decay: 14, size: 1.4, damping: 0.35, shimmer: 0.35 } },
    ],
    wet: 1,
    seq: { scale: 'lydian', motion: 'drift', range: 2, chance: 0.7, chordSize: 3, rate: 6 },
    seqOn: true,
  },
  {
    name: 'Underwater Street',
    blurb: 'Dark, heavy and far away: pitched-down washes and a slow minor resonance.',
    track: { engine: 'spectral', link: false, stretch: 200, glide: 6, pitch: -12, level: 0.7, sound: { spectral: { window: 15, spread: 0.7, tilt: -0.7, focus: 0.55 } } },
    chain: [
      { type: 'resonator', mix: 0.5, p: { chord: 3, decay: 0.75, bright: 0.3, glide: 2.5 } },
      { type: 'filter', mix: 1, p: { cutoff: 900, resonance: 0.2 } },
      { type: 'infinite', mix: 0.6, p: { decay: 22, size: 1.9, damping: 0.7 } },
    ],
    wet: 1,
    seq: { scale: 'aeolian', motion: 'wander', range: 1, chance: 0.8, chordSize: 0, rate: 9 },
    seqOn: true,
  },
  {
    name: 'Rain Harp',
    blurb: 'The loop plays normally and plucks a ticking harp from every hit.',
    track: { ...plain, level: 0.6, sound: none },
    chain: [
      { type: 'resonator', mix: 0.6, p: { chord: 1, decay: 0.3, pluck: 0.8, onset: 0.6, input: 0.25, bright: 0.75, glide: 0.02 } },
      { type: 'delay', mix: 0.35, p: { timeL: 330, timeR: 330, feedback: 0.45, pingpong: 1, highcut: 4500 } },
      { type: 'infinite', mix: 0.3, p: { decay: 6, size: 1.1, damping: 0.5 } },
    ],
    wet: 1,
    seq: { scale: 'dorian', motion: 'arp', range: 2, chance: 0.8, chordSize: 0, rate: 0.4 },
    seqOn: true,
  },
  {
    name: 'Breathing Filter',
    blurb: 'A low-pass filter that opens and closes on its own, an 8-second loop of automation to start from.',
    track: { engine: 'granular', link: false, stretch: 8, glide: 2, pitch: 0, level: 0.75, sound: { granular: { grain: 220, density: 20, jitter: 0.4, spray: 0.3, spread: 0.7, shape: 1, grev: 0.1 } } },
    chain: [
      {
        type: 'filter',
        mix: 1,
        p: { cutoff: 600, resonance: 0.45 },
        auto: { len: 8, lanes: [{ key: 'cutoff', t: [0, 3.5, 4.5, 7.95], v: [300, 4200, 4200, 300] }] },
      },
      { type: 'delay', mix: 0.3, p: { timeL: 450, timeR: 600, feedback: 0.5 } },
      { type: 'infinite', mix: 0.4, p: { decay: 10 } },
    ],
    wet: 1,
    seqOn: false,
  },
];
