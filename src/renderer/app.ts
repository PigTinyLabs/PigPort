import type { AdbStatus, AppPackage, Device, IosApp, MobilePackage, PlayBridgeApi, Settings, RuntimeStatus } from '../shared/api';
import { Player } from './player.js';
import { ControlsEditor } from './controls-editor.js';
import { el, formatSize, prettyPackage, svgIcon, toast } from './ui.js';

declare const playbridge: PlayBridgeApi;

type Tab = 'android' | 'ios' | 'packages';

const state = {
  tab: 'packages' as Tab,
  iosSupported: false,
  adb: undefined as AdbStatus | undefined,
  devices: [] as Device[],
  serial: '',
  packages: [] as AppPackage[],
  iosApps: [] as IosApp[],
  imported: [] as MobilePackage[],
  filter: '',
  busy: false,
  activity: '',
  runtime: { nativeIpa: false, managedAndroid: false, avds: [] } as RuntimeStatus,
  settings: undefined as Settings | undefined,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = new Player();
const controlsEditor = new ControlsEditor();

async function init(): Promise<void> {
  document.body.append(player.root);
  player.onExit = () => document.body.classList.remove('playing');

  const info = await playbridge.info();
  state.iosSupported = info.iosApps;
  document.body.dataset.platform = info.platform;
  state.settings = await playbridge.settings.get();

  $('tab-ios').hidden = !state.iosSupported;
  $('tab-packages').addEventListener('click', () => switchTab('packages'));
  $('tab-android').addEventListener('click', () => switchTab('android'));
  $('tab-ios').addEventListener('click', () => switchTab('ios'));
  $('refresh-devices').addEventListener('click', () => void refreshDevices());
  $<HTMLSelectElement>('device').addEventListener('change', (e) => {
    state.serial = (e.target as HTMLSelectElement).value;
    void refreshPackages();
  });
  $('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void connectAddress();
  });
  $<HTMLInputElement>('search').addEventListener('input', (e) => {
    state.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderMain();
  });
  $('restart-android').addEventListener('click', () => void run(async () => {
    state.settings!.androidGraphics = $<HTMLSelectElement>('set-android-graphics').value === 'software' ? 'software' : 'auto';
    await playbridge.settings.set(state.settings!);
    try { await playbridge.runtime.restartAndroid(); await refreshDevices(); }
    finally { activity(''); }
  }));
  $('open-settings').addEventListener('click', openSettings);
  $('settings-form').addEventListener('submit', (e) => void saveSettings(e));

  state.imported = await playbridge.packages.list();
  state.runtime = await playbridge.runtime.status();
  playbridge.runtime.onProgress(activity);
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (state.busy) { toast('Wait for the current installation to finish.', 'error'); return; }
    void run(async () => {
      for (const file of files) {
        try { await importAndInstall(playbridge.packages.pathForFile(file)); }
        catch (error) { toast((error as Error).message, 'error'); }
      }
      state.imported = await playbridge.packages.list(); renderMain();
    });
  });
  renderRecents();
  switchTab('packages');
  await refreshDevices();
  if (state.iosSupported) void refreshIos();
}

function switchTab(tab: Tab): void {
  state.tab = tab;
  $('tab-android').classList.toggle('active', tab === 'android');
  $('tab-ios').classList.toggle('active', tab === 'ios');
  $('tab-packages').classList.toggle('active', tab === 'packages');
  $('device-panel').hidden = tab === 'ios';
  renderMain();
}

// ---- Android ----

async function refreshDevices(): Promise<void> {
  state.adb = await playbridge.adb.status();
  $('adb-status').textContent = state.adb.ok
    ? `adb ${state.adb.version.match(/\d+\.\d+\.\d+/)?.[0] ?? 'ready'}`
    : 'adb not found';
  $('adb-status').title = state.adb.binary;
  $('adb-status').classList.toggle('bad', !state.adb.ok);
  state.devices = state.adb.ok ? await playbridge.adb.devices().catch(() => []) : [];
  const ready = state.devices.filter((d) => d.state === 'device');
  if (!ready.some((d) => d.serial === state.serial)) state.serial = ready[0]?.serial ?? '';

  const select = $<HTMLSelectElement>('device');
  select.replaceChildren(...state.devices.map((d) =>
    el('option', { value: d.serial, ...(d.state !== 'device' ? { disabled: '' } : {}) },
      `${d.model ?? d.serial}${d.state !== 'device' ? ` (${d.state})` : ''}`)));
  if (state.devices.length === 0) select.append(el('option', { value: '' }, 'No device'));
  select.value = state.serial;
  await refreshPackages();
}

