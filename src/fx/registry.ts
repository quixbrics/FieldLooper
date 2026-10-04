/*
 * Every effect FieldLooper offers: FXMaker's set, minus what is too heavy for a
 * phone (the convolution reverbs and their impulse-response downloads), with
 * spectral FFTs capped at 4096 and FieldLooper's own resonator. Ranges go
 * further than a studio plug-in would: the master safety limiter makes that safe.
 *
 * `impl` names the implementation: an AudioWorklet processor ("fxm-…") or one
 * of the native Web Audio units in src/audio/units.ts. Several entries share
 * one implementation with different defaults and `fixed` values (chorus and
 * flanger, the four spectral effects, pitch shift and spiral delay…).
 */

export type Curve = 'lin' | 'log' | 'int' | 'bilog';
export type Unit = '' | 'dB' | 'ms' | 's' | 'Hz' | 'st' | 'ct' | '%' | 'x' | 'oct' | 'm' | 'm/s' | '/s' | 'fft' | 'dB/oct';

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  curve?: Curve;
  unit?: Unit;
  /** Enumerated values: index = numeric value. */
  choices?: string[];
  /** Shown in Basic mode. */
  basic?: boolean;
  /** Only shown while another parameter has one of these values (e.g. sequencer controls in sequencer mode). */
  when?: { key: string; in: number[] };
  tip: string;
}

export type Family = 'Dynamics' | 'Drive & colour' | 'Filter & resonance' | 'Pitch & modulation' | 'Time' | 'Space' | 'Spectral' | 'Worn media';

export const FAMILIES: { id: Family; blurb: string }[] = [
  { id: 'Dynamics', blurb: 'Control loudness over time: gates, choppers, compression.' },
  { id: 'Drive & colour', blurb: 'Distort the waveform itself: drive, saturation, folding, crushing.' },
  { id: 'Filter & resonance', blurb: 'Remove, boost or ring at chosen frequencies.' },
  { id: 'Pitch & modulation', blurb: 'Move pitch and frequency, or make it move: shifters, ring mod, chorus, Doppler.' },
  { id: 'Time', blurb: 'Echo, repeat, stutter and stop.' },
  { id: 'Space', blurb: 'Put the sound in a room, a cathedral, or somewhere no room could be.' },
  { id: 'Spectral', blurb: 'Work on the sound’s frequency content directly: freeze it, smear it, shuffle it.' },
  { id: 'Worn media', blurb: 'Records, tape and broken digital: crackle, hiss, wobble, dropouts.' },
];

export interface FxDef {
  type: string;
  name: string;
  family: Family;
  blurb: string;
  impl: string;
  params: ParamDef[];
  /** Default wet/dry: 1 = fully wet (insert), lower = blended with the dry signal. */
  mix: number;
  fixed?: Record<string, number>;
  /** Shown as a warning chip in the browser. */
  wild?: boolean;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SIZE: ParamDef = { key: 'size', label: 'FFT size', min: 9, max: 12, def: 12, curve: 'int', unit: 'fft', tip: 'Bigger = smoother and more blurred in time; smaller = sharper in time but grainier in pitch.' };
const TONE = (def = 9000): ParamDef => ({ key: 'tone', label: 'Tone', min: 200, max: 20000, def, curve: 'log', unit: 'Hz', tip: 'A low-pass filter after the effect. Turn down to tame harshness.' });
const ONOFF = ['Off', 'On'];

export const FX: FxDef[] = [
  /* ------------------------------------------------------------- dynamics */
  {
    type: 'gate', name: 'Gate', family: 'Dynamics', impl: 'fxm-gate', mix: 1,
    blurb: 'Silences everything below a threshold. Inverted, it keeps only the quiet bits.',
    params: [
      { key: 'threshold', label: 'Threshold', min: -80, max: 0, def: -36, unit: 'dB', basic: true, tip: 'Sound louder than this passes; quieter is cut.' },
      { key: 'release', label: 'Release', min: 5, max: 3000, def: 150, curve: 'log', unit: 'ms', basic: true, tip: 'How slowly the gate closes. Short = choppy, long = smooth.' },
      { key: 'invert', label: 'Mode', min: 0, max: 1, def: 0, choices: ['Normal', 'Inverted'], basic: true, tip: 'Inverted keeps only what falls BELOW the threshold — the tails and the room.' },
      { key: 'attack', label: 'Attack', min: 0.1, max: 50, def: 1, curve: 'log', unit: 'ms', tip: 'How fast the gate opens.' },
      { key: 'hold', label: 'Hold', min: 0, max: 1000, def: 40, unit: 'ms', tip: 'Keeps the gate open this long after the sound drops.' },
      { key: 'floor', label: 'Floor', min: -80, max: 0, def: -80, unit: 'dB', tip: 'How quiet "closed" is. −80 is silence; −12 just ducks.' },
    ],
  },
  {
    type: 'chopper', name: 'Chopper', family: 'Dynamics', impl: 'fxm-chop', mix: 1,
    blurb: 'Rhythmic on/off gating — a trance gate. Free-running, no tempo.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 40, def: 6, curve: 'log', unit: 'Hz', basic: true, tip: 'Chops per second. Above ~20 Hz it stops sounding like rhythm and becomes a buzz.' },
      { key: 'duty', label: 'Length', min: 0.05, max: 0.95, def: 0.5, unit: '%', basic: true, tip: 'How much of each chop is open.' },
      { key: 'depth', label: 'Depth', min: 0, max: 1, def: 1, unit: '%', basic: true, tip: 'How far the closed part drops.' },
      { key: 'smooth', label: 'Smooth', min: 0.1, max: 50, def: 3, curve: 'log', unit: 'ms', tip: 'Edge softness. Very short = clicky.' },
      { key: 'skip', label: 'Skip', min: 0, max: 1, def: 0, unit: '%', tip: 'Chance each chop is skipped — breaks the pattern up.' },
      { key: 'offset', label: 'Stereo', min: 0, max: 1, def: 0, unit: '%', tip: 'Offsets the right channel’s pattern: 50 % = left and right alternate.' },
    ],
  },
  {
    type: 'compressor', name: 'Compressor', family: 'Dynamics', impl: 'compressor', mix: 1,
    blurb: 'Squashes loud and quiet together. Pushed hard, the room noise and tails surge up.',
    params: [
      { key: 'threshold', label: 'Threshold', min: -80, max: 0, def: -30, unit: 'dB', basic: true, tip: 'Above this level the compressor turns things down.' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, def: 8, curve: 'log', unit: 'x', basic: true, tip: 'How hard. 20:1 is a limiter.' },
      { key: 'makeup', label: 'Make-up', min: 0, max: 40, def: 12, unit: 'dB', basic: true, tip: 'Turns everything back up afterwards. High values drag up the noise floor.' },
      { key: 'attack', label: 'Attack', min: 0.1, max: 200, def: 5, curve: 'log', unit: 'ms', tip: 'Fast = flattens transients; slow = lets the hit through, then squashes.' },
      { key: 'release', label: 'Release', min: 10, max: 1000, def: 200, curve: 'log', unit: 'ms', tip: 'Short release + heavy ratio = audible pumping.' },
      { key: 'knee', label: 'Knee', min: 0, max: 40, def: 6, unit: 'dB', tip: 'Soft knee eases into compression.' },
    ],
  },
  {
    type: 'specgate', name: 'Spectral gate', family: 'Dynamics', impl: 'fxm-spectral', mix: 1, fixed: { mode: 3 },
    blurb: 'A gate for every frequency at once. Leaves only the strongest partials — or only the noise.',
    params: [
      { key: 'threshold', label: 'Threshold', min: -90, max: 0, def: -50, unit: 'dB', basic: true, tip: 'Frequencies quieter than this are removed.' },
      { key: 'invert', label: 'Mode', min: 0, max: 1, def: 0, choices: ['Keep loud', 'Keep quiet'], basic: true, tip: '"Keep quiet" removes the strong partials and leaves a ghostly residue.' },
      { key: 'tilt', label: 'Tilt', min: 0, max: 9, def: 3, unit: 'dB/oct', tip: 'Lowers the threshold for high frequencies, which are naturally quieter.' },
      SIZE,
    ],
  },

