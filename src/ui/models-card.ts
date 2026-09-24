/**
 * The first-run download card (docs/DESIGN.md section 3: "first run offers one explicit
 * download"). While the speech models are missing it says so, what they weigh, and offers the one
 * download (`POST /models/pull`); while they download it shows the progress from `GET /models`;
 * a failed download says why and offers to try again. Once they are there it is gone. Recording
 * is refused until then (`503 models_missing`), so this card is the first thing a new user acts on.
 */

import { byId, toast } from "./dom.ts";
import { modelsCardText } from "./models-text.ts";
import type { ModelsInfo, Reply, Transport } from "./protocol.ts";

export class ModelsCard {
  private polling: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly t: Transport) {
    byId("models-pull").addEventListener("click", () => void this.pull());
  }

  update(m: ModelsInfo | undefined): void {
    const view = modelsCardText(m);
    byId("models-card").hidden = view === null;
    if (!view) {
      this.stopPolling();
      return;
    }
    byId("models-text").textContent = view.text;
    const button = byId<HTMLButtonElement>("models-pull");
    button.hidden = view.button === null;
    button.textContent = view.button ?? "";
    const bar = byId<HTMLProgressElement>("models-progress");
    bar.hidden = view.progress === null;
    bar.value = view.progress ?? 0;
    if (m?.state === "downloading") this.startPolling();
    else this.stopPolling();
  }

  private async pull(): Promise<void> {
    let r: Reply<ModelsInfo & { message?: string }>;
    try {
      r = await this.t.request("POST", "/models/pull");
    } catch (err) {
      toast(`The download could not start: ${(err as Error).message}`);
      return;
    }
    if (r.status >= 400) {
      toast(r.body.message ?? "The download could not start");
      return;
    }
    this.update(r.body);
  }

  /** One poll a second; a tick is skipped while the last is unanswered, and a failed one is dropped. */
  private startPolling(): void {
    let inFlight = false;
    this.polling ??= setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await this.t.request<ModelsInfo>("GET", "/models");
        if (r.status === 200) this.update(r.body);
      } catch {
        // The next tick asks again; the status push also carries the models' state.
      } finally {
        inFlight = false;
      }
    }, 1000);
  }

  private stopPolling(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
  }
}
