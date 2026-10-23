// Reads a game controller through the browser Gamepad API (Xbox, PlayStation, Switch Pro and
// most Bluetooth/USB pads use the W3C "standard" layout that PAD_BUTTONS follows).
import { PAD_BUTTONS, type Stick } from '../shared/keymap.js';

export interface PadHandlers {
  button(code: string, down: boolean): void;
  stick?(which: Stick, x: number, y: number, now: number, dtMs: number): void;
}

/** The first connected controller, if any. */
export function activePad(): Gamepad | undefined {
  return [...navigator.getGamepads()].find((pad): pad is Gamepad => !!pad && pad.connected);
}

/** Polls the first connected controller once per animation frame while started. */
export class GamepadPoller {
  private frame = 0;
  private last = 0;
  private pressed = new Set<string>();

  constructor(private handlers: PadHandlers) {}

  start(): void {
    if (!this.frame) this.frame = requestAnimationFrame(this.poll);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.last = 0;
    this.releaseAll();
  }

  private releaseAll(): void {
    for (const code of this.pressed) this.handlers.button(code, false);
    this.pressed.clear();
  }

  private poll = (now: number): void => {
    this.frame = requestAnimationFrame(this.poll);
    const pad = activePad();
    if (!pad) {
      this.releaseAll();
      this.last = 0;
      return;
    }
    const dt = this.last ? now - this.last : 16;
    this.last = now;
    PAD_BUTTONS.forEach((code, i) => {
      const button = pad.buttons[i];
      // Triggers report an analog value; treat half-way as pressed.
      const down = !!button && (button.pressed || button.value > 0.5);
      if (down === this.pressed.has(code)) return;
      if (down) this.pressed.add(code);
      else this.pressed.delete(code);
      this.handlers.button(code, down);
    });
    this.handlers.stick?.('left', pad.axes[0] ?? 0, pad.axes[1] ?? 0, now, dt);
    this.handlers.stick?.('right', pad.axes[2] ?? 0, pad.axes[3] ?? 0, now, dt);
  };
}