  /* ---------------------------------------------------------- drive & colour */
  {
    type: 'drive', name: 'Drive', family: 'Drive & colour', impl: 'drive', mix: 1, wild: true,
    blurb: 'Distortion from gentle warmth to total destruction. Five shapes.',
    params: [
      { key: 'gain', label: 'Gain', min: 0, max: 60, def: 24, unit: 'dB', basic: true, tip: 'How hard the signal is pushed into the shaper.' },
      { key: 'mode', label: 'Shape', min: 0, max: 4, def: 0, choices: ['Soft', 'Hard', 'Fuzz', 'Rectify', 'Foldback'], basic: true, tip: 'Soft = valve-like; Hard = digital clip; Fuzz = lopsided, gated; Rectify = octave-up grit; Foldback = metallic.' },
      { key: 'tone', label: 'Tone', min: 200, max: 20000, def: 8000, curve: 'log', unit: 'Hz', basic: true, tip: 'Low-pass after the distortion.' },
      { key: 'output', label: 'Output', min: -40, max: 6, def: -12, unit: 'dB', tip: 'Level after the drive.' },
    ],
  },
  {
    type: 'saturate', name: 'Saturation', family: 'Drive & colour', impl: 'fxm-sat', mix: 1,
    blurb: 'Tube or tape colour. Tape mode has a memory (hysteresis), so it smears as it squashes.',
    params: [
      { key: 'mode', label: 'Type', min: 0, max: 1, def: 1, choices: ['Tube', 'Tape'], basic: true, tip: 'Tube: lopsided, warm. Tape: compressed, smeared highs.' },
      { key: 'drive', label: 'Drive', min: 0, max: 48, def: 12, unit: 'dB', basic: true, tip: 'How hard it is driven.' },
      { key: 'hyst', label: 'Hysteresis', min: 0, max: 1, def: 0.4, unit: '%', tip: 'Tape only: how much the output lags behind the input.' },
      { key: 'bias', label: 'Bias', min: -1, max: 1, def: 0, tip: 'Offsets the signal into one side of the curve — more even harmonics, more grit.' },
      TONE(9000),
      { key: 'output', label: 'Output', min: -24, max: 12, def: 0, unit: 'dB', tip: 'Level after saturation.' },
    ],
  },
  {
    type: 'fold', name: 'Wavefolder', family: 'Drive & colour', impl: 'fxm-fold', mix: 1, wild: true,
    blurb: 'Instead of clipping, the wave folds back on itself — bright, metallic, synth-like.',
    params: [
      { key: 'fold', label: 'Fold', min: 1, max: 60, def: 4, curve: 'log', unit: 'x', basic: true, tip: 'How many times the wave folds over.' },
      { key: 'offset', label: 'Offset', min: -1, max: 1, def: 0, basic: true, tip: 'Shifts the folds — changes the harmonic recipe.' },
      { key: 'stages', label: 'Stages', min: 1, max: 4, def: 1, curve: 'int', tip: 'Folds the folded wave again.' },
      TONE(12000),
      { key: 'output', label: 'Output', min: -36, max: 6, def: -6, unit: 'dB', tip: 'Level after the folder.' },
    ],
  },
  {
    type: 'crush', name: 'Bit-crusher', family: 'Drive & colour', impl: 'fxm-crush', mix: 1,
    blurb: 'Fewer bits and a lower sample rate: from old-sampler grit to broken-modem noise.',
    params: [
      { key: 'bits', label: 'Bits', min: 1, max: 16, def: 8, basic: true, tip: 'Bit depth. 16 is CD; 1 is just on/off.' },
      { key: 'rate', label: 'Rate ÷', min: 1, max: 512, def: 4, curve: 'log', unit: 'x', basic: true, tip: 'Divides the sample rate. High values alias into strange whistling tones.' },
      { key: 'jitter', label: 'Jitter', min: 0, max: 1, def: 0, unit: '%', tip: 'Randomises the sample clock — rough, unstable texture.' },
      { key: 'mangle', label: 'Bit-flip', min: 0, max: 1, def: 0, unit: '%', tip: 'Randomly flips bits: digital corruption.' },
    ],
  },

