type Attrs = Record<string, string | ((ev: Event) => void)>;

/** Tiny DOM builder: el('button', { class: 'btn', onclick }, 'Label'). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {},
  ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') node.addEventListener(k.replace(/^on/, ''), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.getElementById('toasts')!;
  const t = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3000);
}

const NAMES: Record<string, string> = {
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt', AltRight: 'R-Alt', MetaLeft: 'L-Cmd', MetaRight: 'R-Cmd', Backquote: '`',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Tab: 'Tab',
  Escape: 'Esc', CapsLock: 'Caps', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  MouseLeft: 'LMB', MouseRight: 'RMB', MouseMiddle: 'MMB',
};

export function keyLabel(code: string): string {
  if (!code) return '';
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  return code;
}

/** Readable name from a package id: com.example.super_game -> Super Game. */
export function prettyPackage(id: string): string {
  const parts = id.split('.').filter((p) => !['com', 'net', 'org', 'android', 'app', 'game', 'games', 'global', 'gp'].includes(p));
  const last = parts[parts.length - 1] ?? id;
  return last.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function svgIcon(name: 'play' | 'refresh' | 'trash' | 'download' | 'stop' | 'remove' | 'gamepad' | 'diagnostics'): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'btn-svg');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  if (name === 'play') {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '7 4 19 12 7 20 7 4');
    poly.setAttribute('fill', 'currentColor');
    svg.append(poly);
  } else if (name === 'refresh') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67');
    svg.append(path);
  } else if (name === 'remove') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M18 6 6 18M6 6l12 12');
    svg.append(path);
  } else if (name === 'trash') {
    const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p1.setAttribute('points', '3 6 5 6 21 6');
    const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p2.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
    svg.append(p1, p2);
  } else if (name === 'download') {
    const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p1.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
    const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p2.setAttribute('points', '7 10 12 15 17 10');
    const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l1.setAttribute('x1', '12'); l1.setAttribute('y1', '15'); l1.setAttribute('x2', '12'); l1.setAttribute('y2', '3');
    svg.append(p1, p2, l1);
  } else if (name === 'stop') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '6'); rect.setAttribute('y', '6'); rect.setAttribute('width', '12'); rect.setAttribute('height', '12');
    rect.setAttribute('fill', 'currentColor');
    svg.append(rect);
  } else if (name === 'gamepad') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '2'); rect.setAttribute('y', '6'); rect.setAttribute('width', '20'); rect.setAttribute('height', '12'); rect.setAttribute('rx', '4');
    const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p1.setAttribute('d', 'M6 12h4M8 10v4M15 13h.01M18 11h.01');
    svg.append(rect, p1);
  } else if (name === 'diagnostics') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M22 12h-4l-3 9L9 3l-3 9H2');
    svg.append(path);
  }
  return svg;
}

