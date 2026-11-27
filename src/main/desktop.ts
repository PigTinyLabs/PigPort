import readline from 'node:readline';

type FileFilter = { name: string; extensions: string[] };
type FileDialogOptions = { title?: string; defaultPath?: string; filters?: FileFilter[] };
type Dialogs = {
  open: {
    options: FileDialogOptions & { properties: ('openFile' | 'openDirectory' | 'createDirectory' | 'multiSelections')[] };
    result: { canceled: boolean; filePaths: string[] };
  };
  save: { options: FileDialogOptions; result: { canceled: boolean; filePath?: string } };
  message: {
    options: {
      type: 'question'; message: string; detail?: string; buttons: string[];
      defaultId: number; cancelId: number; checkboxLabel?: string; checkboxChecked?: boolean;
    };
    result: { response: number; checkboxChecked: boolean };
  };
};

const handlers = new Map<string, (args: unknown[]) => unknown>();
const pendingDialogs = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
const activeRequests = new Set<Promise<void>>();
let nextDialogId = 0;
let connected = true;

function send(message: unknown): void {
  if (connected) process.stdout.write(JSON.stringify(message) + '\n');
}

export function emit(event: string, payload: unknown): void { send({ event, payload }); }

export function register<A extends unknown[], R>(method: string, fn: (...args: A) => R): void {
  if (handlers.has(method)) throw new Error(`Duplicate PigPort worker method ${method}`);
  handlers.set(method, (args) => fn(...(args as A)));
}

export function requestDialog<K extends keyof Dialogs>(dialog: K, options: Dialogs[K]['options']): Promise<Dialogs[K]['result']> {
  if (!connected) return Promise.reject(new Error('The PigPort window closed.'));
  const dialogId = ++nextDialogId;
  return new Promise((resolve, reject) => {
    pendingDialogs.set(dialogId, { resolve: (result) => resolve(result as Dialogs[K]['result']), reject });
    send({ dialogId, dialog, options });
  });
}

async function dispatch(id: number, method: string, args: unknown[]): Promise<void> {
  try {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`Unknown PigPort worker method ${method}`);
    // Array slots containing undefined are encoded as null by the host.
    const result = await handler(args.map((value) => value === null ? undefined : value));
    send({ id, result: result ?? null });
  } catch (error) {
    send({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

export function receive(onDisconnect: () => Promise<void>): void {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  process.stdout.on('error', () => input.close());
  process.stdin.on('error', () => input.close());
  input.on('line', (line) => {
    let message: { id?: number; method?: string; args?: unknown[]; dialogId?: number; result?: unknown; error?: string };
    try { message = JSON.parse(line); }
    catch { return; }
    if (!message || typeof message !== 'object') return;
    if (typeof message.dialogId === 'number') {
      const dialog = pendingDialogs.get(message.dialogId);
      pendingDialogs.delete(message.dialogId);
      if (typeof message.error === 'string') dialog?.reject(new Error(message.error));
      else dialog?.resolve(message.result);
      return;
    }
    if (typeof message.id !== 'number' || typeof message.method !== 'string' || !Array.isArray(message.args)) return;
    const request = dispatch(message.id, message.method, message.args);
    activeRequests.add(request);
    void request.finally(() => activeRequests.delete(request));
  });
  input.once('close', () => {
    connected = false;
    process.stdin.pause();
    for (const dialog of pendingDialogs.values()) dialog.reject(new Error('The PigPort window closed.'));
    pendingDialogs.clear();
    void Promise.allSettled(activeRequests).then(onDisconnect).then(
      () => process.exit(0),
      (error) => { console.error(error); process.exit(1); },
    );
  });
}