  /* -------------------------------------------------------- filter & resonance */
  {
    type: 'filter', name: 'Filter', family: 'Filter & resonance', impl: 'filter', mix: 1,
    blurb: 'Low-, high-, band-pass or notch, resonant enough to scream, with a sweep LFO.',
    params: [
      { key: 'type', label: 'Type', min: 0, max: 3, def: 0, choices: ['Low-pass', 'High-pass', 'Band-pass', 'Notch'], basic: true, tip: 'Which frequencies are kept.' },
      { key: 'cutoff', label: 'Cutoff', min: 20, max: 20000, def: 1200, curve: 'log', unit: 'Hz', basic: true, tip: 'Where the filter acts.' },
      { key: 'resonance', label: 'Resonance', min: 0, max: 1, def: 0.3, unit: '%', basic: true, tip: 'Boost at the cutoff. Near the top it rings like an instrument.' },
      { key: 'slope', label: 'Slope', min: 0, max: 1, def: 1, choices: ['12 dB', '24 dB'], tip: 'How steeply it cuts.' },
      { key: 'lfoRate', label: 'Sweep rate', min: 0.01, max: 20, def: 0.2, curve: 'log', unit: 'Hz', tip: 'Speed of the automatic sweep.' },
      { key: 'lfoDepth', label: 'Sweep depth', min: 0, max: 5, def: 0, unit: 'oct', tip: 'How far the cutoff sweeps, in octaves.' },
    ],
  },
  {
    type: 'resonator', name: 'Resonator', family: 'Filter & resonance', impl: 'fxm-reso', mix: 0.6,
    blurb: 'A bank of tuned strings the sound is played through. Pick a key and chord — noise becomes harmony. The sequencer can walk it through a scale.',
    params: [
      { key: 'root', label: 'Key', min: 0, max: 11, def: 9, choices: NOTE_NAMES, basic: true, tip: 'Root note. While the sequencer plays this resonator, it is the key of the scale.' },
      { key: 'chord', label: 'Chord', min: 0, max: 6, def: 2, choices: ['Single', 'Octaves', 'Fifths', 'Minor', 'Major', 'Sus 4', 'Minor 9'], basic: true, tip: 'Which notes ring.' },
      { key: 'decay', label: 'Decay', min: 0, max: 1, def: 0.7, unit: '%', basic: true, tip: 'How long the strings ring: from a 20 ms pluck to 30 seconds.' },
      { key: 'input', label: 'Input', min: 0, max: 1, def: 1, unit: '%', basic: true, tip: 'How much of the incoming sound rings the strings. At 0 only plucks sound them.' },
      { key: 'octave', label: 'Octave', min: 1, max: 5, def: 3, curve: 'int', tip: 'Register of the chord.' },
      { key: 'glide', label: 'Glide', min: 0.004, max: 4, def: 0.4, curve: 'log', unit: 's', tip: 'How long a note change takes to arrive.' },
      { key: 'pluck', label: 'Pluck', min: 0, max: 1, def: 0, unit: '%', tip: 'A noise burst into the strings on every note change.' },
      { key: 'onset', label: 'Onset', min: 0, max: 1, def: 0, unit: '%', tip: 'Plucks whenever the incoming sound has a hit in it. Higher = more sensitive.' },
      { key: 'bright', label: 'Brightness', min: 0, max: 1, def: 0.5, unit: '%', tip: 'Dull wooden thud … bright metallic ring.' },
      { key: 'spread', label: 'Spread', min: 0, max: 1, def: 0.3, unit: '%', tip: 'Detunes left from right for width and beating.' },
      { key: 'drive', label: 'Drive', min: 0, max: 1, def: 0.2, unit: '%', tip: 'Saturates the strings.' },
    ],
  },
  {
    type: 'phaser', name: 'Phaser', family: 'Filter & resonance', impl: 'fxm-phaser', mix: 0.5,
    blurb: 'Moving notches from up to 16 stages. Feedback turns the sweep into a whistle.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.01, max: 10, def: 0.25, curve: 'log', unit: 'Hz', basic: true, tip: 'Sweep speed.' },
      { key: 'depth', label: 'Depth', min: 0, max: 1, def: 0.8, unit: '%', basic: true, tip: 'Sweep width (up to four octaves).' },
      { key: 'feedback', label: 'Feedback', min: -0.97, max: 0.97, def: 0.5, unit: '%', basic: true, tip: 'Sharpens the notches into resonant peaks.' },
      { key: 'stages', label: 'Stages', min: 2, max: 16, def: 6, curve: 'int', tip: 'More stages = more notches.' },
      { key: 'centre', label: 'Centre', min: 100, max: 6000, def: 900, curve: 'log', unit: 'Hz', tip: 'Middle of the sweep.' },
      { key: 'spread', label: 'Stereo', min: 0, max: 1, def: 0.25, unit: '%', tip: 'Offsets left and right sweeps.' },
    ],
  },

  /* ------------------------------------------------------- pitch & modulation */
  {
    type: 'ringmod', name: 'Ring modulator', family: 'Pitch & modulation', impl: 'fxm-ring', mix: 1, wild: true,
    blurb: 'Multiplies the sound by a tone. Low = tremolo, mid = robot voice, high = clanging metal.',
    params: [
      { key: 'freq', label: 'Frequency', min: 0.1, max: 8000, def: 220, curve: 'log', unit: 'Hz', basic: true, tip: 'The carrier frequency.' },
      { key: 'shape', label: 'Shape', min: 0, max: 4, def: 0, choices: ['Sine', 'Triangle', 'Square', 'Saw', 'Random'], basic: true, tip: 'Carrier waveform. Square and Saw are much harsher.' },
      { key: 'drift', label: 'Drift', min: 0, max: 1, def: 0, unit: '%', tip: 'Lets the carrier wander up to two octaves.' },
      { key: 'spread', label: 'Stereo', min: 0, max: 1, def: 0, unit: '%', tip: 'Detunes the right carrier.' },
    ],
  },
  {
    type: 'freqshift', name: 'Frequency shifter', family: 'Pitch & modulation', impl: 'fxm-shift', mix: 1, wild: true,
    blurb: 'Moves every frequency by the same number of Hz, breaking harmonic relationships. With feedback: endless spirals.',
    params: [
      { key: 'shift', label: 'Shift', min: -2000, max: 2000, def: 120, curve: 'bilog', unit: 'Hz', basic: true, tip: 'Up (positive) or down. A few Hz = slow phasing; hundreds = inharmonic, bell-like.' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.98, def: 0, unit: '%', basic: true, tip: 'Feeds the output back in: each echo shifts further — a barber-pole spiral.' },
      { key: 'delay', label: 'Spiral time', min: 1, max: 2000, def: 80, curve: 'log', unit: 'ms', tip: 'Gap between each step of the spiral.' },
      { key: 'spread', label: 'Stereo', min: 0, max: 1, def: 0, unit: '%', tip: 'At 100 % the right channel shifts the opposite way.' },
    ],
  },
  {
    type: 'pitch', name: 'Pitch shifter', family: 'Pitch & modulation', impl: 'fxm-pitch', mix: 1, fixed: { feedback: 0, delay: 0 },
    blurb: 'Shifts pitch without changing speed. Big shifts get grainy — on purpose.',
    params: [
      { key: 'semis', label: 'Pitch', min: -24, max: 24, def: -12, curve: 'int', unit: 'st', basic: true, tip: 'Semitones. 12 = one octave.' },
      { key: 'window', label: 'Grain', min: 10, max: 250, def: 80, curve: 'log', unit: 'ms', basic: true, tip: 'Short = robotic flutter; long = smoother but smeared.' },
      { key: 'fine', label: 'Fine', min: -100, max: 100, def: 0, unit: 'ct', tip: 'Cents (hundredths of a semitone).' },
      { key: 'spread', label: 'Stereo', min: 0, max: 1, def: 0, unit: '%', tip: 'Detunes left and right in opposite directions.' },
    ],
  },
  {
    type: 'spiral', name: 'Spiral delay', family: 'Pitch & modulation', impl: 'fxm-pitch', mix: 0.5,
    blurb: 'An echo that changes pitch on every repeat — climbing or falling forever.',
    params: [
      { key: 'semis', label: 'Step', min: -24, max: 24, def: 7, curve: 'int', unit: 'st', basic: true, tip: 'Pitch change per echo.' },
      { key: 'delay', label: 'Time', min: 20, max: 4000, def: 400, curve: 'log', unit: 'ms', basic: true, tip: 'Time between echoes.' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.99, def: 0.7, unit: '%', basic: true, tip: 'How many echoes. Near 100 % it never stops.' },
      TONE(7000),
      { key: 'fine', label: 'Fine', min: -100, max: 100, def: 0, unit: 'ct', tip: 'Fine pitch per echo.' },
      { key: 'window', label: 'Grain', min: 10, max: 250, def: 90, curve: 'log', unit: 'ms', tip: 'Pitch-shifter grain size.' },
      { key: 'spread', label: 'Stereo', min: 0, max: 1, def: 0.3, unit: '%', tip: 'Detunes left from right.' },
    ],
  },
  {
    type: 'chorus', name: 'Chorus', family: 'Pitch & modulation', impl: 'fxm-chorus', mix: 0.5,
    blurb: 'Several slightly detuned, delayed copies. Deep settings go seasick.',
    params: [
      { key: 'depth', label: 'Depth', min: 0, max: 20, def: 4, unit: 'ms', basic: true, tip: 'How far the copies drift.' },
      { key: 'rate', label: 'Rate', min: 0.01, max: 10, def: 0.4, curve: 'log', unit: 'Hz', basic: true, tip: 'Drift speed.' },
      { key: 'voices', label: 'Voices', min: 1, max: 4, def: 3, curve: 'int', basic: true, tip: 'Number of copies.' },
      { key: 'delay', label: 'Delay', min: 1, max: 40, def: 14, unit: 'ms', tip: 'Base delay of the copies.' },
      { key: 'feedback', label: 'Feedback', min: -0.98, max: 0.98, def: 0, unit: '%', tip: 'Feeds copies back in — metallic.' },
      { key: 'spread', label: 'Stereo', min: 0, max: 1, def: 0.5, unit: '%', tip: 'Left/right offset.' },
    ],
  },
  {
    type: 'flanger', name: 'Flanger', family: 'Pitch & modulation', impl: 'fxm-chorus', mix: 0.5, fixed: { voices: 1 },
    blurb: 'A very short sweeping delay with feedback: the jet-plane whoosh.',
    params: [
      { key: 'depth', label: 'Depth', min: 0, max: 10, def: 2, unit: 'ms', basic: true, tip: 'Sweep width.' },
      { key: 'rate', label: 'Rate', min: 0.01, max: 10, def: 0.15, curve: 'log', unit: 'Hz', basic: true, tip: 'Sweep speed.' },
      { key: 'feedback', label: 'Feedback', min: -0.98, max: 0.98, def: 0.8, unit: '%', basic: true, tip: 'Intensity. Negative values sound hollower.' },
      { key: 'delay', label: 'Delay', min: 0.1, max: 10, def: 1.5, curve: 'log', unit: 'ms', tip: 'Base delay.' },
      { key: 'spread', label: 'Stereo', min: 0, max: 1, def: 0.25, unit: '%', tip: 'Left/right offset.' },
    ],
  },
  {
    type: 'doppler', name: 'Doppler fly-by', family: 'Pitch & modulation', impl: 'fxm-doppler', mix: 1,
    blurb: 'The sound flies past the listener again and again — pitch drops as it passes, like a siren.',
    params: [
      { key: 'speed', label: 'Speed', min: 1, max: 330, def: 40, curve: 'log', unit: 'm/s', basic: true, tip: 'How fast it passes. 330 m/s is the speed of sound — extreme pitch sweeps.' },
      { key: 'distance', label: 'Distance', min: 0.5, max: 60, def: 6, curve: 'log', unit: 'm', basic: true, tip: 'Closest approach. Close = loud, sudden pass.' },
      { key: 'period', label: 'Every', min: 1, max: 30, def: 6, curve: 'log', unit: 's', basic: true, tip: 'Time between fly-bys.' },
      { key: 'air', label: 'Air', min: 0, max: 1, def: 0.5, unit: '%', tip: 'High frequencies are lost with distance.' },
      { key: 'alternate', label: 'Direction', min: 0, max: 1, def: 1, choices: ['One way', 'Back & forth'], tip: 'Alternate left→right and right→left.' },
    ],
  },
  {
    type: 'tremolo', name: 'Tremolo / pan', family: 'Pitch & modulation', impl: 'fxm-trem', mix: 1,
    blurb: 'Volume wobble. Offset the channels and it becomes an auto-panner.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 40, def: 4, curve: 'log', unit: 'Hz', basic: true, tip: 'Wobble speed. Above ~20 Hz it turns into a rough buzz.' },
      { key: 'depth', label: 'Depth', min: 0, max: 1, def: 0.7, unit: '%', basic: true, tip: 'How deep.' },
      { key: 'phase', label: 'Stereo', min: 0, max: 1, def: 0, unit: '%', basic: true, tip: '50 % = left and right in opposition: auto-pan.' },
      { key: 'shape', label: 'Shape', min: 0, max: 3, def: 0, choices: ['Sine', 'Triangle', 'Square', 'Random'], tip: 'Wave shape.' },
    ],
  },
  {
    type: 'stereo', name: 'Stereo width', family: 'Pitch & modulation', impl: 'fxm-stereo', mix: 1,
    blurb: 'Narrow to mono, or widen past the speakers. Haas delay smears one side.',
    params: [
      { key: 'width', label: 'Width', min: 0, max: 4, def: 1.5, unit: 'x', basic: true, tip: '0 = mono, 1 = unchanged, above 2 = unnaturally wide (can vanish in mono).' },
      { key: 'haas', label: 'Haas', min: 0, max: 40, def: 0, unit: 'ms', basic: true, tip: 'Delays the right channel — the image pulls left and widens.' },
      { key: 'rotate', label: 'Rotate', min: -1, max: 1, def: 0, tip: 'Rotates the stereo image.' },
    ],
  },

  /* -------------------------------------------------------------------- time */
  {
    type: 'delay', name: 'Tape delay', family: 'Time', impl: 'fxm-delay', mix: 0.4, wild: true,
    blurb: 'Echo with filters, saturation and wobble in the loop. Feedback goes past 100 % — it will self-oscillate.',
    params: [
      { key: 'timeL', label: 'Time L', min: 1, max: 4000, def: 380, curve: 'log', unit: 'ms', basic: true, tip: 'Left echo time. Changing it while playing bends the pitch, like tape.' },
      { key: 'timeR', label: 'Time R', min: 1, max: 4000, def: 520, curve: 'log', unit: 'ms', basic: true, tip: 'Right echo time.' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 1.3, def: 0.55, unit: '%', basic: true, tip: 'Above 100 % the echoes grow until the saturation holds them: runaway feedback.' },
      { key: 'freeze', label: 'Freeze', min: 0, max: 1, def: 0, choices: ONOFF, basic: true, tip: 'Locks what is in the delay into an endless loop and stops new sound entering.' },
      { key: 'pingpong', label: 'Ping-pong', min: 0, max: 1, def: 0, choices: ONOFF, tip: 'Echoes bounce left–right.' },
      { key: 'lowcut', label: 'Low cut', min: 10, max: 5000, def: 120, curve: 'log', unit: 'Hz', tip: 'Each echo loses bass.' },
      { key: 'highcut', label: 'High cut', min: 300, max: 20000, def: 6000, curve: 'log', unit: 'Hz', tip: 'Each echo gets darker.' },
      { key: 'drive', label: 'Drive', min: 0, max: 1, def: 0.2, unit: '%', tip: 'Saturation inside the loop.' },
      { key: 'wobble', label: 'Wobble', min: 0, max: 1, def: 0.15, unit: '%', tip: 'Tape wow in the loop.' },
    ],
  },
  {
    type: 'stutter', name: 'Stutter', family: 'Time', impl: 'fxm-stutter', mix: 1,
    blurb: 'Grabs a slice and repeats it, at random moments. Repeats can drop in pitch, fade and reverse.',
    params: [
      { key: 'slice', label: 'Slice', min: 5, max: 2000, def: 120, curve: 'log', unit: 'ms', basic: true, tip: 'Length of the grabbed slice.' },
      { key: 'repeats', label: 'Repeats', min: 1, max: 64, def: 8, curve: 'int', basic: true, tip: 'How many times it repeats.' },
      { key: 'chance', label: 'Chance', min: 0, max: 1, def: 0.6, unit: '%', basic: true, tip: 'Chance of a stutter at each check.' },
      { key: 'interval', label: 'Check every', min: 50, max: 10000, def: 1500, curve: 'log', unit: 'ms', tip: 'How often it rolls the dice.' },
      { key: 'pitch', label: 'Pitch step', min: -12, max: 12, def: 0, unit: 'st', tip: 'Pitch change on every repeat — negative = tape slowing.' },
      { key: 'decay', label: 'Decay', min: 0, max: 1, def: 0.15, unit: '%', tip: 'Each repeat gets quieter.' },
      { key: 'reverse', label: 'Reverse', min: 0, max: 1, def: 0.2, unit: '%', tip: 'Chance a stutter plays backwards.' },
      { key: 'gate', label: 'Gate', min: 0.05, max: 1, def: 1, unit: '%', tip: 'Plays only the start of each slice.' },
    ],
  },
  {
    type: 'tapestop', name: 'Tape stop', family: 'Time', impl: 'fxm-tapestop', mix: 1,
    blurb: 'The machine grinds to a halt, pauses, then spins back up. Repeats on a cycle.',
    params: [
      { key: 'cycle', label: 'Every', min: 0.5, max: 30, def: 8, curve: 'log', unit: 's', basic: true, tip: 'How often a stop happens.' },
      { key: 'stop', label: 'Slow-down', min: 0.03, max: 8, def: 1.2, curve: 'log', unit: 's', basic: true, tip: 'How long it takes to stop.' },
      { key: 'start', label: 'Spin-up', min: 0.03, max: 6, def: 0.6, curve: 'log', unit: 's', basic: true, tip: 'How long it takes to get back to speed.' },
      { key: 'hold', label: 'Hold', min: 0, max: 8, def: 0.4, unit: 's', tip: 'Silence while stopped.' },
      { key: 'chance', label: 'Chance', min: 0, max: 1, def: 1, unit: '%', tip: 'Chance each cycle actually stops.' },
      { key: 'curve', label: 'Curve', min: 0, max: 1, def: 0.5, unit: '%', tip: 'Linear … sudden-then-slow.' },
    ],
  },

  /* ------------------------------------------------------------------- space */
  {
    type: 'shimmer', name: 'Shimmer reverb', family: 'Space', impl: 'fxm-fdn', mix: 0.45,
    blurb: 'A huge reverb whose tail is pitch-shifted back into itself — rising halos of sound.',
    params: [
      { key: 'decay', label: 'Decay', min: 0.2, max: 60, def: 8, curve: 'log', unit: 's', basic: true, tip: 'How long the tail lasts.' },
      { key: 'shimmer', label: 'Shimmer', min: 0, max: 1, def: 0.5, unit: '%', basic: true, tip: 'How much pitch-shifted tail is fed back.' },
      { key: 'interval', label: 'Interval', min: -24, max: 24, def: 12, curve: 'int', unit: 'st', basic: true, tip: '+12 = octave up (classic); +7 = fifth; −12 = sinks downward.' },
      { key: 'size', label: 'Size', min: 0.15, max: 2.2, def: 1, unit: 'x', tip: 'Room size.' },
      { key: 'damping', label: 'Damping', min: 0, max: 0.98, def: 0.35, unit: '%', tip: 'High frequencies die faster.' },
      { key: 'mod', label: 'Movement', min: 0, max: 1, def: 0.3, unit: '%', tip: 'Slow modulation inside the tail.' },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 500, def: 20, unit: 'ms', tip: 'Gap before the reverb.' },
      { key: 'freeze', label: 'Freeze', min: 0, max: 1, def: 0, choices: ONOFF, tip: 'Holds the tail forever and stops new sound entering.' },
    ],
  },
  {
    type: 'infinite', name: 'Infinite reverb', family: 'Space', impl: 'fxm-fdn', mix: 0.5, fixed: { shimmer: 0 },
    blurb: 'Decay up to two minutes, and a freeze that holds the space forever.',
    params: [
      { key: 'decay', label: 'Decay', min: 0.2, max: 120, def: 30, curve: 'log', unit: 's', basic: true, tip: 'How long the tail lasts.' },
      { key: 'freeze', label: 'Freeze', min: 0, max: 1, def: 0, choices: ONOFF, basic: true, tip: 'Holds the tail forever and stops new sound entering.' },
      { key: 'size', label: 'Size', min: 0.15, max: 2.2, def: 1.6, unit: 'x', basic: true, tip: 'Room size.' },
      { key: 'damping', label: 'Damping', min: 0, max: 0.98, def: 0.5, unit: '%', tip: 'High frequencies die faster.' },
      { key: 'mod', label: 'Movement', min: 0, max: 1, def: 0.5, unit: '%', tip: 'Slow modulation inside the tail.' },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 500, def: 40, unit: 'ms', tip: 'Gap before the reverb.' },
    ],
  },

  /* ---------------------------------------------------------------- spectral */
  {
    type: 'specfreeze', name: 'Spectral freeze', family: 'Spectral', impl: 'fxm-spectral', mix: 1, fixed: { mode: 0 },
    blurb: 'Captures one instant of the sound and holds it as an endless drone.',
    params: [
      { key: 'hold', label: 'Hold', min: 0, max: 1, def: 1, choices: ONOFF, basic: true, tip: 'On = frozen. Off = passes the sound through.' },
      { key: 'every', label: 'Recapture', min: 0, max: 20, def: 0, unit: 's', basic: true, tip: 'Grabs a new moment every so often (0 = never).' },
      { key: 'drift', label: 'Drift', min: 0, max: 1, def: 0.2, unit: '%', basic: true, tip: 'Randomises phase: still and glassy … shimmering wash.' },
      { key: 'glide', label: 'Glide', min: 0, max: 1, def: 0.3, unit: '%', tip: 'Morph time between captures.' },
      SIZE,
    ],
  },
  {
    type: 'blur', name: 'Spectral blur', family: 'Spectral', impl: 'fxm-spectral', mix: 1, fixed: { mode: 1 },
    blurb: 'Smears the frequencies across time — sharp sounds become clouds.',
    params: [
      { key: 'amount', label: 'Blur', min: 0, max: 1, def: 0.85, unit: '%', basic: true, tip: 'How long each frequency lingers.' },
      { key: 'drift', label: 'Drift', min: 0, max: 1, def: 0.3, unit: '%', basic: true, tip: 'Randomises phase for a washier smear.' },
      SIZE,
    ],
  },
  {
    type: 'scramble', name: 'Spectral scramble', family: 'Spectral', impl: 'fxm-spectral', mix: 1, fixed: { mode: 2 },
    blurb: 'Shuffles frequencies within bands. Speech becomes alien; music becomes glitch.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, def: 0.7, unit: '%', basic: true, tip: 'How many frequencies are shuffled.' },
      { key: 'band', label: 'Band', min: 2, max: 512, def: 16, curve: 'log', basic: true, tip: 'How far a frequency can move (in FFT bins). Wide = unrecognisable.' },
      { key: 'rate', label: 'Reshuffle', min: 0.05, max: 60, def: 4, curve: 'log', unit: '/s', basic: true, tip: 'How often the shuffle changes.' },
      SIZE,
    ],
  },

  /* -------------------------------------------------------------- worn media */
  {
    type: 'vinyl', name: 'Vinyl', family: 'Worn media', impl: 'fxm-vinyl', mix: 1,
    blurb: 'Crackle, hiss, rumble, a worn groove and a warped record.',
    params: [
      { key: 'crackle', label: 'Crackle', min: 0, max: 1, def: 0.5, unit: '%', basic: true, tip: 'Density of dust crackle.' },
      { key: 'level', label: 'Noise level', min: -70, max: 6, def: -18, unit: 'dB', basic: true, tip: 'Level of all the surface noise.' },
      { key: 'wear', label: 'Wear', min: 0, max: 1, def: 0.4, unit: '%', basic: true, tip: 'Narrows bandwidth and stereo — a worn groove.' },
      { key: 'warp', label: 'Warp', min: 0, max: 1, def: 0.2, unit: '%', basic: true, tip: 'Slow pitch wobble of a warped record.' },
      { key: 'hiss', label: 'Hiss', min: 0, max: 1, def: 0.3, unit: '%', tip: 'Surface hiss.' },
      { key: 'rumble', label: 'Rumble', min: 0, max: 1, def: 0.3, unit: '%', tip: 'Turntable motor rumble.' },
    ],
  },
  {
    type: 'clicks', name: 'Pops & clicks', family: 'Worn media', impl: 'fxm-clicks', mix: 1, wild: true,
    blurb: 'Record pops, digital clicks, dropouts and CD-style skips.',
    params: [
      { key: 'pops', label: 'Pops', min: 0, max: 30, def: 1, unit: '/s', basic: true, tip: 'Big record pops per second.' },
      { key: 'clicks', label: 'Clicks', min: 0, max: 80, def: 4, unit: '/s', basic: true, tip: 'Sharp digital clicks per second.' },
      { key: 'dropouts', label: 'Dropouts', min: 0, max: 10, def: 0.3, unit: '/s', basic: true, tip: 'Moments where the sound cuts out.' },
      { key: 'skips', label: 'Skips', min: 0, max: 5, def: 0.2, unit: '/s', basic: true, tip: 'CD-style skips that repeat a fragment.' },
      { key: 'popLevel', label: 'Pop level', min: 0, max: 1, def: 0.5, unit: '%', tip: 'How loud the pops are.' },
      { key: 'clickLevel', label: 'Click level', min: 0, max: 1, def: 0.3, unit: '%', tip: 'How loud the clicks are.' },
      { key: 'dropLen', label: 'Dropout length', min: 2, max: 1000, def: 60, curve: 'log', unit: 'ms', tip: 'How long each dropout lasts.' },
      { key: 'skipLen', label: 'Skip length', min: 10, max: 330, def: 90, curve: 'log', unit: 'ms', tip: 'Length of the repeated fragment.' },
    ],
  },
  {
    type: 'wow', name: 'Wow & flutter', family: 'Worn media', impl: 'fxm-wow', mix: 1,
    blurb: 'The pitch wobble of a stretched tape or failing motor. Turned up, it becomes nauseating.',
    params: [
      { key: 'wow', label: 'Wow', min: 0, max: 1, def: 0.3, unit: '%', basic: true, tip: 'Slow, deep pitch wobble.' },
      { key: 'flutter', label: 'Flutter', min: 0, max: 1, def: 0.2, unit: '%', basic: true, tip: 'Fast, fine wobble.' },
      { key: 'drift', label: 'Drift', min: 0, max: 1, def: 0.3, unit: '%', basic: true, tip: 'Random, irregular speed changes.' },
      { key: 'wowRate', label: 'Wow rate', min: 0.05, max: 6, def: 0.6, curve: 'log', unit: 'Hz', tip: 'Speed of the wow.' },
      { key: 'flutterRate', label: 'Flutter rate', min: 2, max: 40, def: 9, curve: 'log', unit: 'Hz', tip: 'Speed of the flutter.' },
      { key: 'stereo', label: 'Stereo', min: 0, max: 1, def: 0.2, unit: '%', tip: 'Left and right wobble independently.' },
    ],
  },
];

