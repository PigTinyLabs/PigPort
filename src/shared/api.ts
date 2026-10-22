// Shape of window.playbridge, exposed by the preload script.
import type { Keymap } from './keymap';

export interface Device { serial: string; state: string; model?: string }
export interface AppPackage { id: string }
export interface IosApp { name: string; bundleId: string; path: string }
export interface StreamMeta { deviceName: string; codec: string; width: number; height: number }
export interface StreamPacket { config: boolean; key: boolean; pts: number; data: Uint8Array }
export interface StreamOptions { maxSize: number; maxFps: number; bitRate: number }
export interface Settings { adbPath?: string; androidAvd?: string; stream: StreamOptions; recentAddresses: string[] }
export type AdbStatus = { ok: true; binary: string; version: string } | { ok: false; binary: string; error: string };
export type NavButton = 'back' | 'home' | 'recents';
export interface MobilePackage {
  kind: 'ipa' | 'apk' | 'xapk'; name: string; file: string; size: number;
  bundleId?: string; version?: string; minimumOS?: string;
  architectures: string[]; note: string;
  status?: 'imported' | 'installing' | 'pending' | 'installed' | 'error';
  error?: string; serial?: string; installedPath?: string; requestedAt?: number;
  /** Set by packages.list when the source file no longer exists. */
  missing?: boolean;
}

export interface RuntimePlan {
  token: string; bytes: number; packages: string[]; licenses: { id: string; text: string }[];
}
export interface RuntimeStatus { nativeIpa: boolean; managedAndroid: boolean; avds: string[] }
export interface PlayBridgeApi {
  packages: {
    inspect(file?: string): Promise<MobilePackage | undefined>;
    list(): Promise<MobilePackage[]>;
    install(file: string, serial?: string): Promise<MobilePackage>;
    play(file: string, serial?: string): Promise<{ serial?: string; appId: string }>;
    /** Asks whether to keep game data; undefined when the user cancels. */
    uninstall(file: string, serial?: string): Promise<MobilePackage | undefined>;
    /** Removes a game that is not installed from the library; false when the user cancels. */
    remove(file: string): Promise<boolean>;
    icon(file: string): Promise<string>;
    pathForFile(file: unknown): string;
  };
  runtime: {
    status(): Promise<RuntimeStatus>;
    prepareAndroid(): Promise<RuntimePlan>;
    installAndroid(token: string, accepted: boolean): Promise<void>;
    onProgress(cb: (message: string) => void): void;
  };
  info(): Promise<{ platform: string; iosApps: boolean; version: string }>;
  settings: { get(): Promise<Settings>; set(s: Settings): Promise<void> };
  adb: {
    status(): Promise<AdbStatus>;
    devices(): Promise<Device[]>;
    connect(address: string): Promise<string>;
    packages(serial: string): Promise<AppPackage[]>;
    install(serial: string): Promise<boolean>;
    uninstall(serial: string, pkg: string): Promise<void>;
    launch(serial: string, pkg: string): Promise<void>;
    forceStop(serial: string, pkg: string): Promise<void>;
  };
  ios: {
    list(): Promise<IosApp[]>;
    launch(path: string): Promise<void>;
    icon(path: string): Promise<string>;
  };
  keymap: {
    load(appId: string): Promise<Keymap>;
    save(appId: string, map: Keymap): Promise<void>;
    export(appId: string, map: Keymap): Promise<boolean>;
    import(): Promise<Keymap | undefined>;
  };
  stream: {
    start(serial: string): Promise<void>;
    stop(): Promise<void>;
    touch(action: number, pointerId: number, x: number, y: number, width: number, height: number): void;
    nav(button: NavButton): void;
    onMeta(cb: (m: StreamMeta) => void): void;
    onPacket(cb: (p: StreamPacket) => void): void;
    onLog(cb: (line: string) => void): void;
    onClosed(cb: (reason: string) => void): void;
  };
}
