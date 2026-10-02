/**
 * The Settings page of server mode (docs/ux/SERVER.md SV-U2). The Models page (SV-U6) is
 * `models-page.ts`, shared with the desktop window.
 *
 * The same page as the window's Settings (`settings-page.ts`), with the server's own sections and
 * nothing of the recorder: no device, shortcut or tray. A key the registry does not have in this
 * version is left out, so a section grows as its settings land. Network settings are shown and
 * never editable here: they are the config file's. Each change saves that key alone.
 */

import type { Transport } from "./protocol.ts";
import type { ServerScreen } from "./server-common.ts";
import { type Layout, SettingsPage as PageView, WEBHOOKS } from "./settings-page.ts";

/** The server's settings, in the sections of SV-U2. */
export const SERVER_GROUPS: Layout = [
  {
    title: "Engines and presets",
    items: ["server.default_model", "server.default_language", "server.default_diarize"],
  },
  {
    title: "Models",
    items: ["server.auto_download", "server.models_max_gb", "server.models_unused_days"],
  },
  {
    title: "Jobs and retention",
    items: [
      "server.concurrency",
      "server.model_idle_minutes",
      "server.queue_max",
      "server.queue_max_per_key",
      "server.retain_days",
      "server.max_audio_minutes",
      "server.max_upload_mb",
    ],
  },
  { title: "Webhooks", items: [WEBHOOKS] },
  {
    title: "Network",
    items: [
      "api.bind",
      "api.port",
      "server.behind_proxy",
      "server.public_host",
      "server.trusted_proxies",
    ],
  },
];

export class SettingsPage implements ServerScreen {
  readonly name = "settings" as const;
  readonly title = "Settings";
  readonly root: HTMLElement;
  private readonly page: PageView;

  constructor(t: Transport) {
    this.page = new PageView(t, { server: SERVER_GROUPS });
    this.root = this.page.root;
  }

  show(): void {
    void this.page.show();
  }

  hide(): void {
    this.page.leave();
  }
}
