import type { PlayBridgeApi } from '../shared/api';
import { emptyKeymap, Keymap, KeymapElement, TouchEvent, TouchMapper } from '../shared/keymap.js';
import { H264Decoder } from './decoder.js';
import { el, keyLabel, toast } from './ui.js';

declare const playbridge: PlayBridgeApi;

const ACTION = { down: 0, up: 1, move: 2 } as const;
const MOUSE_CODES = ['MouseLeft', 'MouseMiddle', 'MouseRight'];

type Binding = { index: number; slot?: 'key' | 'up' | 'down' | 'left' | 'right' | 'toggle' };

/** Streams an Android device into a canvas and maps keyboard/mouse to touches. */
export class Player {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLElement;
  private toolbar: HTMLElement;
  private inspector: HTMLElement;
  private status: HTMLElement;
  private decoder: H264Decoder;
  private mapper = new TouchMapper(emptyKeymap(), 1, 1);
  private keymap: Keymap = emptyKeymap();
  private appId = '_device';
  private frameW = 0;
  private frameH = 0;
  private editing = false;
  private selected = -1;
  private waitingFor?: Binding;
  private mouseDown = false;
  private tickTimer = 0;
  private dirty = false;
  onExit: () => void = () => undefined;

  constructor() {
    this.canvas = el('canvas', { class: 'screen' });
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.overlay = el('div', { class: 'overlay' });
    this.stage = el('div', { class: 'stage' }, this.canvas, this.overlay,
      el('div', { class: 'stage-empty' }, 'Connecting to device…'));
    this.status = el('span', { class: 'player-status' });
    this.inspector = el('div', { class: 'inspector' });
    this.toolbar = el('div', { class: 'player-toolbar' });
    this.root = el('section', { class: 'player', hidden: '' }, this.toolbar, this.stage, this.inspector);
    this.decoder = new H264Decoder((f) => this.drawFrame(f), (m) => toast(m, 'error'));

    playbridge.stream.onMeta((m) => {
      this.status.textContent = `${m.deviceName} · ${m.width}×${m.height}`;
      this.resize(m.width, m.height);
    });
    playbridge.stream.onPacket((p) => this.decoder.push(p));
    playbridge.stream.onClosed((reason) => {
      if (reason !== 'stopped') toast(`Stream ended: ${reason}`, 'error');
      this.teardown();
      this.onExit();
    });

    this.bindInput();
    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.renderToolbar();
  }

  async open(serial: string, appId: string, title: string): Promise<void> {
    this.appId = appId;
    this.keymap = await playbridge.keymap.load(appId);
    this.send(this.mapper.setKeymap(this.keymap));
    this.editing = false;
    this.selected = -1;
    this.dirty = false;
    this.frameW = this.frameH = 0;
    this.stage.classList.remove('live', 'sized');
    this.root.hidden = false;
    this.root.dataset.title = title;
    this.renderToolbar();
    this.renderOverlay();
    try {
      await playbridge.stream.start(serial);
    } catch (e) {
      toast((e as Error).message, 'error');
      this.close();
      return;
    }
    this.tickTimer = window.setInterval(() => this.send(this.mapper.tick(performance.now())), 30);
  }

  close(): void {
    void playbridge.stream.stop();
    this.teardown();
    this.onExit();
  }

  private teardown(): void {
    window.clearInterval(this.tickTimer);
    if (document.pointerLockElement) document.exitPointerLock();
    this.send(this.mapper.releaseAll());
    this.decoder.close();
    this.root.hidden = true;
  }

  // ---- video ----

  private drawFrame(frame: VideoFrame): void {
    this.resize(frame.displayWidth, frame.displayHeight);
    this.stage.classList.add('live');
    this.ctx.drawImage(frame, 0, 0);
    frame.close();
  }

  private resize(w: number, h: number): void {
    if (w === this.frameW && h === this.frameH) return;
    // Rotation or new stream: lift fingers that refer to the old geometry.
    this.send(this.mapper.releaseAll());
    this.frameW = this.canvas.width = w;
    this.frameH = this.canvas.height = h;
    this.mapper.setSize(w, h);
    this.layout();
  }

