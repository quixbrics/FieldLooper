/*
 * .fieldlooper files: a plain (store-only) ZIP holding project.json (the loop's
 * settings, the FX chain with its automation, the sequencer) and the loop as a
 * 24-bit WAV. Rename it to .zip and the sound is right there; open it in the app
 * and everything comes back.
 *
 *   project.json, loop.wav
 */
import { makeZip, readZip } from './zip';
import { encodeWav, parseWav } from '../audio/wav';
import type { Loop, ProjectData } from '../audio/engine';

const LOOP_FILE = 'loop.wav';

export async function packProject(p: ProjectData, loop: Loop | null): Promise<Blob> {
  const files: { name: string; data: Blob | string }[] = [{ name: 'project.json', data: JSON.stringify(p, null, 2) }];
  if (loop) files.push({ name: LOOP_FILE, data: encodeWav(loop, p.sampleRate, 24) });
  return makeZip(files);
}

export function unpackProject(buf: ArrayBuffer): { project: Partial<ProjectData>; loop: Loop | null; sampleRate: number } {
  const files = readZip(buf);
  const pj = files.get('project.json');
  if (!pj) throw new Error('This is not a FieldLooper project (no project.json inside).');
  let project: Partial<ProjectData>;
  try {
    project = JSON.parse(new TextDecoder().decode(pj));
  } catch {
    throw new Error('The project file is damaged (project.json is unreadable).');
  }
  if (project.app !== 'FieldLooper') throw new Error('This is not a FieldLooper project.');
  let sampleRate = typeof project.sampleRate === 'number' ? project.sampleRate : 48000;
  let loop: Loop | null = null;
  const w = files.get(LOOP_FILE);
  if (w) {
    const wav = parseWav(w);
    loop = wav.channels.slice(0, 2);
    sampleRate = wav.sampleRate;
  }
  return { project, loop, sampleRate };
}

/** Hand a file to the phone's share sheet (Save to Files, AirDrop …), or download it where that is not available. */
export async function shareOrDownload(blob: Blob, name: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
      // anything else: fall through to a plain download
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}

export const stamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
