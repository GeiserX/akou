/**
 * The part of the ElectroBun 2.0.1 SDK akou uses, declared here so `tsc` checks the shell without
 * the Hutch devkit. ElectroBun 2 does not ship its SDK through npm: Hutch projects it into
 * `.hutch/devkit` when the app is built (`electrobun build`), and the npm `electrobun` package only
 * throws. These declarations follow the 2.0.1 API reference (BrowserWindow, BrowserView.defineRPC,
 * Electroview.defineRPC, Tray, GlobalShortcut, Utils, the `before-quit` event, ElectrobunConfig);
 * the M0 build is what proves them against the real SDK.
 */

declare module "electrobun" {
  export interface ElectrobunConfig {
    app: {
      name: string;
      identifier: string;
      version: string;
      description?: string;
      urlSchemes?: string[];
    };
    build?: {
      mainProcess?: "cottontail" | "bun" | "zig" | "rust" | "go" | "odin";
      bun?: { entrypoint: string; external?: string[]; minify?: boolean };
      views?: Record<
        string,
        { entrypoint: string; format?: "esm" | "cjs" | "iife"; minify?: boolean }
      >;
      copy?: Record<string, string>;
      buildFolder?: string;
      artifactFolder?: string;
      watch?: string[];
      mac?: {
        codesign?: boolean;
        notarize?: boolean;
        createDmg?: boolean;
        bundleCEF?: boolean;
        defaultRenderer?: "native" | "cef";
        entitlements?: Record<string, boolean | string | string[]>;
        icons?: string;
      };
      win?: { bundleCEF?: boolean; defaultRenderer?: "native" | "cef"; icon?: string };
      linux?: { bundleCEF?: boolean; defaultRenderer?: "native" | "cef"; icon?: string };
    };
    runtime?: { exitOnLastWindowClosed?: boolean; [key: string]: unknown };
    scripts?: { preBuild?: string; postBuild?: string; postWrap?: string; postPackage?: string };
    release?: { baseUrl?: string; generatePatch?: boolean };
  }
}

declare module "electrobun/main" {
  type Requests<R> = {
    [K in keyof R]: R[K] extends { params: infer P; response: infer Q }
      ? (params: P, o?: { maxRequestTime?: number }) => Promise<Q>
      : never;
  };
  type Sends<M> = { [K in keyof M]: (payload: M[K]) => void };
  type Handlers<R> = {
    [K in keyof R]: R[K] extends { params: infer P; response: infer Q }
      ? (params: P) => Q | Promise<Q>
      : never;
  };
  type Receivers<M> = { [K in keyof M]: (payload: M[K]) => void };
  export interface Schema {
    bun: { requests: object; messages: object };
    webview: { requests: object; messages: object };
  }
  /** The main process's side: it answers `bun.requests` and sends `webview.messages`. */
  export interface DefinedRpc<S extends Schema> {
    send: Sends<S["webview"]["messages"]>;
    request: Requests<S["webview"]["requests"]>;
  }
  export const BrowserView: {
    defineRPC<S extends Schema>(o: {
      maxRequestTime?: number;
      handlers: {
        requests: Handlers<S["bun"]["requests"]>;
        messages: Receivers<S["bun"]["messages"]>;
      };
    }): DefinedRpc<S>;
  };
  export class BrowserWindow {
    constructor(o: {
      title?: string;
      url?: string | null;
      frame?: { x?: number; y?: number; width: number; height: number };
      rpc?: DefinedRpc<Schema>;
      hidden?: boolean;
      titleBarStyle?: "default" | "hidden" | "hiddenInset";
    });
    readonly id: number;
    show(): void;
    focus(): void;
    close(): void;
    on(event: "close" | "will-close" | "focus" | "blur", fn: (e: unknown) => void): void;
  }
  export type TrayItem =
    | { type: "normal"; label: string; action?: string; enabled?: boolean; checked?: boolean }
    | { type: "separator" };
  export class Tray {
    constructor(o: {
      title?: string;
      image?: string;
      template?: boolean;
      width?: number;
      height?: number;
    });
    setMenu(items: TrayItem[]): void;
    setTitle(title: string): void;
    setImage(image: string): void;
    on(event: "tray-clicked", fn: (e: unknown) => void): void;
    remove(): void;
  }
  export const GlobalShortcut: {
    register(accelerator: string, fn: () => void): boolean;
    unregister(accelerator: string): void;
    unregisterAll(): void;
    isRegistered(accelerator: string): boolean;
  };
  export const Utils: {
    quit(exitCode?: number): void;
    openExternal(url: string): boolean;
    showNotification(o: { title: string; body?: string }): void;
  };
  const Electrobun: {
    events: {
      on(event: "before-quit", fn: (e: { response?: { allow: boolean } }) => void): void;
      on(event: "reopen" | "open-url", fn: (e: { data?: unknown }) => void): void;
    };
  };
  export default Electrobun;
}

declare module "electrobun/view" {
  type Requests<R> = {
    [K in keyof R]: R[K] extends { params: infer P; response: infer Q }
      ? (params: P, o?: { maxRequestTime?: number }) => Promise<Q>
      : never;
  };
  type Sends<M> = { [K in keyof M]: (payload: M[K]) => void };
  type Receivers<M> = { [K in keyof M]: (payload: M[K]) => void };
  interface Schema {
    bun: { requests: object; messages: object };
    webview: { requests: object; messages: object };
  }
  /** The page's side: it calls `bun.requests` and receives `webview.messages`. */
  export interface ViewRpc<S extends Schema> {
    request: Requests<S["bun"]["requests"]>;
    send: Sends<S["bun"]["messages"]>;
  }
  export class Electroview<S extends Schema = Schema> {
    constructor(o: { rpc: ViewRpc<S> });
    static defineRPC<S extends Schema>(o: {
      maxRequestTime?: number;
      handlers: {
        requests: Record<string, never>;
        messages: Receivers<S["webview"]["messages"]>;
      };
    }): ViewRpc<S>;
  }
}
