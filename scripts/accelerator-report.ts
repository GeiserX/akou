/**
 * What akou runs its large speech model on, here (bead akou-5an.94): `asr.accelerator` from the
 * settings, the machine's GPUs, the builds this install has, and the llama-server build's own
 * device list, printed as the JSON `GET /v1/server` reports under `accelerator`, plus `gpu`.
 *
 *   bun scripts/accelerator-report.ts
 *
 * The gpu-image job of ci.yml runs it inside each GPU image with the scripts folder mounted, on a
 * runner with no GPU, so it must answer the CPU, verified by the real build. On a box with a GPU
 * the same command shows the GPU by name.
 */

import {
  type AcceleratorSetting,
  detectAccelerator,
  hostProbe,
  llamaServerBin,
  verifyAccelerator,
} from "../src/main/asr/accelerator.ts";
import { loadConfig } from "../src/main/config/schema.ts";

const { settings } = loadConfig(process.env);
const probe = hostProbe();
const first = detectAccelerator(settings["asr.accelerator"] as AcceleratorSetting, probe);
const state = await verifyAccelerator(
  first,
  llamaServerBin(probe, settings["asr.modelsDir"], first.active),
);
console.log(JSON.stringify(state, null, 2));
