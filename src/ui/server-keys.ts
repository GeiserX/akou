/**
 * The Keys page of server mode (docs/ux/SERVER.md SV-U3), over the routes of SV-K7: every key with
 * its scope, callback hosts and last use; a form that creates one; and revoke. A new key and its
 * webhook secret are shown once, in a dialog that takes them off the page when it closes: nothing
 * can show them again, since akou keeps only the key's hash.
 */

import { h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { type ServerScreen, section, twoStep, when } from "./server-common.ts";

interface KeyInfo {
  id: string;
  name: string;
  scopes: string[];
  callback_hosts: string[];
  created_at: number;
  last_used_at: number | null;
}

interface CreatedKey extends Omit<KeyInfo, "last_used_at"> {
  key: string;
  secret: string;
}

export class KeysPage implements ServerScreen {
  readonly name = "keys" as const;
  readonly title = "Keys";
  readonly root: HTMLElement;
  private readonly body = h("tbody");
  private readonly armed = new Map<string, number>();
  private readonly nameInput = h("input", {
    id: "key-name",
    placeholder: "telegram-archive",
    attrs: { maxlength: "64", autocomplete: "off" },
  });
  private readonly scope = h(
    "select",
    { id: "key-scope" },
    h("option", { value: "jobs" }, "jobs: submit and read its own jobs"),
    h("option", { value: "admin" }, "admin: everything, this page included"),
  );
  private readonly hosts = h("input", {
    id: "key-hosts",
    placeholder: "telegram-viewer, archive.example",
    attrs: { autocomplete: "off" },
  });

  constructor(private readonly t: Transport) {
    const form = h(
      "form",
      { id: "key-form", attrs: { "aria-label": "New key" } },
      h("h3", {}, "New key"),
      h("label", { attrs: { for: "key-name" } }, "Name"),
      this.nameInput,
      h("label", { attrs: { for: "key-scope" } }, "Scope"),
      this.scope,
      h("label", { attrs: { for: "key-hosts" } }, "Callback hosts"),
      this.hosts,
      h(
        "small",
        { class: "hint" },
        "The hosts a job's callback URL may name, by name or address, separated by commas. A container on the same Docker network is named by its service name.",
      ),
      h("button", { id: "key-create", class: "go", type: "submit" }, "Create key"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.create();
    });
    this.root = section(
      "Keys",
      h(
        "p",
        { class: "hint" },
        "One key per program that calls akou. A jobs key sees its own jobs only; revoking a key refuses its next request.",
      ),
      h(
        "table",
        { id: "keys-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ...["Name", "Id", "Scope", "Callback hosts", "Created", "Last used", ""].map((c) =>
              h("th", {}, c),
            ),
          ),
        ),
        this.body,
      ),
      form,
    );
  }

  show(): void {
    void this.read();
  }

  hide(): void {}

  private async read(): Promise<void> {
    const r = await this.t.request<{ keys: KeyInfo[] }>("GET", "/keys");
    if (r.status !== 200) {
      toast(message(r.body, `the keys could not be read (HTTP ${r.status})`));
      return;
    }
    replace(this.body, ...r.body.keys.map((k) => this.row(k)));
  }

  private row(k: KeyInfo): HTMLElement {
    return h(
      "tr",
      { attrs: { "data-id": k.id, "data-name": k.name } },
      h("td", {}, k.name),
      h("td", {}, k.id),
      h("td", {}, k.scopes.join(", ")),
      h("td", {}, k.callback_hosts.join(", ") || "none"),
      h("td", {}, when(k.created_at)),
      h("td", {}, k.last_used_at === null ? "never" : when(k.last_used_at)),
      h(
        "td",
        {},
        twoStep(
          {
            class: "revoke",
            label: "Revoke",
            confirm: "Confirm revoke",
            id: k.id,
            armed: this.armed,
          },
          () => void this.revoke(k.id),
        ),
      ),
    );
  }

  private async revoke(id: string): Promise<void> {
    const r = await this.t.request("DELETE", `/keys/${encodeURIComponent(id)}`);
    if (r.status >= 400) toast(message(r.body, `the key could not be revoked (HTTP ${r.status})`));
    await this.read();
  }

  private async create(): Promise<void> {
    const hosts = this.hosts.value
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter((x) => x !== "");
    const r = await this.t.request<CreatedKey>("POST", "/keys", {
      name: this.nameInput.value.trim(),
      scopes: [this.scope.value],
      callback_hosts: hosts,
    });
    if (r.status !== 201) {
      toast(message(r.body, `the key could not be created (HTTP ${r.status})`));
      return;
    }
    this.nameInput.value = "";
    this.hosts.value = "";
    this.shown(r.body);
    await this.read();
  }

  /** The key and secret, once, in a dialog that removes itself (and them) when it closes. */
  private shown(k: CreatedKey): void {
    const copy = (label: string, input: HTMLInputElement) =>
      h(
        "button",
        {
          type: "button",
          on: {
            click: () => {
              input.select();
              void navigator.clipboard?.writeText(input.value).catch(() => {});
            },
          },
        },
        label,
      );
    const key = h("input", { id: "key-created-key", value: k.key, attrs: { readonly: "" } });
    const secret = h("input", {
      id: "key-created-secret",
      value: k.secret,
      attrs: { readonly: "" },
    });
    const close = h("button", { id: "key-created-close", class: "go", type: "button" }, "Done");
    const dialog = h(
      "dialog",
      { id: "key-created", attrs: { "aria-label": `Key ${k.name}` } },
      h("h2", {}, `Key ${k.name}`),
      h(
        "p",
        {},
        "Copy both now: they are shown this once. The key goes in the program's bearer token (TRANSCRIPTION_API_KEY for Telegram-Archive), the secret checks akou's webhook signatures (TRANSCRIPTION_WEBHOOK_SECRET).",
      ),
      h("label", { attrs: { for: "key-created-key" } }, "Key"),
      h("div", { class: "bar" }, key, copy("Copy key", key)),
      h("label", { attrs: { for: "key-created-secret" } }, "Webhook secret"),
      h("div", { class: "bar" }, secret, copy("Copy secret", secret)),
      h("div", { class: "bar" }, close),
    );
    const gone = () => {
      key.value = "";
      secret.value = "";
      dialog.remove();
    };
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", gone);
    document.body.append(dialog);
    dialog.showModal();
  }
}