  /** Fits the canvas (and the overlay on top of it) inside the stage, keeping aspect ratio. */
  private layout(): void {
    if (!this.frameW) return;
    this.stage.classList.add('sized');
    const box = this.stage.getBoundingClientRect();
    const scale = Math.min(box.width / this.frameW, box.height / this.frameH);
    const w = Math.floor(this.frameW * scale);
    const h = Math.floor(this.frameH * scale);
    for (const node of [this.canvas, this.overlay]) {
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
      node.style.left = `${Math.floor((box.width - w) / 2)}px`;
      node.style.top = `${Math.floor((box.height - h) / 2)}px`;
    }
  }

  private toFrame(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * this.frameW,
      y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) * this.frameH,
    };
  }

  private send(events: TouchEvent[]): void {
    if (!this.frameW) return;
    for (const t of events) {
      playbridge.stream.touch(ACTION[t.action], t.pointerId, t.x, t.y, this.frameW, this.frameH);
    }
  }

  // ---- input ----

  private bindInput(): void {
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden || isTyping(e)) return;
      if (this.editing) return this.editorKey(e);
      if (e.code === this.keymap.mouseLookToggle) {
        e.preventDefault();
        if (e.repeat) return;
        if (document.pointerLockElement) document.exitPointerLock();
        else void this.canvas.requestPointerLock();
        return;
      }
      if (this.mapper.isBound(e.code)) {
        e.preventDefault();
        this.send(this.mapper.keyDown(e.code));
      }
    });
    window.addEventListener('keyup', (e) => {
      if (this.root.hidden || this.editing) return;
      this.send(this.mapper.keyUp(e.code));
    });
    window.addEventListener('blur', () => this.send(this.mapper.releaseAll()));
    document.addEventListener('pointerlockchange', () => {
      this.stage.classList.toggle('mouse-look', document.pointerLockElement === this.canvas);
      if (!document.pointerLockElement) this.send(this.mapper.releaseAll());
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => {
      if (this.editing || !this.frameW) return;
      if (document.pointerLockElement === this.canvas) {
        this.send(this.mapper.keyDown(MOUSE_CODES[e.button] ?? 'MouseLeft'));
        return;
      }
      if (e.button !== 0) return;
      this.mouseDown = true;
      const p = this.toFrame(e);
      this.send([{ action: 'down', pointerId: 0, ...p }]);
    });
    window.addEventListener('mousemove', (e) => {
      if (this.root.hidden || this.editing) return;
      if (document.pointerLockElement === this.canvas) {
        this.send(this.mapper.mouseMove(e.movementX, e.movementY, performance.now()));
      } else if (this.mouseDown) {
        this.send([{ action: 'move', pointerId: 0, ...this.toFrame(e) }]);
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (this.root.hidden || this.editing) return;
      if (document.pointerLockElement === this.canvas) {
        this.send(this.mapper.keyUp(MOUSE_CODES[e.button] ?? 'MouseLeft'));
      } else if (this.mouseDown && e.button === 0) {
        this.mouseDown = false;
        this.send([{ action: 'up', pointerId: 0, ...this.toFrame(e) }]);
      }
    });
  }

  // ---- toolbar ----

  private renderToolbar(): void {
    const title = this.root.dataset.title ?? '';
    const nav = (b: 'back' | 'home' | 'recents', label: string, hint: string) =>
      el('button', { class: 'icon-btn', title: hint, onclick: () => playbridge.stream.nav(b) }, label);
    const left = el('div', { class: 'tb-group' },
      el('button', { class: 'btn ghost', onclick: () => this.close() }, '← Library'),
      el('strong', { class: 'tb-title' }, title), this.status);
    const right = this.editing
      ? el('div', { class: 'tb-group' },
        el('button', { class: 'btn', onclick: () => this.add('button') }, '+ Button'),
        el('button', { class: 'btn', onclick: () => this.add('joystick') }, '+ Joystick'),
        el('button', { class: 'btn', onclick: () => this.add('camera') }, '+ Mouse look'),
        el('span', { class: 'tb-sep' }),
        el('button', { class: 'btn ghost', onclick: () => this.importKeymap() }, 'Import'),
        el('button', { class: 'btn ghost', onclick: () => playbridge.keymap.export(this.appId, this.keymap) }, 'Export'),
        el('button', { class: 'btn primary', onclick: () => this.finishEditing() }, 'Save'))
      : el('div', { class: 'tb-group' },
        nav('back', '◁', 'Back'), nav('home', '○', 'Home'), nav('recents', '▢', 'Recent apps'),
        el('span', { class: 'tb-sep' }),
        el('span', { class: 'hint' }, `${keyLabel(this.keymap.mouseLookToggle)} mouse look`),
        el('button', { class: 'btn', onclick: () => this.startEditing() }, 'Edit controls'));
    this.toolbar.replaceChildren(left, right);
    this.root.classList.toggle('editing', this.editing);
  }

  // ---- editor ----

  private startEditing(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    this.send(this.mapper.releaseAll());
    this.editing = true;
    this.renderToolbar();
    this.renderOverlay();
  }

  private async finishEditing(): Promise<void> {
    try {
      await playbridge.keymap.save(this.appId, this.keymap);
      this.dirty = false;
      toast('Controls saved');
    } catch (e) {
      return toast((e as Error).message, 'error');
    }
    this.editing = false;
    this.selected = -1;
    this.waitingFor = undefined;
    this.send(this.mapper.setKeymap(this.keymap));
    this.renderToolbar();
    this.renderOverlay();
  }

  private async importKeymap(): Promise<void> {
    try {
      const map = await playbridge.keymap.import();
      if (!map) return;
      this.keymap = map;
      this.selected = -1;
      this.changed();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  private add(type: KeymapElement['type']): void {
    const base = { x: 0.5, y: 0.5 };
    const e: KeymapElement = type === 'button' ? { type, key: '', ...base }
      : type === 'joystick' ? { type, up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', radius: 0.1, x: 0.18, y: 0.72 }
        : { type, radius: 0.2, sensitivity: 1, x: 0.7, y: 0.45 };
    this.keymap.elements.push(e);
    this.selected = this.keymap.elements.length - 1;
    this.waitingFor = type === 'button' ? { index: this.selected, slot: 'key' } : undefined;
    this.changed();
  }

  private remove(index: number): void {
    this.keymap.elements.splice(index, 1);
    this.selected = -1;
    this.waitingFor = undefined;
    this.changed();
  }

  private editorKey(e: KeyboardEvent): void {
    if (this.waitingFor) {
      e.preventDefault();
      if (e.code === 'Escape') {
        this.waitingFor = undefined;
      } else {
        this.assign(this.waitingFor, e.code);
      }
      this.changed();
      return;
    }
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.selected >= 0) {
      e.preventDefault();
      this.remove(this.selected);
    }
  }

  private assign(b: Binding, code: string): void {
    if (b.slot === 'toggle') {
      this.keymap.mouseLookToggle = code;
    } else {
      const target = this.keymap.elements[b.index] as unknown as Record<string, unknown>;
      if (target && b.slot) target[b.slot] = code;
    }
    this.waitingFor = undefined;
  }

  private changed(): void {
    this.dirty = true;
    this.renderOverlay();
  }

  private renderOverlay(): void {
    const nodes = this.keymap.elements.map((e, i) => this.renderElement(e, i));
    this.overlay.replaceChildren(...nodes);
    this.overlay.classList.toggle('editing', this.editing);
    this.renderInspector();
  }

  private renderElement(e: KeymapElement, i: number): HTMLElement {
    const node = el('div', { class: `km km-${e.type}${i === this.selected ? ' selected' : ''}` });
    node.style.left = `${e.x * 100}%`;
    node.style.top = `${e.y * 100}%`;
    if (e.type === 'button') {
      node.textContent = this.isWaiting(i, 'key') ? '…' : keyLabel(e.key) || '?';
    } else if (e.type === 'joystick') {
      node.style.setProperty('--r', `${e.radius * 2 * 100}cqh`);
      node.append(el('span', { class: 'km-ring' }),
        el('span', { class: 'km-up' }, keyLabel(e.up)), el('span', { class: 'km-down' }, keyLabel(e.down)),
        el('span', { class: 'km-left' }, keyLabel(e.left)), el('span', { class: 'km-right' }, keyLabel(e.right)));
    } else {
      node.style.setProperty('--r', `${e.radius * 2 * 100}cqh`);
      node.append(el('span', { class: 'km-ring' }), el('span', { class: 'km-label' }, 'Mouse look'));
    }
    if (this.editing) this.makeDraggable(node, i);
    return node;
  }

  private makeDraggable(node: HTMLElement, i: number): void {
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      this.selected = i;
      if (this.waitingFor && this.waitingFor.index !== i) this.waitingFor = undefined;
      const rect = this.overlay.getBoundingClientRect();
      const move = (m: PointerEvent) => {
        const e = this.keymap.elements[i];
        e.x = Math.min(Math.max((m.clientX - rect.left) / rect.width, 0), 1);
        e.y = Math.min(Math.max((m.clientY - rect.top) / rect.height, 0), 1);
        node.style.left = `${e.x * 100}%`;
        node.style.top = `${e.y * 100}%`;
        this.dirty = true;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.renderOverlay();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      this.renderOverlay();
    });
  }

  private isWaiting(index: number, slot: Binding['slot']): boolean {
    return this.waitingFor?.index === index && this.waitingFor.slot === slot;
  }

  private keyButton(b: Binding, current: string): HTMLElement {
    const waiting = this.waitingFor?.index === b.index && this.waitingFor.slot === b.slot;
    return el('button', {
      class: `keycap${waiting ? ' waiting' : ''}`,
      onclick: () => {
        // Drop focus so Space/Enter are captured as the binding, not as a click.
        (document.activeElement as HTMLElement | null)?.blur();
        this.waitingFor = b;
        this.renderOverlay();
      },
    }, waiting ? 'Press a key…' : keyLabel(current) || 'Set key');
  }

  private slider(label: string, value: number, min: number, max: number, step: number,
    set: (v: number) => void): HTMLElement {
    const out = el('output', {}, value.toFixed(2));
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener('input', () => {
      set(Number(input.value));
      out.textContent = Number(input.value).toFixed(2);
      this.dirty = true;
      this.overlay.replaceChildren(...this.keymap.elements.map((e, i) => this.renderElement(e, i)));
    });
    return el('label', { class: 'field' }, el('span', {}, label), input, out);
  }

  private renderInspector(): void {
    if (!this.editing) {
      this.inspector.replaceChildren();
      return;
    }
    const rows: HTMLElement[] = [
      el('h3', {}, 'Controls'),
      el('p', { class: 'muted' }, 'Add controls, drag them onto the game, then click a key slot and press a key. Mouse buttons can be bound too while mouse look is on.'),
      el('div', { class: 'field' }, el('span', {}, 'Mouse look toggle'),
        this.keyButton({ index: -1, slot: 'toggle' }, this.keymap.mouseLookToggle)),
    ];
    const e = this.keymap.elements[this.selected];
    if (e) {
      const i = this.selected;
      rows.push(el('h3', {}, e.type === 'button' ? 'Button' : e.type === 'joystick' ? 'Joystick' : 'Mouse look area'));
      if (e.type === 'button') {
        rows.push(el('div', { class: 'field' }, el('span', {}, 'Key'), this.keyButton({ index: i, slot: 'key' }, e.key)),
          el('div', { class: 'field' }, el('span', {}, 'Mouse'),
            el('div', { class: 'row' }, ...MOUSE_CODES.map((c) =>
              el('button', { class: 'btn small', onclick: () => { this.assign({ index: i, slot: 'key' }, c); this.changed(); } },
                keyLabel(c))))));
      } else if (e.type === 'joystick') {
        for (const slot of ['up', 'down', 'left', 'right'] as const) {
          rows.push(el('div', { class: 'field' }, el('span', {}, slot[0].toUpperCase() + slot.slice(1)),
            this.keyButton({ index: i, slot }, e[slot])));
        }
        rows.push(this.slider('Radius', e.radius, 0.03, 0.3, 0.01, (v) => { e.radius = v; }));
      } else {
        rows.push(this.slider('Drag area', e.radius, 0.05, 0.5, 0.01, (v) => { e.radius = v; }),
          this.slider('Sensitivity', e.sensitivity, 0.1, 4, 0.05, (v) => { e.sensitivity = v; }));
      }
      rows.push(el('button', { class: 'btn danger', onclick: () => this.remove(i) }, 'Remove'));
    }
    if (this.dirty) rows.push(el('p', { class: 'muted' }, 'Unsaved changes'));
    this.inspector.replaceChildren(...rows);
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
