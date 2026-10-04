# FieldLooper

Record the world on an iPhone, stretch it into a drone, and play it through an
FX chain you build yourself. Each effect can record a loop of your moves on its
controls, and **Performance Record** captures everything you hear while you play.
A companion to ScapeMaker, ToneMaker, FXMaker and FieldStretcher. It began as a
copy of FieldStretcher, with FXMaker's effects brought over and trimmed for phones.

**Static PWA. No backend, no accounts, no running cost.** Open the site in
Safari, Share → Add to Home Screen, and it runs full-screen and offline.

## Status: v0.1

| Scope | State |
|---|---|
| One loop (mic or file), Spectral / Granular / Tape stretch, overdub, Normalise, loop window | built (carried over from FieldStretcher) |
| FX chain: starts empty; add from 31 FXMaker effects; drag to reorder; per-slot on/off and wet/dry; master wet/dry; load meter | built |
| Slot automation: record, loop, punch in, the hand wins while held | built |
| Sequencer plays a Resonator slot | built |
| Performance Record (up to 10 min, 24-bit WAV, streamed to PCM as it arrives) | built |
| Presets (chain + automation), project files, autosave | built |
| Real-iPhone check | **to do**: see below |

## Develop

```bash
npm install
npm run dev        # Vite --host; open the Network URL on a phone (add ?debug to expose window.__fl)
npm run typecheck  # tsc --noEmit, strict
npm test           # vitest: the worklet processors rendered in Node, automation, slots, presets, files
npm run build      # tsc + vite build → dist/
```

The mic needs HTTPS on a real phone (`localhost` is exempt on desktop). Deploy to
GitHub Pages (push to `main`; `.github/workflows/deploy.yml`) or tunnel the dev server.

## How it works

```
looper ─► level ─┬─► dry ──────────────────────────┐
                 └─► slot ─► slot ─► … ─► wet ─────┴─► master ─► safety limiter ─► out ─► Performance Record tap
slot = in ─┬─► effect ─► slot wet ─┬─► out
           └──────────► slot dry ──┘
```

| Layer | Files | Notes |
|---|---|---|
| DSP | `src/audio/dsp/*.js` | Plain JS AudioWorklet processors, concatenated into ONE module (`worklets.ts`, order in `dspFiles.ts`) and run in Node by `tests/harness.ts`, so the same code is tested and shipped. `fx-*.js` are FXMaker's. `fx-space.js` has its resonator removed, and `fx-reso.js` is FieldStretcher's resonator (glide, pluck, onset, timed notes), which the sequencer drives. Spectral FFTs are capped at 4096. |
| Effects | `src/fx/registry.ts` | FXMaker's 33 effects minus the two convolution reverbs (4.3 MB of impulse responses), with a rough per-effect phone `cost` against a budget of 100. |
| Slots | `src/fx/slot.ts`, `src/audio/units.ts` | `{ id, type, on, mix, p, seed, auto }`. A slot is its effect inside its own dry/wet and bypass. A switched-off effect is disconnected so it costs nothing. Compressor, drive (wave-shaper at 2× instead of 4×) and filter are native Web Audio nodes; everything else is a worklet. At most 8 slots. |
| Chain | `graph.ts`, `units.ts` `Chain` | Adding, removing or moving a slot ducks the chain output for ~25 ms, rewires the slot boundaries, and brings it back up. The looper is never rebuilt. With no slot switched on, the master blend is bypassed, so an empty chain plays the loop dry. |
| Automation | `src/audio/automation.ts`, `FxBase` in `dsp/common.js`, `engine.ts` | **Record:** ● arms a slot; the clock starts at the first touch; ● again closes the loop (0.25–120 s) and it plays from the top. Each control touched gets a lane, thinned with Ramer–Douglas–Peucker. **Punch:** ● on a slot that already loops overwrites only the span your finger covered (wrapping round the loop end). **Playback:** worklet effects play their own lanes on the audio thread, every 4 blocks, in `FxBase.runAuto()`, called from `guard()`, which every effect ends its block with. Native effects and every slot's wet/dry are moved from the main thread at 30 Hz. **Hand wins:** a finger on a control sends `autoHold`; letting go resumes from where the loop is. Switches and choices are not automatable. |
| Sequencer | `src/music/*`, `engine.ts` | Unchanged walk through ToneMaker's modes. It plays the chosen Resonator slot, or the first one, and the Seq tab offers to add one. While it plays, that resonator's Key is not sent (`procParams(…, noteOwned)`), so the two never fight. |
| Performance Record | `dsp/capture.js` (`fs-tap`), `wav.ts` `WavStream`, `engine.ts` | Records the output after the limiter in real time. Each ~85 ms chunk becomes 24-bit PCM at once (about 17 MB a minute), up to 10 minutes, with a pulsing warning from 9. It is offered with Share / Save. |
| Persistence | `src/io/project.ts`, `autosave.ts`, `presets.ts`, `userPresets.ts` | `.fieldlooper` is a store-only ZIP of `project.json` (loop settings, chain with automation, master wet, sequencer) plus `loop.wav`. The loader is tolerant: values are clamped, and an effect this build lacks is dropped and mentioned. IndexedDB autosave. Six built-in presets build whole chains (one with an automation loop to start from); your own go to localStorage. FieldStretcher files are not read (a clean break). |
| Capture, takes, speed check, audio session, theme | as FieldStretcher | Raw PCM capture with self-calibrating speed repair, mic opened only per take (`play-and-record`), then back to `playback` for the speaker. Dark by default; `scapemaker.theme` is shared with the other Maker apps. |
| UI | `src/ui/*` | Vanilla TS, portrait, 44 px targets. Three tabs: **Loop** (record, stretch), **FX** (the chain), **Seq**. Slot cards collapse; reorder by dragging the grip (pointer events, since HTML drag-and-drop does not work on iOS) or with ↑ / ↓. The ring round ● shows where a slot's loop is; a dot marks each automated control. |

## Needs a real-device check

Built and tested in Node (183 tests) and in a desktop browser pane at phone size, where the mic is blocked. On an iPhone, please try:

1. Mic permission, first recording, speaker vs earpiece, the silent switch (as FieldStretcher v3.2).
2. CPU with a full chain: 8 slots, or several reverbs and spectral effects. Tune the `cost` numbers in `registry.ts` to what the phone really manages.
3. Dragging slots with a thumb; holding a slider while its automation plays.
4. A 10-minute Performance Record: memory, and that Share / Save hands over the file.
5. Home Screen install and offline relaunch.

The icons are still FieldStretcher's; regenerate them with `npm run icons` after changing `scripts/make-icons.mjs`.
