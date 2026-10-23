import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PlayBridgeApi } from '../shared/api';

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const listen = (channel: string) => (cb: (payload: never) => void) => {
  ipcRenderer.on(channel, (_e, payload) => cb(payload as never));
};

const api: PlayBridgeApi = {
  packages: { inspect: invoke('packages:inspect'), list: invoke('packages:list'), install: invoke('packages:install'),
    play: invoke('packages:play'), uninstall: invoke('packages:uninstall'), remove: invoke('packages:remove'), icon: invoke('packages:icon'),
    pathForFile: (file: unknown) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]) },
  runtime: { status: invoke('runtime:status'), restartAndroid: invoke('runtime:android:restart'), prepareAndroid: invoke('runtime:android:prepare'), installAndroid: invoke('runtime:android:install'), onProgress: listen('runtime:progress') },
  info: invoke('app:info'),
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  adb: {
    status: invoke('adb:status'),
    devices: invoke('adb:devices'),
    connect: invoke('adb:connect'),
    packages: invoke('adb:packages'),
    install: invoke('adb:install'),
    uninstall: invoke('adb:uninstall'),
    launch: invoke('adb:launch'),
    forceStop: invoke('adb:forceStop'),
    diagnostics: invoke('adb:diagnostics'),
  },
  ios: { list: invoke('ios:list'), launch: invoke('ios:launch'), icon: invoke('ios:icon') },
  keymap: {
    load: invoke('keymap:load'),
    save: invoke('keymap:save'),
    export: invoke('keymap:export'),
    import: invoke('keymap:import'),
  },
  stream: {
    start: invoke('stream:start'),
    stop: invoke('stream:stop'),
    touch: (...args) => ipcRenderer.send('stream:touch', ...args),
    nav: (button) => ipcRenderer.send('stream:nav', button),
    onMeta: listen('stream:meta'),
    onPacket: listen('stream:packet'),
    onLog: listen('stream:log'),
    onClosed: listen('stream:closed'),
  },
} as PlayBridgeApi;

contextBridge.exposeInMainWorld('playbridge', api);