async function refreshPackages(): Promise<void> {
  state.packages = [];
  if (state.serial) {
    try {
      state.packages = await playbridge.adb.packages(state.serial);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  renderMain();
}

async function connectAddress(): Promise<void> {
  const input = $<HTMLInputElement>('connect-address');
  const address = input.value.trim();
  if (!address) return;
  await run(async () => {
    toast(await playbridge.adb.connect(address));
    state.settings = await playbridge.settings.get();
    renderRecents();
    await refreshDevices();
  });
}

function renderRecents(): void {
  const recents = state.settings?.recentAddresses ?? [];
  const presets = ['127.0.0.1:5555', '127.0.0.1:7555', '127.0.0.1:16384', '127.0.0.1:62001'];
  $('recent-addresses').replaceChildren(...[...new Set([...recents, ...presets])].map((a) => el('option', { value: a })));
}

async function play(pkg: string): Promise<void> {
  await run(async () => {
    await playbridge.adb.launch(state.serial, pkg);
    await openPlayer(pkg, prettyPackage(pkg));
  });
}

async function openPlayer(appId: string, title: string): Promise<void> {
  document.body.classList.add('playing');
  await player.open(state.serial, appId, title);
}

async function install(): Promise<void> {
  await run(async () => {
    const before = new Set(state.packages.map((p) => p.id));
    if (!(await playbridge.adb.install(state.serial))) return;
    await refreshPackages();
    const added = state.packages.filter((p) => !before.has(p.id)).map((p) => prettyPackage(p.id));
    toast(added.length ? `Installed ${added.join(', ')}` : 'Install finished');
  }, 'Installing…');
}

async function uninstall(pkg: string): Promise<void> {
  if (!confirm(`Uninstall ${pkg} from the device? Its game data on the device will be removed.`)) return;
  await run(async () => {
    await playbridge.adb.uninstall(state.serial, pkg);
    await refreshPackages();
  });
}

// ---- iOS (macOS only) ----

async function refreshIos(): Promise<void> {
  state.iosApps = await playbridge.ios.list();
  if (state.tab === 'ios') renderMain();
}

// ---- rendering ----

function renderMain(): void {
  const main = $('content');
  const title = $('main-title');
  const actions = $('main-actions');
  if (state.tab === 'packages') {
    title.textContent = 'Game library';
    actions.replaceChildren(
      el('button', { class: 'btn ghost', onclick: () => void run(async () => {
        state.runtime = await playbridge.runtime.status(); state.imported = await playbridge.packages.list(); renderMain();
      }) }, 'Refresh'),
      el('button', { class: 'btn primary', onclick: () => void run(() => importAndInstall()) }, 'Install IPA / APK / XAPK'));
    main.replaceChildren(renderFiles());
    return;
  }
  if (state.tab === 'ios') {
    title.textContent = 'iPhone & iPad games';
    actions.replaceChildren(el('button', { class: 'btn ghost', onclick: () => void refreshIos() }, 'Refresh'));
    main.replaceChildren(renderIos());
    return;
  }
  title.textContent = 'Android games';
  const canAct = !!state.serial;
  actions.replaceChildren(
    el('button', { class: 'btn ghost', onclick: () => void refreshPackages(), ...(canAct ? {} : { disabled: '' }) }, 'Refresh'),
    el('button', { class: 'btn', onclick: () => void openPlayer('_device', 'Device screen'), ...(canAct ? {} : { disabled: '' }) }, 'Mirror screen'),
    el('button', { class: 'btn primary', onclick: () => void install(), ...(canAct ? {} : { disabled: '' }) }, 'Install APK'));
  main.replaceChildren(renderAndroid());
}

function activity(text: string): void {
  state.activity = text;
  const banner = $('install-progress'); banner.textContent = text; banner.hidden = !text;
}

async function importAndInstall(file?: string): Promise<void> {
  switchTab('packages');
  const pkg = await playbridge.packages.inspect(file);
  if (!pkg) return;
  state.imported = await playbridge.packages.list(); renderMain();
  await installGame(pkg);
}

async function setupAndroid(): Promise<boolean> {
  activity('Preparing Android runtime download…');
  try {
    const plan = await playbridge.runtime.prepareAndroid();
    const modal = $<HTMLDialogElement>('runtime-terms');
    $('runtime-download-size').textContent = `Download: ${(plan.bytes / 1024 ** 3).toFixed(2)} GiB. Setup also needs space for Android and game data. Packages: ${plan.packages.join(', ')}.`;
    $<HTMLTextAreaElement>('runtime-license').value = plan.licenses.map((l) => l.id + '\n\n' + l.text).join('\n\n────────────────\n\n');
    const accepted = $<HTMLInputElement>('runtime-accept'); accepted.checked = false;
    const confirmButton = $<HTMLButtonElement>('runtime-confirm'); confirmButton.disabled = true;
    accepted.onchange = () => { confirmButton.disabled = !accepted.checked; };
    modal.returnValue = ''; modal.showModal();
    const choice = await new Promise<boolean>((resolve) => modal.addEventListener('close', () => resolve(modal.returnValue === 'install' && accepted.checked), { once: true }));
    if (!choice) return false;
    activity('Downloading Android runtime…');
    await playbridge.runtime.installAndroid(plan.token, true);
    state.runtime = await playbridge.runtime.status();
    await refreshDevices(); renderMain();
    toast('Android runtime is ready.');
    return true;
  } finally { activity(''); }
}

async function installGame(pkg: MobilePackage): Promise<void> {
  if ((pkg.kind === 'apk' || pkg.kind === 'xapk') && !state.serial && !state.runtime.avds.length) {
    if (!await setupAndroid()) return;
  }
  activity(`Installing ${pkg.name}…`);
  try {
    const result = await playbridge.packages.install(pkg.file, state.serial || undefined);
    toast(`${result.name} installed. Opening game…`);
    await playGame(result);
  } finally {
    activity(''); state.imported = await playbridge.packages.list(); renderMain();
  }
}

async function uninstallGame(pkg: MobilePackage): Promise<void> {
  try {
    if (await playbridge.packages.uninstall(pkg.file, state.serial || undefined)) toast(`${pkg.name} uninstalled`);
  } finally {
    state.imported = await playbridge.packages.list(); renderMain();
  }
}

async function removeGame(pkg: MobilePackage): Promise<void> {
  if (await playbridge.packages.remove(pkg.file)) toast(`${pkg.name} removed from library`);
  state.imported = await playbridge.packages.list(); renderMain();
}

async function playGame(pkg: MobilePackage): Promise<void> {
  const result = await playbridge.packages.play(pkg.file, state.serial || undefined);
  if (result.serial) {
    state.serial = result.serial;
    await openPlayer(result.appId, pkg.name);
  }
}

function renderAppIcon(fileOrId: string, id: string, name: string): HTMLElement {
  const wrap = el('div', { class: 'card-art' });
  const img = el('img', { class: 'icon', alt: name, hidden: '' });
  const av = avatar(id || name);
  wrap.append(av, img);

  img.addEventListener('load', () => {
    img.removeAttribute('hidden');
    av.style.display = 'none';
  });
  img.addEventListener('error', () => {
    img.setAttribute('hidden', '');
    av.style.display = '';
  });

  void playbridge.packages.icon(fileOrId)
    .then((src) => { if (src) img.src = src; })
    .catch(() => {});

  return wrap;
}

function renderFiles(): HTMLElement {
  const note = el('div', { class: 'note' },
    el('p', {}, 'Drop IPA / APK / XAPK files to install and play. Your game library is saved automatically.'),
    el('p', {}, state.runtime.nativeIpa
      ? 'iOS: built-in installer ready. Unencrypted arm64 IPA files are converted and signed here. In game, press ⌘K to edit controls.'
      : 'iOS: local IPA playback requires an Apple Silicon Mac with iOSSupport frameworks. Windows does not have a local iOS runtime.'),
    el('p', {}, `Android: ${state.runtime.managedAndroid ? 'built-in Android device ready' : state.serial ? 'connected device ready' : state.runtime.avds.length ? 'existing virtual device available' : 'first installation downloads Android and creates a device automatically'}.`),
    ...(!state.runtime.managedAndroid ? [el('button', { class: 'btn', onclick: () => void run(() => setupAndroid()) }, 'Set up built-in Android')] : []));
  const list = state.imported.filter((p) => `${p.name} ${p.bundleId ?? ''}`.toLowerCase().includes(state.filter));
  if (!list.length) return el('div', {}, note, empty('Drop IPA / APK / XAPK to install', 'Or click Install IPA / APK / XAPK above.'));

  return el('div', {}, note, el('div', { class: 'grid' }, ...list.map((pkg) => {
    const supported = (pkg.kind === 'apk' || pkg.kind === 'xapk' || state.runtime.nativeIpa) && !pkg.missing;
    const installed = pkg.status === 'installed';
    const removeBtn = el('button', {
      class: 'btn ghost btn-icon danger',
      title: 'Remove from library',
      onclick: () => void run(() => removeGame(pkg))
    }, svgIcon('remove'));
    const art = renderAppIcon(pkg.file, pkg.bundleId ?? pkg.name, pkg.name);

    const badges = el('div', { class: 'card-badges' },
      el('span', { class: `badge badge-${pkg.kind}` }, pkg.kind.toUpperCase()),
      el('span', { class: `badge-status ${installed ? 'status-installed' : pkg.status === 'error' || pkg.missing ? 'status-error' : 'status-ready'}` },
        el('span', { class: 'status-dot' }),
        installed ? 'Installed' : pkg.missing ? 'Missing' : pkg.status === 'error' ? 'Error' : 'Ready'
      )
    );

    const metaInfo = el('div', { class: 'card-meta', title: [pkg.bundleId, pkg.file].filter(Boolean).join('\n') },
      el('span', { class: 'meta-size' }, formatSize(pkg.size)),
      pkg.version ? el('span', { class: 'meta-version' }, `v${pkg.version}`) : ''
    );

    const statusDesc = el('div', { class: 'card-status-desc' },
      pkg.missing && !installed
        ? el('span', { class: 'text-error', title: pkg.file }, 'File not found. Remove it or add the file again.')
        : pkg.kind === 'ipa' && !state.runtime.nativeIpa
        ? el('span', { class: 'muted' }, document.body.dataset.platform === 'win32' ? 'iOS games cannot run on Windows' : 'Needs an Apple Silicon Mac')
        : pkg.status === 'error'
        ? el('span', { class: 'text-error' }, pkg.error ?? 'Installation failed')
        : el('span', { class: 'muted' }, pkg.bundleId ?? (installed ? 'Installed' : 'Ready to install'))
    );

    let actionsEl: HTMLElement;
    if (installed) {
      const playBtn = el('button', {
        class: 'btn primary btn-play',
        ...(!supported ? { disabled: '' } : {}),
        onclick: () => void run(() => playGame(pkg))
      }, svgIcon('play'), el('span', {}, 'Play'));

      const controlsBtn = pkg.bundleId ? el('button', {
        class: 'btn ghost btn-controls',
        title: pkg.kind === 'ipa' ? 'Controls editor (or press ⌘K in game)' : 'Edit keymap controls',
        onclick: () => void controlsEditor.open(pkg.bundleId!, pkg.name)
      }, svgIcon('gamepad'), el('span', {}, 'Controls')) : null;

      const mainRow = el('div', { class: 'card-actions-row' },
        playBtn,
        ...(controlsBtn ? [controlsBtn] : [])
      );

      const tools: HTMLElement[] = [];
      if (pkg.kind !== 'ipa') {
        tools.push(el('button', {
          class: 'btn ghost btn-icon',
          title: 'Android diagnostics & crash logs',
          onclick: () => void run(async () => {
            if (!state.serial) throw new Error('Start or connect the Android device first.');
            toast('Saved Android diagnostics: ' + await playbridge.adb.diagnostics(state.serial, pkg.bundleId!));
          })
        }, svgIcon('diagnostics')));
      }

      tools.push(el('button', {
        class: 'btn ghost btn-icon',
        title: 'Reinstall game',
        onclick: () => void run(() => installGame(pkg))
      }, svgIcon('refresh')));

      tools.push(el('button', {
        class: 'btn ghost btn-icon danger',
        title: 'Uninstall game',
        onclick: () => void run(() => uninstallGame(pkg))
      }, svgIcon('trash')));

      const hintEl = pkg.kind === 'ipa'
        ? el('span', { class: 'card-hint' }, el('kbd', {}, '⌘K'), ' in-game')
        : el('span', { class: 'muted text-xs' }, 'Ready to play');

      const subRow = el('div', { class: 'card-actions-sub' },
        hintEl,
        el('div', { class: 'card-actions-tools' }, ...tools)
      );

      actionsEl = el('div', { class: 'card-actions' }, mainRow, subRow);
    } else if (pkg.status === 'pending') {
      actionsEl = el('div', { class: 'card-actions' },
        el('div', { class: 'card-actions-row' },
          el('button', {
            class: 'btn primary btn-play btn-full',
            ...(!supported ? { disabled: '' } : {}),
            onclick: () => void run(() => installGame(pkg))
          }, svgIcon('refresh'), el('span', {}, 'Retry installation')),
          removeBtn
        )
      );
    } else {
      actionsEl = el('div', { class: 'card-actions' },
        el('div', { class: 'card-actions-row' },
          el('button', {
            class: 'btn primary btn-play btn-full',
            ...(!supported ? { disabled: '' } : {}),
            onclick: () => void run(() => installGame(pkg))
          }, svgIcon('download'), el('span', {}, 'Install & Play')),
          removeBtn
        )
      );
    }

    return el('article', { class: `card ${installed ? 'is-installed' : ''}` },
      el('div', { class: 'card-top' }, art, badges),
      el('div', { class: 'card-text' },
        el('h3', { title: pkg.name }, pkg.name),
        metaInfo,
        statusDesc
      ),
      actionsEl
    );
  })));
}

function renderAndroid(): HTMLElement {
  if (state.adb && !state.adb.ok) {
    return empty('adb is not installed',
      'Set up the built-in Android device to download the runtime and platform tools automatically.',
      el('button', { class: 'btn primary', onclick: () => void run(() => setupAndroid()) }, 'Set up built-in Android'));
  }
  const unauthorized = state.devices.find((d) => d.state === 'unauthorized');
  if (!state.serial) {
    return empty(unauthorized ? 'Allow USB debugging' : 'No Android device',
      unauthorized
        ? 'Accept the "Allow USB debugging?" prompt on the device, then refresh.'
        : 'Drop an APK or XAPK in Game library to set up Android and start playing, or connect an existing emulator or phone.',
      el('button', { class: 'btn primary', onclick: () => void refreshDevices() }, 'Refresh'));
  }
  const list = state.packages.filter((p) => !state.filter || p.id.toLowerCase().includes(state.filter)
    || prettyPackage(p.id).toLowerCase().includes(state.filter));
  if (list.length === 0) {
    return empty(state.filter ? 'No matches' : 'No apps installed yet',
      state.filter ? 'Try a different search.' : 'Install an APK to get started.');
  }
  return el('div', { class: 'grid' }, ...list.map((p) => {
    const playBtn = el('button', { class: 'btn primary btn-play', onclick: () => void play(p.id) },
      svgIcon('play'), el('span', {}, 'Play'));
    const controlsBtn = el('button', { class: 'btn ghost btn-controls', title: 'Edit keymap controls', onclick: () => void controlsEditor.open(p.id, prettyPackage(p.id)) },
      svgIcon('gamepad'), el('span', {}, 'Controls'));

    const mainRow = el('div', { class: 'card-actions-row' }, playBtn, controlsBtn);

    const subRow = el('div', { class: 'card-actions-sub' },
      el('span', { class: 'muted text-xs' }, 'Ready to play'),
      el('div', { class: 'card-actions-tools' },
        el('button', { class: 'btn ghost btn-icon', title: 'Force stop', onclick: () => void run(() => playbridge.adb.forceStop(state.serial, p.id)) }, svgIcon('stop')),
        el('button', { class: 'btn ghost btn-icon', title: 'Android diagnostics & crash log', onclick: () => void run(async () => { toast('Saved Android diagnostics: ' + await playbridge.adb.diagnostics(state.serial, p.id)); }) }, svgIcon('diagnostics')),
        el('button', { class: 'btn ghost btn-icon danger', title: 'Uninstall from device', onclick: () => void uninstall(p.id) }, svgIcon('trash'))
      )
    );

    const matched = state.imported.find((pkg) => pkg.bundleId === p.id);
    const art = renderAppIcon(matched ? matched.file : p.id, p.id, prettyPackage(p.id));

    return el('article', { class: 'card is-installed' },
      el('div', { class: 'card-top' },
        art,
        el('div', { class: 'card-badges' },
          el('span', { class: 'badge badge-apk' }, 'APK'),
          el('span', { class: 'badge-status status-installed' }, el('span', { class: 'status-dot' }), 'Installed')
        )
      ),
      el('div', { class: 'card-text' },
        el('h3', { title: prettyPackage(p.id) }, prettyPackage(p.id)),
        el('div', { class: 'card-meta', title: p.id }, el('span', { class: 'muted' }, p.id))
      ),
      el('div', { class: 'card-actions' }, mainRow, subRow)
    );
  }));
}

function renderIos(): HTMLElement {
  const list = state.iosApps.filter((a) => !state.filter || a.name.toLowerCase().includes(state.filter));
  const note = el('p', { class: 'note' },
    'iPhone and iPad apps installed from the Mac App Store run natively on Apple Silicon. ',
    'For keyboard controls use the game\'s own keyboard/controller support or macOS Touch Alternatives (in the app\'s menu bar while it runs).');
  if (list.length === 0) {
    return el('div', {}, note, empty(state.filter ? 'No matches' : 'No iPhone or iPad apps found',
      state.filter ? 'Try a different search.' : 'Install one from the Mac App Store (search, then pick the "iPhone & iPad Apps" tab).'));
  }
  return el('div', {}, note, el('div', { class: 'grid' }, ...list.map((a) => {
    const art = el('div', { class: 'card-art' });
    const icon = el('img', { class: 'icon', alt: a.name, hidden: '' });
    const av = avatar(a.bundleId);
    art.append(av, icon);
    icon.addEventListener('load', () => { icon.removeAttribute('hidden'); av.style.display = 'none'; });
    void playbridge.ios.icon(a.path).then((src) => { icon.src = src; })
      .catch(() => {});

    return el('article', { class: 'card is-installed' },
      el('div', { class: 'card-top' },
        art,
        el('div', { class: 'card-badges' },
          el('span', { class: 'badge badge-ipa' }, 'STORE'),
          el('span', { class: 'badge-status status-installed' }, el('span', { class: 'status-dot' }), 'Mac App')
        )
      ),
      el('div', { class: 'card-text' },
        el('h3', { title: a.name }, a.name),
        el('div', { class: 'card-meta', title: a.bundleId }, el('span', { class: 'muted' }, a.bundleId))
      ),
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn primary btn-play btn-full', onclick: () => void run(() => playbridge.ios.launch(a.path)) },
          svgIcon('play'), el('span', {}, 'Play')
        )
      )
    );
  })));
}

