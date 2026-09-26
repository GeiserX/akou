/**
 * `electrobun/view` for the UI tests (`desktop-rig.ts`): the ElectroBun pages' own entries
 * (`src/ui/window.ts`, `src/ui/indicator-window.ts`) built for a headless browser, their RPC
 * carried by two functions the rig puts on the page. Requests go to the real main-process handlers
 * through `__akouRequest`; the rig pushes messages with `__akouMessage`. Nothing else differs from
 * the packaged app: the same page code, the same handlers, the same shell.
 */

type Handlers = { requests: object; messages: Record<string, (payload: unknown) => void> };

declare global {
  interface Window {
    __akouRequest(name: string, params: unknown): Promise<unknown>;
    __akouMessage(name: string, payload: unknown): void;
  }
}

export class Electroview {
  /** What the page passed; ElectroBun wires its socket here, the shim has nothing to wire. */
  readonly rpc: unknown;

  constructor(o: { rpc: unknown }) {
    this.rpc = o.rpc;
  }

  static defineRPC(o: { maxRequestTime?: number; handlers: Handlers }) {
    window.__akouMessage = (name, payload) => o.handlers.messages[name]?.(payload);
    const request = new Proxy(
      {},
      { get: (_t, name: string) => (params: unknown) => window.__akouRequest(name, params) },
    );
    return { request, send: {} };
  }
}
