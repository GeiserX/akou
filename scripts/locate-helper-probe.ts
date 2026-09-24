/**
 * `scripts/smoke-app.ts` bundles this into the built app's main folder and runs it with the app's
 * Bun: it prints where the app's own resolver finds the capture helper, from where the app runs.
 */

import { locateHelper } from "../src/main/capture/helper.ts";

console.log(JSON.stringify(locateHelper([])));
