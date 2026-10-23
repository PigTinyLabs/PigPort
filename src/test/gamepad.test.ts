import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keymap, PAD_BUTTONS, parseKeymap, TouchMapper } from '../shared/keymap';

const map: Keymap = {
  version: 1,
  mouseLookToggle: 'Backquote',
  gamepad: { deadzone: 0.2, lookSpeed: 1 },
  elements: [
    { type: 'button', key: 'PadA', x: 0.9, y: 0.8 },
    { type: 'joystick', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', x: 0.2, y: 0.7, radius: 0.1, stick: 'left' },
    { type: 'camera', x: 0.6, y: 0.5, radius: 0.1, sensitivity: 1, stick: 'right' },
  ],
};

test('controller buttons use the standard gamepad order', () => {
  assert.equal(PAD_BUTTONS[0], 'PadA');
  assert.equal(PAD_BUTTONS[7], 'PadRT');
  assert.equal(PAD_BUTTONS[15], 'PadRight');
});

test('a controller button taps like a key', () => {
  const m = new TouchMapper(map, 1000, 500);
  assert.ok(m.isBound('PadA'));
  assert.deepEqual(m.keyDown('PadA'), [{ action: 'down', pointerId: 1, x: 900, y: 400 }]);
  assert.deepEqual(m.keyUp('PadA'), [{ action: 'up', pointerId: 1, x: 900, y: 400 }]);
});

test('the left stick moves the joystick in proportion and lifts at rest', () => {
  const m = new TouchMapper(map, 1000, 500);
  assert.deepEqual(m.stick('left', 0.1, 0, 0, 16), [], 'inside the dead zone');
  // Full right: the whole radius (0.1 of 500 = 50 px) from the centre (200, 350).
  assert.deepEqual(m.stick('left', 1, 0, 16, 16), [
    { action: 'down', pointerId: 2, x: 200, y: 350 },
    { action: 'move', pointerId: 2, x: 250, y: 350 },
  ]);
  // Halfway between dead zone and edge: (0.6 - 0.2) / 0.8 = half the radius.
  const half = m.stick('left', 0, -0.6, 32, 16);
  assert.equal(half.length, 1);
  assert.equal(half[0].action, 'move');
  assert.ok(Math.abs(half[0].x - 200) < 1e-9 && Math.abs(half[0].y - 325) < 1e-9);
  assert.deepEqual(m.stick('left', 0, -0.6, 48, 16), [], 'no repeat when unchanged');
  assert.deepEqual(m.stick('left', 0, 0, 64, 16), [{ action: 'up', pointerId: 2, x: 200, y: 325 }]);
});

test('held joystick keys win over the stick', () => {
  const m = new TouchMapper(map, 1000, 500);
  m.keyDown('KeyW');
  assert.deepEqual(m.stick('left', 1, 0, 0, 16), []);
});

test('the right stick turns the camera and lifts after resting', () => {
  const m = new TouchMapper(map, 1000, 500);
  // lookSpeed 1 = one content height (500 px) per second; 100 ms at full right = 50 px, past the 50 px room.
  const first = m.stick('right', 0.5, 0, 0, 20);
  assert.equal(first[0].action, 'down');
  assert.equal(first[1].action, 'move');
  assert.ok(first[1].x > 600 && first[1].y === 250);
  assert.deepEqual(m.stick('right', 0, 0, 20, 20), [], 'resting leaves the finger for tick()');
  assert.deepEqual(m.tick(500).map((e) => e.action), ['up']);
});

test('stick and controller settings survive parsing; old profiles still load', () => {
  const parsed = parseKeymap(JSON.stringify(map));
  assert.equal((parsed.elements[1] as { stick?: string }).stick, 'left');
  assert.equal((parsed.elements[2] as { stick?: string }).stick, 'right');
  assert.deepEqual(parsed.gamepad, { deadzone: 0.2, lookSpeed: 1 });
  const old = parseKeymap(JSON.stringify({ version: 1, elements: [{ type: 'joystick', x: 0.2, y: 0.7, stick: 'middle' }] }));
  assert.equal((old.elements[0] as { stick?: string }).stick, undefined);
  assert.equal(old.gamepad, undefined);
  assert.equal(parseKeymap(JSON.stringify({ ...map, gamepad: { deadzone: 9, lookSpeed: -1 } })).gamepad?.deadzone, 0.6);
});

test('D-pad buttons can control a joystick directly', () => {
  const dpadMap: Keymap = {
    version: 1,
    mouseLookToggle: 'Backquote',
    elements: [
      { type: 'joystick', up: 'PadUp', down: 'PadDown', left: 'PadLeft', right: 'PadRight', x: 0.2, y: 0.7, radius: 0.1 },
    ],
  };
  const m = new TouchMapper(dpadMap, 1000, 500);
  assert.ok(m.isBound('PadUp'));
  assert.deepEqual(m.keyDown('PadUp'), [
    { action: 'down', pointerId: 1, x: 200, y: 350 },
    { action: 'move', pointerId: 1, x: 200, y: 300 },
  ]);
  assert.deepEqual(m.keyUp('PadUp'), [{ action: 'up', pointerId: 1, x: 200, y: 300 }]);
});

test('Numpad joystick is driven by stick, and held Numpad keys win over stick', () => {
  const numpadStickMap: Keymap = {
    version: 1,
    mouseLookToggle: 'Backquote',
    elements: [
      { type: 'joystick', up: 'Numpad8', down: 'Numpad2', left: 'Numpad4', right: 'Numpad6', x: 0.2, y: 0.7, radius: 0.1, stick: 'left' },
    ],
  };
  const m = new TouchMapper(numpadStickMap, 1000, 500);
  // Stick moves it
  const stickMove = m.stick('left', 1, 0, 16, 16);
  assert.equal(stickMove.length, 2);
  assert.equal(stickMove[0].action, 'down');
  assert.equal(stickMove[1].action, 'move');
  assert.equal(stickMove[1].x, 250);
  // Pressing Numpad8 overrides stick
  m.keyDown('Numpad8');
  assert.deepEqual(m.stick('left', -1, 0, 32, 16), []);
});
