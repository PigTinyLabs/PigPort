import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { NavButton, PlayBridgeApi, StreamMeta, StreamPacket } from '../shared/api';
import { el } from './ui.js';

type StreamEvent =
  | { type: 'meta'; data: StreamMeta }
  | { type: 'log' | 'closed'; data: string };
type StreamInput =
  | { kind: 'touch'; action: number; id: number; x: number; y: number; width: number; height: number }
  | { kind: 'nav'; button: NavButton };

function request<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

const backend = <T>(method: string) => (...args: unknown[]) => request<T>('backend_call', { method, args });

function subscribe<T>(event: string, callback: (payload: T) => void): void {
  void listen<T>(event, ({ payload }) => callback(payload)).catch((error) => console.error(error));
}

const metaListeners = new Set<(meta: StreamMeta) => void>();
const packetListeners = new Set<(packet: StreamPacket) => void>();
const logListeners = new Set<(line: string) => void>();
const closeListeners = new Set<(reason: string) => void>();

let generation = 0;
let acceptingInput = false;
let inputFlush: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
const inputQueue: StreamInput[] = [];

function queueInput(input: StreamInput): void {
  if (!acceptingInput) return;
  if (input.kind === 'touch' && input.action === 2) {
    // Only replace moves since the last press, release or navigation. Preserve input
    // order across fingers while keeping pending motion bounded during a busy frame.
    for (let i = inputQueue.length - 1; i >= 0; i--) {
      const queued = inputQueue[i];
      if (queued.kind !== 'touch' || queued.action !== 2) break;
      if (queued.id === input.id) { inputQueue.splice(i, 1); break; }
    }
  }
  inputQueue.push(input);
  if (inputFlush) return;
  inputFlush = Promise.resolve().then(async () => {
    while (inputQueue.length) {
      const inputs = inputQueue.splice(0, 64);
      await request('stream_inputs', { inputs }).catch((error) => console.error(error));
    }
    inputFlush = undefined;
  });
}

async function startStream(serial: string): Promise<void> {
  await stopping?.catch(() => {});
  const active = ++generation;
  const frames = new Channel<ArrayBuffer>();
  const events = new Channel<StreamEvent>();
  let received = 0;

  frames.onmessage = (buffer) => {
    if (active !== generation) return;
    if (++received === 3) {
      received = 0;
      void request('stream_ack', { channelId: frames.id, count: 3 }).catch((error) => console.error(error));
    }
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= 9) return;
    const header = new DataView(buffer);
    const flags = header.getUint8(0);
    const packet: StreamPacket = {
      config: (flags & 1) !== 0,
      key: (flags & 2) !== 0,
      pts: Number(header.getBigUint64(1)),
      data: new Uint8Array(buffer, 9),
    };
    packetListeners.forEach((listener) => listener(packet));
  };
  events.onmessage = (event) => {
    if (active !== generation) return;
    if (event.type === 'meta') {
      metaListeners.forEach((listener) => listener(event.data));
    } else if (event.type === 'log') {
      logListeners.forEach((listener) => listener(event.data));
    } else {
      acceptingInput = false;
      inputQueue.length = 0;
      closeListeners.forEach((listener) => listener(event.data));
    }
  };

  acceptingInput = true;
  try { await request('stream_start', { serial, frames, events }); }
  catch (error) {
    if (active === generation) acceptingInput = false;
    throw error;
  }
}

function stopStream(): Promise<void> {
  if (stopping) return stopping;
  acceptingInput = false;
  ++generation;
  stopping = (async () => {
    await inputFlush;
    await request('stream_stop');
  })().finally(() => { stopping = undefined; });
  return stopping;
}

