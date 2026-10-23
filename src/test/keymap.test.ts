import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keymap, parseKeymap, TouchMapper } from '../shared/keymap';

const map: Keymap = {
  version: 1,
  mouseLookToggle: 'Backquote',
  elements: [
    { type: 'button', key: 'Space', x: 0.9, y: 0.8 },
    { type: 'joystick', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', x: 0.2, y: 0.7, radius: 0.1 },
    { type: 'camera', x: 0.6, y: 0.5, radius: 0.1, sensitivity: 1 },
  ],
};

test('button press and release map to one finger', () => {
  const m = new TouchMapper(map, 1000, 500);
  assert.deepEqual(m.keyDown('Space'), [{ action: 'down', pointerId: 1, x: 900, y: 400 }]);
  assert.deepEqual(m.keyDown('Space'), [], 'key repeat is ignored');
  assert.deepEqual(m.keyUp('Space'), [{ action: 'up', pointerId: 1, x: 900, y: 400 }]);
});

test('joystick presses at centre, moves to the direction, lifts when released', () => {
  const m = new TouchMapper(map, 1000, 500);
  assert.deepEqual(m.keyDown('KeyW'), [
    { action: 'down', pointerId: 2, x: 200, y: 350 },
    { action: 'move', pointerId: 2, x: 200, y: 300 },
  ]);
  const diag = m.keyDown('KeyD');
  assert.equal(diag.length, 1);
  assert.equal(diag[0].action, 'move');
  assert.ok(Math.abs(diag[0].x - (200 + 50 / Math.SQRT2)) < 1e-9);
  assert.ok(Math.abs(diag[0].y - (350 - 50 / Math.SQRT2)) < 1e-9);
  m.keyUp('KeyW');
  assert.deepEqual(m.keyUp('KeyD'), [{ action: 'up', pointerId: 2, x: 250, y: 350 }]);
});

test('opposite directions cancel out', () => {
  const m = new TouchMapper(map, 1000, 500);
  m.keyDown('KeyA');
  assert.equal(m.keyDown('KeyD')[0].action, 'up');
});

test('mouse look drags, re-centres past the radius and lifts when idle', () => {
  const m = new TouchMapper(map, 1000, 500);
  assert.deepEqual(m.mouseMove(10, 0, 0), [
    { action: 'down', pointerId: 3, x: 600, y: 250 },
    { action: 'move', pointerId: 3, x: 610, y: 250 },
  ]);
  const jump = m.mouseMove(60, 0, 10); // 70px > 50px radius
  assert.deepEqual(jump.map((e) => e.action), ['up', 'down']);
  assert.deepEqual(m.tick(50), [], 'not idle yet');
  assert.deepEqual(m.tick(200), [{ action: 'up', pointerId: 3, x: 600, y: 250 }]);
});

test('releaseAll lifts every active finger', () => {
  const m = new TouchMapper(map, 1000, 500);
  m.keyDown('Space');
  m.keyDown('KeyS');
  assert.deepEqual(m.releaseAll().map((e) => e.pointerId).sort(), [1, 2]);
  assert.deepEqual(m.keyUp('Space'), []);
});

test('parseKeymap clamps coordinates and rejects foreign files', () => {
  const parsed = parseKeymap(JSON.stringify({ version: 1, elements: [{ type: 'button', key: 'KeyF', x: 2, y: -1 }] }));
  assert.deepEqual(parsed.elements[0], { type: 'button', key: 'KeyF', x: 1, y: 0 });
  assert.equal(parsed.mouseLookToggle, 'Backquote');
  assert.throws(() => parseKeymap('{"hello":1}'));
});

test('joystick with Numpad keys moves and lifts correctly', () => {
  const numpadMap: Keymap = {
    version: 1,
    mouseLookToggle: 'Backquote',
    elements: [
      { type: 'joystick', up: 'Numpad8', down: 'Numpad2', left: 'Numpad4', right: 'Numpad6', x: 0.2, y: 0.7, radius: 0.1 },
    ],
  };
  const m = new TouchMapper(numpadMap, 1000, 500);
  assert.ok(m.isBound('Numpad8'));
  assert.ok(m.isBound('Numpad6'));
  assert.deepEqual(m.keyDown('Numpad8'), [
    { action: 'down', pointerId: 1, x: 200, y: 350 },
    { action: 'move', pointerId: 1, x: 200, y: 300 },
  ]);
  assert.deepEqual(m.keyUp('Numpad8'), [{ action: 'up', pointerId: 1, x: 200, y: 300 }]);
});
