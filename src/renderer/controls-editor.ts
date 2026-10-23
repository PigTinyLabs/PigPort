import type { PlayBridgeApi } from '../shared/api';
import { DEFAULT_GAMEPAD, emptyKeymap, parseKeymap, type Keymap, type KeymapElement, type Stick } from '../shared/keymap.js';
import { activePad, GamepadPoller } from './gamepad.js';
import { el, keyLabel, toast } from './ui.js';
declare const playbridge: PlayBridgeApi;

/** A modal edits an isolated draft; only Save changes the game's stored profile. */
export class ControlsEditor {
  private dialog = el('dialog', { class: 'controls-dialog', 'aria-label': 'Control settings' });
  private map: Keymap = emptyKeymap();
  private original = '';
  private selected = -1;
  private waiting?: { index: number; slot: string };
  private appId = '';
  private name = '';
  private image?: string;
  private aspect = 16 / 9;
  private saved?: (map: Keymap) => void;
  private saving = false;
  private opening = false;
  private list = el('div', { class: 'ce-control-list' });
  private stage = el('div', { class: 'ce-preview', 'aria-label': 'Control positions' });
  private details = el('aside', { class: 'ce-details' });
  private status = el('span', { class: 'ce-status', role: 'status' });
  // While the dialog is open a controller button can be bound like a key.
  private pad = new GamepadPoller({ button: (code, down) => { if (down) this.assign(code); } });