export const playbridge: PlayBridgeApi = {
  packages: {
    inspect: backend('packages:inspect'), list: backend('packages:list'), install: backend('packages:install'),
    play: backend('packages:play'), uninstall: backend('packages:uninstall'), remove: backend('packages:remove'),
    icon: backend('packages:icon'),
  },
  runtime: {
    status: backend('runtime:status'), restartAndroid: backend('runtime:android:restart'),
    prepareAndroid: backend('runtime:android:prepare'), installAndroid: backend('runtime:android:install'),
    openGooglePlay: backend('runtime:android:openGooglePlay'),
    onProgress: (callback) => subscribe('pigport-runtime-progress', callback),
  },
  info: backend('app:info'),
  settings: { get: backend('settings:get'), set: backend('settings:set') },
  storage: { status: backend('storage:status'), choose: backend('storage:choose') },
  adb: {
    status: backend('adb:status'), devices: backend('adb:devices'), connect: backend('adb:connect'),
    wireless: backend('adb:wireless'), pair: backend('adb:pair'), enableWifi: backend('adb:enableWifi'),
    packages: backend('adb:packages'), install: backend('adb:install'), uninstall: backend('adb:uninstall'),
    launch: backend('adb:launch'), forceStop: backend('adb:forceStop'), diagnostics: backend('adb:diagnostics'),
  },
  airplay: {
    status: backend('airplay:status'), start: backend('airplay:start'), stop: backend('airplay:stop'),
    onStatus: (callback) => subscribe('pigport-airplay-status', callback),
  },
  ios: { list: backend('ios:list'), launch: backend('ios:launch'), icon: backend('ios:icon') },
  keymap: {
    load: backend('keymap:load'), save: backend('keymap:save'), export: backend('keymap:export'), import: backend('keymap:import'),
  },
  stream: {
    start: startStream, stop: stopStream,
    touch: (action, id, x, y, width, height) => queueInput({ kind: 'touch', action, id, x, y, width, height }),
    nav: (button) => queueInput({ kind: 'nav', button }),
    onMeta: (callback) => { metaListeners.add(callback); },
    onPacket: (callback) => { packetListeners.add(callback); },
    onLog: (callback) => { logListeners.add(callback); },
    onClosed: (callback) => { closeListeners.add(callback); },
  },
};

export function onFileDrop(onHover: (active: boolean) => void, onDrop: (paths: string[]) => void) {
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    onHover(payload.type === 'enter' || payload.type === 'over');
    if (payload.type === 'drop') onDrop(payload.paths);
  });
}

interface Question {
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}

async function showQuestion(question: Question): Promise<{ response: number; checkboxChecked: boolean }> {
  const checkbox = el('input', { type: 'checkbox' });
  checkbox.checked = question.checkboxChecked ?? false;
  const buttons = question.buttons.map((label, index) => el('button', {
    class: index === question.defaultId ? 'btn primary' : 'btn ghost',
    value: String(index),
  }, label));
  const dialog = el('dialog', { 'aria-labelledby': 'desktop-question' }, el('form', { method: 'dialog' },
    el('h2', { id: 'desktop-question' }, question.message),
    ...(question.detail ? [el('p', { class: 'muted desktop-dialog-detail' }, question.detail)] : []),
    ...(question.checkboxLabel ? [el('label', { class: 'row' }, checkbox, question.checkboxLabel)] : []),
    el('div', { class: 'row end desktop-dialog-buttons' }, ...buttons),
  ));
  document.body.append(dialog);
  try {
    dialog.showModal();
    buttons[question.defaultId]?.focus();
    await new Promise<void>((resolve) => dialog.addEventListener('close', () => resolve(), { once: true }));
    const response = dialog.returnValue ? Number(dialog.returnValue) : question.cancelId;
    return { response, checkboxChecked: checkbox.checked };
  } finally { dialog.remove(); }
}

export async function registerDesktopDialogs(): Promise<void> {
  let dialogs = Promise.resolve();
  await listen<{ dialogId: number; options: Question }>('pigport-dialog', ({ payload: { dialogId, options } }) => {
    dialogs = dialogs.then(async () => {
      const result = await showQuestion(options).catch((error) => {
        console.error(error);
        return { response: options.cancelId, checkboxChecked: options.checkboxChecked ?? false };
      });
      await request('backend_dialog_reply', { dialogId, result });
    }).catch((error) => console.error(error));
  });
}