function card(name: string, sub: string, art: HTMLElement, ...buttons: HTMLElement[]): HTMLElement {
  return el('article', { class: 'card' }, art,
    el('div', { class: 'card-text' }, el('h3', { title: name }, name), el('p', { title: sub }, sub)),
    el('div', { class: 'card-actions' }, ...buttons));
}

function avatar(id: string): HTMLElement {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const node = el('div', { class: 'icon avatar' }, prettyPackage(id).slice(0, 2));
  node.style.setProperty('--hue', String(h % 360));
  return node;
}

function empty(title: string, body: string, action?: HTMLElement): HTMLElement {
  return el('div', { class: 'empty' }, el('h2', {}, title), el('p', {}, body), ...(action ? [action] : []));
}

// ---- settings ----

function openSettings(): void {
  const s = state.settings!;
  $<HTMLSelectElement>('set-avd').replaceChildren(el('option', { value: '' }, 'Automatic (one virtual device)'),
    ...state.runtime.avds.map((name) => el('option', { value: name }, name)));
  $<HTMLSelectElement>('set-android-graphics').value = s.androidGraphics ?? 'auto';
  $<HTMLSelectElement>('set-avd').value = s.androidAvd ?? '';
  $<HTMLInputElement>('set-adb').value = s.adbPath ?? '';
  $<HTMLInputElement>('set-adb').placeholder = state.adb?.binary ?? 'adb';
  $<HTMLSelectElement>('set-size').value = String(s.stream.maxSize);
  $<HTMLSelectElement>('set-fps').value = String(s.stream.maxFps);
  $<HTMLSelectElement>('set-bitrate').value = String(s.stream.bitRate);
  $<HTMLDialogElement>('settings').showModal();
}

async function saveSettings(e: Event): Promise<void> {
  if ((e as SubmitEvent).submitter?.getAttribute('value') !== 'save') return;
  const s = state.settings!;
  s.androidGraphics = $<HTMLSelectElement>('set-android-graphics').value === 'software' ? 'software' : 'auto';
  s.androidAvd = $<HTMLSelectElement>('set-avd').value || undefined;
  s.adbPath = $<HTMLInputElement>('set-adb').value.trim() || undefined;
  s.stream = {
    maxSize: Number($<HTMLSelectElement>('set-size').value),
    maxFps: Number($<HTMLSelectElement>('set-fps').value),
    bitRate: Number($<HTMLSelectElement>('set-bitrate').value),
  };
  await playbridge.settings.set(s);
  await refreshDevices();
}

async function run(fn: () => Promise<unknown>, busyLabel?: string): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('busy');
  if (busyLabel) toast(busyLabel);
  try {
    await fn();
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
  }
}

void init().catch((e) => toast((e as Error).message, 'error'));
