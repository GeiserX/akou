/**
 * One Qwen decode in a process of its own, for tests that need Bun's environment set at start
 * (`BUN_CONFIG_HTTP_IDLE_TIMEOUT`, the limit Bun's `fetch` puts on a response that sends nothing).
 *
 *   bun tests/fixtures/qwen-ask.ts <server url> <timeoutMs>
 *
 * Decodes "hello world" against the server at that url and prints `{text}` or `{error}`.
 */

import { QWEN_ASR } from "../../src/main/asr/llama-catalog.ts";
import { QwenEngine } from "../../src/main/asr/qwen.ts";
import { concat, silence, speak } from "./asr-fake.ts";

const [base, timeoutMs] = [process.argv[2] as string, Number(process.argv[3])];
const engine = new QwenEngine({
  id: QWEN_ASR,
  server: { url: async () => base, restart: async () => base },
  timeoutMs,
});
const t = performance.now();
try {
  const h = await engine.decode({
    samples: concat(silence(0.3), speak(["hello", "world"]), silence(0.3)),
    lang: "auto",
    glossary: [],
  });
  console.log(JSON.stringify({ text: h.text, ms: performance.now() - t }));
} catch (err) {
  console.log(JSON.stringify({ error: (err as Error).message, ms: performance.now() - t }));
}
