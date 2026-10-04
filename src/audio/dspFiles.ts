/** Processor source files, in load order (common.js defines the shared helpers). */
export const DSP_FILES = [
  'common.js',
  'looper.js',
  'safety.js',
  'capture.js',
  'fx-dynamics.js',
  'fx-colour.js',
  'fx-mod.js',
  'fx-time.js',
  'fx-space.js',
  'fx-reso.js',
  'fx-spectral.js',
  'fx-media.js',
] as const;
