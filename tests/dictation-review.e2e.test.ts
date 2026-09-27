/**
 * The words fixed while dictating in the words to review (docs/ux/DICTATION.md DC-L5), through a
 * whole app with the fake engine: the dictation log's `dictation.learn` pairs on `GET /vocab`,
 * Accept and Reject there doing what the chip does, and a learned entry removed in the editor
 * giving the heard form back to the next dictation. Nothing opens a device or presses a key.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pairHistory, shouldAsk } from "../src/core/dictation/learn.ts";
import type { DictationService } from "../src/main/dictation/service.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rig(): Promise<{ r: AppRig; d: DictationService; dictate(): Promise<string> }> {
  const r = await appRig();
  cleanups.push(() => r.close());
  const t = tempDir("akou-dict-review-");
  cleanups.push(t.cleanup);
  // The fake engine hears "kubernetes" as "kubernetis" unless the vocabulary fixes it.
  const path = join(t.dir, "clip.wav");
  writeFileSync(
    path,
    monoWav(concat(silence(0.6), speak(["deploy", "to", "kubernetes"]), silence(1))),
  );
  const dictate = async () => {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)]), "clip.wav");
    const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
      method: "POST",
      headers: { authorization: `Bearer ${r.token}`, "x-akou-client": "test" },
      body: form,
    });
    const body = (await res.json()) as { text: string };
    return body.text;
  };
  const d = r.app.dictation();
  if (!d) throw new Error("the app runs no dictation");
  return { r, d, dictate };
}

/** A pair the draft box offered and the user let go, as its chip writes it. */
function ignored(d: DictationService, id: string, term: string, heard: string): void {
  d.log.append({ type: "dictation.learn", id, term, heard, status: "proposed", evidence: "none" });
  d.log.append({ type: "dictation.learn", id, term, heard, status: "ignored", evidence: "none" });
}

const vocabFile = (r: AppRig) => {
  try {
    return readFileSync(join(r.app.configDir, "vocabulary.yaml"), "utf8");
  } catch {
    return "";
  }
};

describe("DC-L5: dictation's words in the words to review", () => {
  test("an ignored pair is listed, Accept writes its entry, and removing it gives the heard form back", async () => {
    const { r, d, dictate } = await rig();
    expect(await dictate()).toBe("deploy to kubernetis");
    const id = d.log.events().find((e) => e.type === "dictation.started")?.id as string;
    ignored(d, id, "Kubernetes", "kubernetis");

    const listed = await r.api("GET", "/vocab?dictation=true");
    expect(listed.status).toBe(200);
    expect(listed.body.dictation).toMatchObject([
      { term: "Kubernetes", heard: "kubernetis", status: "ignored", evidence: "none", id },
    ]);
    // The plain list is as it was.
    expect((await r.api("GET", "/vocab")).body).not.toHaveProperty("dictation");

    const ok = await r.api("POST", "/vocab/approve", { terms: ["Kubernetes"], dictation: true });
    expect(ok.status).toBe(200);
    expect(ok.body.approved).toEqual(["Kubernetes"]);
    expect(vocabFile(r)).toContain('scope: "dictation"');
    expect((await r.api("GET", "/vocab?dictation=true")).body.dictation).toMatchObject([
      { term: "Kubernetes", status: "accepted" },
    ]);
    expect(await dictate()).toBe("deploy to Kubernetes");

    // The dictionary editor's one click: the entry goes, and the next dictation types what it hears.
    expect((await r.api("DELETE", "/vocab/Kubernetes", {})).status).toBe(200);
    expect(await dictate()).toBe("deploy to kubernetis");
  });

  test("Reject writes rejected, adds no entry, and the pair is never offered again", async () => {
    const { r, d } = await rig();
    ignored(d, "d1", "Kubernetes", "kubernetis");
    const no = await r.api("POST", "/vocab/reject", { terms: ["kubernetes"], dictation: true });
    expect(no.status).toBe(200);
    expect(no.body.rejected).toEqual(["Kubernetes"]);
    expect(vocabFile(r)).not.toContain("Kubernetes");
    expect((await r.api("GET", "/vocab?dictation=true")).body.dictation).toMatchObject([
      { term: "Kubernetes", status: "rejected" },
    ]);
    const learnt = d.log.events().filter((e) => e.type === "dictation.learn");
    expect(shouldAsk(pairHistory(learnt).get("kubernetis\u0000kubernetes"))).toBe(false);
  });

  test("Reject on a learned pair takes its entry back out", async () => {
    const { r, d, dictate } = await rig();
    ignored(d, "d1", "Kubernetes", "kubernetis");
    await r.api("POST", "/vocab/approve", { terms: ["Kubernetes"], dictation: true });
    expect(await dictate()).toBe("deploy to Kubernetes");
    await r.api("POST", "/vocab/reject", { terms: ["Kubernetes"], dictation: true });
    expect(await dictate()).toBe("deploy to kubernetis");
  });

  test("a term the file holds for calls is refused, and nothing is written", async () => {
    const { r, d } = await rig();
    await r.api("POST", "/vocab", { term: "Kubernetes", heard: ["cubenetes"] });
    ignored(d, "d1", "Kubernetes", "kubernetis");
    const refused = await r.api("POST", "/vocab/approve", {
      terms: ["Kubernetes"],
      dictation: true,
    });
    expect(refused.status).toBe(409);
    expect((await r.api("GET", "/vocab?dictation=true")).body.dictation).toMatchObject([
      { status: "ignored" },
    ]);
  });

  test("dictation takes no call or workspace", async () => {
    const { r } = await rig();
    const res = await r.api("POST", "/vocab/approve", {
      terms: ["Kubernetes"],
      dictation: true,
      workspace: "work",
    });
    expect(res.status).toBe(400);
  });

  test("akou vocab list --dictation and approve --dictation", async () => {
    const { r, d } = await rig();
    ignored(d, "d1", "Kubernetes", "kubernetis");
    const cli = rigCli(r);
    const list = await cli(["vocab", "list", "--dictation"]);
    expect(list.code).toBe(0);
    expect(list.out).toBe("Kubernetes (heard: kubernetis)  [dictation, ignored]");
    const ok = await cli(["vocab", "approve", "Kubernetes", "--dictation"]);
    expect(ok.out).toBe("Approved: Kubernetes");
    expect((await cli(["vocab", "list", "--dictation"])).out).toContain("[dictation, accepted]");
  });
});