const BY_TYPE = new Map(FX.map((d) => [d.type, d]));
export function fxDef(type: string): FxDef | undefined {
  return BY_TYPE.get(type);
}

export function defaultParams(def: FxDef): Record<string, number> {
  const p: Record<string, number> = {};
  for (const q of def.params) p[q.key] = q.def;
  return p;
}

/**
 * Rough CPU weight of each effect on a phone, against a budget of 100 for the
 * whole chain (the looper itself is not counted). A guide for the load meter,
 * not a measurement: tune on a real device.
 */
const COST: Record<string, number> = {
  gate: 2, chopper: 2, compressor: 2, specgate: 14,
  drive: 4, saturate: 3, fold: 3, crush: 2,
  filter: 2, resonator: 10, phaser: 5,
  ringmod: 3, freqshift: 7, pitch: 8, spiral: 10, chorus: 5, flanger: 4, doppler: 5, tremolo: 2, stereo: 2,
  delay: 6, stutter: 5, tapestop: 3,
  shimmer: 18, infinite: 15,
  specfreeze: 14, blur: 14, scramble: 14,
  vinyl: 3, clicks: 2, wow: 4,
};
export const COST_BUDGET = 100;
export function costOf(type: string): number {
  return COST[type] ?? 5;
}

/** Continuous parameters can be automated; switches, choices and whole-number steps cannot. */
export function automatable(q: ParamDef): boolean {
  return !q.choices && q.curve !== 'int';
}

