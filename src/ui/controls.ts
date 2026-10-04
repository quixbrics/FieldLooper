/*
 * The building blocks every panel uses: a labelled slider, a row of pills and a
 * toggle, each sized for a thumb.
 */
import { h } from './dom';

type Fmt = (v: number) => string;

export type Controllable = HTMLElement & { set(v: number): void };

export function slider(label: string, min: number, max: number, step: number, value: number, fmt: Fmt, onInput: (v: number) => void, tip?: string): Controllable & { input: HTMLInputElement } {
  const out = h('output', { class: 'mono val' }, fmt(value));
  const input = h('input', { class: 'range', type: 'range', min, max, step, value, 'aria-label': label });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  const row = h('div', { class: 'row', title: tip }, h('label', {}, label), input, out);
  // move the control from code (presets, automation, a duplicate control elsewhere) without firing onInput
  return Object.assign(row, {
    input,
    set(v: number) {
      input.value = String(v);
      out.textContent = fmt(v);
    },
  });
}

export function pills<T extends number>(items: { label: string; value: T }[], current: T, onPick: (v: T) => void, cls = 'chips wrap'): Controllable {
  const btns = items.map((it) =>
    h('button', { class: 'chip', 'aria-pressed': it.value === current, onclick: () => {
      onPick(it.value);
      show(it.value);
    } }, it.label),
  );
  const show = (v: number) => btns.forEach((b, k) => b.setAttribute('aria-pressed', String(items[k].value === v)));
  return Object.assign(h('div', { class: cls, role: 'group' }, ...btns), { set: show });
}

export function toggle(label: string, on: boolean, onChange: (v: boolean) => void) {
  const b = h('button', { class: 'tog', 'aria-pressed': on }, label);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(v));
    onChange(v);
  });
  return b;
}