  constructor() {
    document.body.append(this.dialog);
    this.dialog.addEventListener('close', () => this.pad.stop());
    for (const type of ['gamepadconnected', 'gamepaddisconnected']) window.addEventListener(type, () => { if (this.dialog.open) this.renderDetails(); });
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
    this.dialog.addEventListener('keydown', (e) => this.key(e));
    this.dialog.addEventListener('keyup', (e) => e.stopPropagation());
  }
  async open(appId: string, name: string, options: { map?: Keymap; image?: string; aspect?: number; saved?: (map: Keymap) => void } = {}): Promise<void> {
    if (this.dialog.open || this.opening) return;
    this.opening = true;
    try {
      this.map = parseKeymap(JSON.stringify(options.map ?? await playbridge.keymap.load(appId)));
      this.original = JSON.stringify(this.map); this.appId = appId; this.name = name;
      this.image = options.image; this.aspect = options.aspect ?? 16 / 9; this.saved = options.saved;
      this.selected = this.map.elements.length ? 0 : -1; this.waiting = undefined;
      this.render(); this.dialog.showModal(); this.pad.start();
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { this.opening = false; }
  }
  private button(label: string, action: () => void, kind = ''): HTMLButtonElement {
    return el('button', { type: 'button', class: `btn ${kind}`, onclick: action }, label);
  }
  private close(): void {
    if (this.saving) return;
    if (JSON.stringify(this.map) !== this.original && !confirm('Discard unsaved control settings?')) return;
    this.waiting = undefined; this.dialog.close();
  }
  private async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true; this.dialog.inert = true; this.dialog.setAttribute('aria-busy', 'true'); this.status.textContent = 'Saving…';
    try {
      const map = parseKeymap(JSON.stringify(this.map));
      if (map.elements.some((e) => e.type === 'button' && !e.key)) throw new Error('Assign a key to every button before saving.');
      await playbridge.keymap.save(this.appId, map);
      this.saved?.(map); this.original = JSON.stringify(map); this.dialog.close(); toast('Control settings saved');
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { this.saving = false; this.dialog.inert = false; this.dialog.removeAttribute('aria-busy'); if (this.dialog.open) this.refresh(); }
  }
  private add(type: KeymapElement['type']): void {
    const element: KeymapElement = type === 'button' ? { type, key: '', x: 0.5, y: 0.5 }
      : type === 'joystick' ? { type, x: 0.18, y: 0.73, radius: 0.12, up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', stick: 'left' }
      : { type, x: 0.65, y: 0.42, radius: 0.2, sensitivity: 1, stick: 'right' };
    this.map.elements.push(element); this.selected = this.map.elements.length - 1;
    this.waiting = undefined; this.refresh();
  }
  private addNumpadJoystick(): void {
    const element: KeymapElement = { type: 'joystick', x: 0.18, y: 0.73, radius: 0.12, up: 'Numpad8', down: 'Numpad2', left: 'Numpad4', right: 'Numpad6', stick: 'left' };
    this.map.elements.push(element); this.selected = this.map.elements.length - 1;
    this.waiting = undefined; this.refresh();
  }
  private preset(kind: 'moba' | 'fps'): void {
    if (this.map.elements.length && !confirm('Replace the current draft with this starter layout?')) return;
    this.map = emptyKeymap(); this.add('joystick');
    const buttons: [string, number, number][] = kind === 'moba'
      ? [['Space', .89, .79], ['KeyQ', .70, .83], ['KeyE', .77, .65], ['KeyR', .88, .52], ['KeyB', .55, .89]]
      : [['MouseLeft', .88, .7], ['Space', .81, .88], ['KeyR', .7, .85], ['KeyC', .63, .88]];
    for (const [key, x, y] of buttons) this.map.elements.push({ type: 'button', key, x, y });
    if (kind === 'fps') this.map.elements.push({ type: 'camera', x: .65, y: .4, radius: .2, sensitivity: 1 });
    this.selected = 0; this.refresh();
  }
  private render(): void {
    const tools = el('aside', { class: 'ce-tools' },
      el('h3', {}, 'Add a control'),
      this.button('+ Key button', () => this.add('button')),
      this.button('+ WASD joystick', () => this.add('joystick')),
      this.button('+ Numpad joystick', () => this.addNumpadJoystick()),
      this.button('+ Mouse look', () => this.add('camera')),
      el('h3', {}, 'Starter layouts'),
      this.button('MOBA', () => this.preset('moba')), this.button('FPS', () => this.preset('fps')),
      el('h3', {}, 'Your controls'), this.list);
    const center = el('section', { class: 'ce-center' },
      el('p', { class: 'muted' }, this.image ? 'Game snapshot — drag controls to match the on-screen buttons.' : 'Layout preview — adjust positions against the game when playing. Starter layouts need tuning.'),
      this.stage, el('p', { class: 'muted' }, 'Click a control to edit. Drag to move. Double-click a key button to bind it.'));
    this.dialog.replaceChildren(
      el('header', { class: 'ce-header' }, el('div', {}, el('h2', {}, 'Control settings'), el('p', { class: 'muted' }, this.name)), this.button('Close', () => this.close(), 'ghost')),
      el('div', { class: 'ce-body' }, tools, center, this.details),
      el('footer', { class: 'ce-footer' },
        this.button('Import', () => void this.importMap(), 'ghost'),
        this.button('Export draft', () => void playbridge.keymap.export(this.appId, this.map).catch((e) => toast(e.message, 'error')), 'ghost'),
        this.status, this.button('Cancel', () => this.close(), 'ghost'), this.button('Save controls', () => void this.save(), 'primary')));
    this.refresh();
  }
  private refresh(): void {
    this.list.replaceChildren(...this.map.elements.map((control, index) => {
      const stick = control.type !== 'button' && control.stick ? ` + ${control.stick} stick` : '';
      const joyType = control.type === 'joystick' ? (control.up === 'Numpad8' ? 'Numpad joystick' : control.up === 'ArrowUp' ? 'Arrow joystick' : control.up === 'PadUp' ? 'D-pad joystick' : 'WASD joystick') : '';
      const label = (control.type === 'button' ? keyLabel(control.key) || 'Unassigned' : control.type === 'joystick' ? joyType : 'Mouse look') + stick;
      return el('button', { type: 'button', class: `ce-list-item ${index === this.selected ? 'active' : ''}`, onclick: () => { this.selected = index; this.waiting = undefined; this.refresh(); } }, `${index + 1}. ${label}`);
    }));
    if (!this.map.elements.length) this.list.append(el('p', { class: 'muted' }, 'No controls yet'));
    this.renderStage(); this.renderDetails();
    this.status.textContent = this.waiting ? 'Press a key or controller button… Escape cancels binding.' : JSON.stringify(this.map) === this.original ? 'Saved profile' : 'Unsaved changes';
  }
  private renderStage(): void {
    this.stage.replaceChildren(); this.stage.style.aspectRatio = String(this.aspect); this.stage.style.setProperty('--ce-aspect', String(this.aspect));
    if (this.image) this.stage.append(el('img', { class: 'ce-game-image', src: this.image, alt: 'Current game snapshot', draggable: 'false' }));
    else this.stage.append(el('span', { class: 'ce-preview-label' }, 'GAME AREA'));
    this.map.elements.forEach((control, index) => {
      const node = el('button', { type: 'button', class: `ce-marker ce-${control.type} ${this.selected === index ? 'selected' : ''}`, 'aria-label': `Control ${index + 1}: ${control.type}` },
        control.type === 'button' ? keyLabel(control.key) || '?' : control.type === 'joystick' ? `${keyLabel(control.up)}\n${keyLabel(control.left)}  ${keyLabel(control.down)}  ${keyLabel(control.right)}` : 'Mouse look');
      node.style.left = `${control.x * 100}%`; node.style.top = `${control.y * 100}%`;
      if (control.type !== 'button') { node.style.width = `${control.radius * 200 / this.aspect}%`; node.style.height = `${control.radius * 200}%`; }
      node.addEventListener('pointerdown', (event) => {
        if (this.saving) return;
        event.preventDefault(); this.selected = index; this.waiting = undefined; this.status.textContent = JSON.stringify(this.map) === this.original ? 'Saved profile' : 'Unsaved changes';
        // Keep this node mounted until pointer capture ends.
        this.renderDetails(); this.list.querySelectorAll('.ce-list-item').forEach((n, i) => n.classList.toggle('active', i === index));
        this.stage.querySelectorAll('.ce-marker').forEach((n, i) => n.classList.toggle('selected', i === index));
        const rect = this.stage.getBoundingClientRect();
        const deltaX = event.clientX - rect.left - control.x * rect.width;
        const deltaY = event.clientY - rect.top - control.y * rect.height;
        node.setPointerCapture(event.pointerId);
        node.onpointermove = (move) => {
          control.x = Math.min(1, Math.max(0, (move.clientX - rect.left - deltaX) / rect.width));
          control.y = Math.min(1, Math.max(0, (move.clientY - rect.top - deltaY) / rect.height));
          node.style.left = `${control.x * 100}%`; node.style.top = `${control.y * 100}%`; this.status.textContent = 'Unsaved changes';
        };
        const end = () => { node.onpointermove = null; node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', end); this.renderDetails(); };
        node.addEventListener('pointerup', end, { once: true }); node.addEventListener('pointercancel', end, { once: true });
      });
      node.addEventListener('dblclick', () => { if (control.type === 'button') { this.waiting = { index, slot: 'key' }; this.refresh(); } });
      node.addEventListener('click', () => { this.selected = index; this.renderDetails(); });
      this.stage.append(node);
    });
  }
  private binding(label: string, slot: string, value: string, index = this.selected): HTMLElement {
    const waiting = this.waiting?.index === index && this.waiting.slot === slot;
    return el('div', { class: 'field' }, el('span', {}, label),
      this.button(waiting ? 'Press a key or button…' : keyLabel(value) || 'Set key', () => { this.waiting = { index, slot }; this.refresh(); }, 'ce-keycap'));
  }
  private number(label: string, value: number, min: number, max: number, step: number, assign: (value: number) => void): HTMLElement {
    const input = el('input', { type: 'number', value: String(Math.round(value * 100) / 100), min: String(min), max: String(max), step: String(step) });
    input.addEventListener('change', () => {
      if (!Number.isFinite(input.valueAsNumber)) return;
      assign(Math.min(max, Math.max(min, input.valueAsNumber))); this.refresh();
    });
    return el('label', { class: 'field' }, el('span', {}, label), input);
  }
  private stickPicker(control: { stick?: Stick }, label: string): HTMLElement {
    const select = el('select', {},
      el('option', { value: '' }, 'None'), el('option', { value: 'left' }, 'Left stick'), el('option', { value: 'right' }, 'Right stick'));
    select.value = control.stick ?? '';
    select.addEventListener('change', () => {
      if (select.value === 'left' || select.value === 'right') control.stick = select.value;
      else delete control.stick;
      this.refresh();
    });
    return el('label', { class: 'field' }, el('span', {}, label), select);
  }
  private controllerSettings(): HTMLElement[] {
    const pad = activePad();
    const settings = this.map.gamepad ?? DEFAULT_GAMEPAD;
    const update = (change: Partial<typeof settings>) => { this.map.gamepad = { ...settings, ...change }; };
    return [
      el('h3', {}, 'Controller'),
      el('p', { class: 'muted small' }, pad ? `Connected: ${pad.id.replace(/\s*\(.*\)\s*$/, '')}` : 'No controller detected. Connect one by USB or Bluetooth and press a button.'),
      this.number('Stick dead zone %', settings.deadzone * 100, 2, 60, 1, (v) => update({ deadzone: v / 100 })),
      this.number('Stick look speed', settings.lookSpeed, 0.1, 5, 0.1, (v) => update({ lookSpeed: v })),
    ];
  }
  private renderDetails(): void {
    const control = this.map.elements[this.selected];
    const rows: HTMLElement[] = [el('h3', {}, 'Properties'), this.binding('Mouse-look toggle', 'toggle', this.map.mouseLookToggle, -1)];
    if (control) {
      rows.push(el('h3', {}, `Selected ${control.type}`),
        this.number('Horizontal %', control.x * 100, 0, 100, 1, (v) => { control.x = v / 100; }),
        this.number('Vertical %', control.y * 100, 0, 100, 1, (v) => { control.y = v / 100; }));
      if (control.type === 'button') rows.push(this.binding('Key', 'key', control.key),
        el('div', { class: 'ce-mouse-buttons' }, ...['MouseLeft', 'MouseRight', 'MouseMiddle'].map((key) => this.button(keyLabel(key), () => { control.key = key; this.waiting = undefined; this.refresh(); }, 'small'))));
      if (control.type === 'joystick') {
        rows.push(el('div', { class: 'ce-mouse-buttons' },
          this.button('WASD', () => { control.up = 'KeyW'; control.down = 'KeyS'; control.left = 'KeyA'; control.right = 'KeyD'; this.refresh(); }, 'small'),
          this.button('Numpad', () => { control.up = 'Numpad8'; control.down = 'Numpad2'; control.left = 'Numpad4'; control.right = 'Numpad6'; this.refresh(); }, 'small'),
          this.button('Arrows', () => { control.up = 'ArrowUp'; control.down = 'ArrowDown'; control.left = 'ArrowLeft'; control.right = 'ArrowRight'; this.refresh(); }, 'small'),
          this.button('D-pad', () => { control.up = 'PadUp'; control.down = 'PadDown'; control.left = 'PadLeft'; control.right = 'PadRight'; this.refresh(); }, 'small'),
        ));
        for (const slot of ['up', 'left', 'down', 'right'] as const) rows.push(this.binding(slot, slot, control[slot]));
        rows.push(this.stickPicker(control, 'Controller stick'));
      }
      if (control.type !== 'button') rows.push(this.number('Radius (% of height)', control.radius * 100, 3, 40, 1, (v) => { control.radius = v / 100; }));
      if (control.type === 'camera') rows.push(this.number('Mouse sensitivity', control.sensitivity, .1, 4, .1, (v) => { control.sensitivity = v; }),
        this.stickPicker(control, 'Controller stick'));
      rows.push(this.button('Delete control', () => { this.map.elements.splice(this.selected, 1); this.selected = -1; this.waiting = undefined; this.refresh(); }, 'danger'));
    } else rows.push(el('p', { class: 'muted' }, 'Add a control or select one on the preview.'));
    rows.push(...this.controllerSettings());
    this.details.replaceChildren(...rows);
  }
  private key(event: KeyboardEvent): void {
    event.stopPropagation();
    if (!this.waiting || this.saving) return;
    event.preventDefault(); if (event.repeat) return;
    if (event.code === 'Escape') { this.waiting = undefined; this.refresh(); }
    else this.assign(event.code);
  }
  /** Binds a key or controller button (Pad*) to the slot waiting for one. */
  private assign(code: string): void {
    if (!this.waiting || this.saving) return;
    if (this.waiting.slot === 'toggle') this.map.mouseLookToggle = code;
    else {
      const element = this.map.elements[this.waiting.index];
      if (element?.type === 'button' && this.waiting.slot === 'key') element.key = code;
      if (element?.type === 'joystick' && ['up', 'down', 'left', 'right'].includes(this.waiting.slot)) element[this.waiting.slot as 'up' | 'down' | 'left' | 'right'] = code;
    }
    this.waiting = undefined; this.refresh();
  }
  private async importMap(): Promise<void> {
    try {
      const map = await playbridge.keymap.import(); if (!map) return;
      this.map = parseKeymap(JSON.stringify(map)); this.selected = -1; this.waiting = undefined; this.refresh();
    } catch (error) { toast((error as Error).message, 'error'); }
  }
}