/* ---- slider mapping: 0..1 position ⇄ value ---------------------------------- */

export function toNorm(q: Pick<ParamDef, 'min' | 'max' | 'curve'>, v: number): number {
  const { min, max } = q;
  if (q.curve === 'log' && min > 0) return Math.log(v / min) / Math.log(max / min);
  if (q.curve === 'bilog') {
    const m = Math.max(Math.abs(min), Math.abs(max));
    const s = Math.sign(v) * Math.log1p(Math.abs(v)) / Math.log1p(m);
    return 0.5 + s / 2;
  }
  return (v - min) / (max - min);
}

export function fromNorm(q: Pick<ParamDef, 'min' | 'max' | 'curve'>, t: number): number {
  const { min, max } = q;
  t = Math.min(1, Math.max(0, t));
  let v: number;
  if (q.curve === 'log' && min > 0) v = min * Math.pow(max / min, t);
  else if (q.curve === 'bilog') {
    const m = Math.max(Math.abs(min), Math.abs(max));
    const s = (t - 0.5) * 2;
    v = Math.sign(s) * Math.expm1(Math.abs(s) * Math.log1p(m));
  } else v = min + (max - min) * t;
  if (q.curve === 'int') v = Math.round(v);
  return v;
}

export function fmtValue(q: Pick<ParamDef, 'unit' | 'choices' | 'curve'>, v: number): string {
  if (q.choices) return q.choices[Math.round(v)] ?? String(v);
  const u = q.unit ?? '';
  const r = (x: number, d: number) => x.toFixed(d);
  switch (u) {
    case 'ms': return v >= 1000 ? `${r(v / 1000, 2)} s` : v >= 100 ? `${Math.round(v)} ms` : `${r(v, v < 10 ? 1 : 0)} ms`;
    case 's': return v >= 10 ? `${r(v, 1)} s` : `${r(v, 2)} s`;
    case 'Hz': return Math.abs(v) >= 1000 ? `${r(v / 1000, Math.abs(v) >= 10000 ? 1 : 2)} kHz` : `${r(v, Math.abs(v) < 10 ? 2 : 0)} Hz`;
    case 'dB': return `${v > 0 ? '+' : ''}${r(v, 1)} dB`;
    case 'st': return `${v > 0 ? '+' : ''}${r(v, q.curve === 'int' ? 0 : 1)} st`;
    case 'ct': return `${v > 0 ? '+' : ''}${Math.round(v)} ct`;
    case '%': return `${Math.round(v * 100)} %`;
    case 'x': return `${r(v, v < 10 ? 2 : 0)}×`;
    case 'oct': return `${r(v, 1)} oct`;
    case 'm': return `${r(v, v < 10 ? 1 : 0)} m`;
    case 'm/s': return `${Math.round(v)} m/s`;
    case '/s': return `${r(v, v < 10 ? 1 : 0)}/s`;
    case 'fft': return `${1 << Math.round(v)}`;
    case 'dB/oct': return `${r(v, 1)} dB/oct`;
    default: return q.curve === 'int' ? String(Math.round(v)) : r(v, 2);
  }
}
