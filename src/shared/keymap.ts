// Keymap profiles for the Android player.
//
// Coordinates are normalized to the game's content area (0..1 on each axis),
// so one profile keeps working when the window or stream resolution changes.
// Keys use KeyboardEvent.code names ("KeyW", "Space", ...) plus the pseudo
// codes MouseLeft / MouseRight / MouseMiddle.

export type KeyCode = string;

export interface ButtonElement {
  type: 'button';
  key: KeyCode;
  x: number;
  y: number;
}

export interface JoystickElement {
  type: 'joystick';
  up: KeyCode;
  down: KeyCode;
  left: KeyCode;
  right: KeyCode;
  x: number;
  y: number;
  /** Thumb travel, as a fraction of the content height. */
  radius: number;
}

export interface CameraElement {
  type: 'camera';
  x: number;
  y: number;
  /** Drag distance before the virtual finger is lifted and re-centred, fraction of height. */
  radius: number;
  /** Touch pixels moved per mouse pixel. */
  sensitivity: number;
}

export type KeymapElement = ButtonElement | JoystickElement | CameraElement;

export interface Keymap {
  version: 1;
  /** Key that toggles mouse-look (pointer lock / hidden cursor). */
  mouseLookToggle: KeyCode;
  elements: KeymapElement[];
}

export function emptyKeymap(): Keymap {
  return { version: 1, mouseLookToggle: 'Backquote', elements: [] };
}

export function parseKeymap(text: string): Keymap {
  const raw = JSON.parse(text);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.elements)) {
    throw new Error('Not a PigPort keymap (expected version 1 with an elements array)');
  }
  const elements: KeymapElement[] = [];
  for (const e of raw.elements) {
    const x = clamp01(Number(e.x));
    const y = clamp01(Number(e.y));
    if (e.type === 'button' && typeof e.key === 'string') {
      elements.push({ type: 'button', key: e.key, x, y });
    } else if (e.type === 'joystick') {
      elements.push({
        type: 'joystick', x, y,
        up: String(e.up ?? 'KeyW'), down: String(e.down ?? 'KeyS'),
        left: String(e.left ?? 'KeyA'), right: String(e.right ?? 'KeyD'),
        radius: positive(e.radius, 0.1),
      });
    } else if (e.type === 'camera') {
      elements.push({ type: 'camera', x, y, radius: positive(e.radius, 0.2), sensitivity: positive(e.sensitivity, 1) });
    }
  }
  return { version: 1, mouseLookToggle: String(raw.mouseLookToggle ?? 'Backquote'), elements };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

function positive(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface TouchEvent {
  action: 'down' | 'move' | 'up';
  pointerId: number;
  /** Pixels in the content area. */
  x: number;
  y: number;
}

/** Turns keyboard / mouse input into virtual touches according to a keymap. */
export class TouchMapper {
  private pressed = new Set<KeyCode>();
  private active = new Map<number, { x: number; y: number }>();
  private cameraLastMove = 0;

  constructor(private map: Keymap, private width: number, private height: number) {}

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setKeymap(map: Keymap): TouchEvent[] {
    const out = this.releaseAll();
    this.map = map;
    return out;
  }

  /** Returns true if the key is bound to anything (caller should swallow it). */
  isBound(code: KeyCode): boolean {
    return this.map.elements.some((e) =>
      (e.type === 'button' && e.key === code) ||
      (e.type === 'joystick' && [e.up, e.down, e.left, e.right].includes(code)));
  }

  keyDown(code: KeyCode): TouchEvent[] {
    if (this.pressed.has(code)) return []; // key repeat
    this.pressed.add(code);
    return this.update(code);
  }

  keyUp(code: KeyCode): TouchEvent[] {
    if (!this.pressed.delete(code)) return [];
    return this.update(code);
  }

  /** Relative mouse motion while mouse-look is on. */
  mouseMove(dx: number, dy: number, now: number): TouchEvent[] {
    const out: TouchEvent[] = [];
    this.map.elements.forEach((e, i) => {
      if (e.type !== 'camera') return;
      const id = this.pointerId(i);
      const cx = e.x * this.width;
      const cy = e.y * this.height;
      let cur = this.active.get(id);
      if (!cur) {
        cur = { x: cx, y: cy };
        this.active.set(id, cur);
        out.push({ action: 'down', pointerId: id, x: cx, y: cy });
      }
      cur.x += dx * e.sensitivity;
      cur.y += dy * e.sensitivity;
      const limit = e.radius * this.height;
      if (Math.hypot(cur.x - cx, cur.y - cy) > limit) {
        // Out of drag room: lift and start a fresh drag from the centre.
        out.push({ action: 'up', pointerId: id, x: cur.x, y: cur.y });
        this.active.set(id, { x: cx, y: cy });
        out.push({ action: 'down', pointerId: id, x: cx, y: cy });
      } else {
        out.push({ action: 'move', pointerId: id, x: cur.x, y: cur.y });
      }
      this.cameraLastMove = now;
    });
    return out;
  }

  /** Lift the camera finger once the mouse has been still for a moment. */
  tick(now: number, idleMs = 120): TouchEvent[] {
    if (now - this.cameraLastMove < idleMs) return [];
    const out: TouchEvent[] = [];
    this.map.elements.forEach((e, i) => {
      if (e.type !== 'camera') return;
      const id = this.pointerId(i);
      const cur = this.active.get(id);
      if (cur) {
        this.active.delete(id);
        out.push({ action: 'up', pointerId: id, x: cur.x, y: cur.y });
      }
    });
    return out;
  }

  releaseAll(): TouchEvent[] {
    const out: TouchEvent[] = [];
    for (const [id, p] of this.active) out.push({ action: 'up', pointerId: id, x: p.x, y: p.y });
    this.active.clear();
    this.pressed.clear();
    return out;
  }

  // Pointer 0 is reserved for direct mouse clicks on the game.
  private pointerId(index: number): number {
    return index + 1;
  }

  private update(changed: KeyCode): TouchEvent[] {
    const out: TouchEvent[] = [];
    this.map.elements.forEach((e, i) => {
      const id = this.pointerId(i);
      if (e.type === 'button' && e.key === changed) {
        const x = e.x * this.width;
        const y = e.y * this.height;
        if (this.pressed.has(changed)) {
          this.active.set(id, { x, y });
          out.push({ action: 'down', pointerId: id, x, y });
        } else if (this.active.delete(id)) {
          out.push({ action: 'up', pointerId: id, x, y });
        }
      } else if (e.type === 'joystick' && [e.up, e.down, e.left, e.right].includes(changed)) {
        out.push(...this.updateJoystick(e, id));
      }
    });
    return out;
  }

  private updateJoystick(e: JoystickElement, id: number): TouchEvent[] {
    let dx = (this.pressed.has(e.right) ? 1 : 0) - (this.pressed.has(e.left) ? 1 : 0);
    let dy = (this.pressed.has(e.down) ? 1 : 0) - (this.pressed.has(e.up) ? 1 : 0);
    const cx = e.x * this.width;
    const cy = e.y * this.height;
    const cur = this.active.get(id);
    if (dx === 0 && dy === 0) {
      if (!cur) return [];
      this.active.delete(id);
      return [{ action: 'up', pointerId: id, x: cur.x, y: cur.y }];
    }
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const r = e.radius * this.height;
    const target = { x: cx + dx * r, y: cy + dy * r };
    const out: TouchEvent[] = [];
    if (!cur) out.push({ action: 'down', pointerId: id, x: cx, y: cy });
    this.active.set(id, target);
    out.push({ action: 'move', pointerId: id, x: target.x, y: target.y });
    return out;
  }
}
