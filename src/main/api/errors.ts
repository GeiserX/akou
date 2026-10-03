/**
 * Every `error` code the API answers (docs/ux/PROGRAMMABILITY.md PG-A7). Every refusal has one
 * shape, `{error: <code>, message, ...details}`; the codes are listed here once, each route names
 * the ones it answers in its `RouteDoc.errors`, and the OpenAPI file lists both.
 *
 * A code is a contract: clients keep it (the CLI's exit codes and hints, stored failure reasons),
 * so a code is never renamed. A new refusal gets a new code here first; `tests/api-errors.test.ts`
 * fails on a code in the source that this list lacks.
 */

export const ERROR_CODES = {
  already_final: "The final pass already ran; send `force` to run it again.",
  already_recording: "A call is already recording; `already_recording` names it.",
  bad_bind: "The share's `bind` is not `tailnet`, `lan` or an IPv4 address.",
  bad_entry: "The vocabulary entry is not valid.",
  bad_expires: "The share's `expires` is not one of the accepted values.",
  bad_field: "A body field is missing its type or value; `field` names it.",
  bad_header: "A request header is not valid.",
  bad_host: "The Host header is not one akou answers on.",
  bad_json: "The body is not a JSON object.",
  bad_memo: "The memo is not valid.",
  bad_multipart: "The body is not valid `multipart/form-data`.",
  bad_param: "A query parameter is out of range or not one of its values; `param` names it.",
  bad_range: "The Range header asks for bytes outside the file.",
  bad_setting: "A setting is unknown or its value is refused; `errors` lists why.",
  bad_speaker: "Not a speaker id of the call.",
  bad_template: "The notes template is unknown or not valid.",
  bad_term: "The vocabulary term is not valid.",
  bad_workspace: "The workspace name is not valid.",
  body_too_large: "The body is over its size limit.",
  browser_request: "A request from a browser, refused by the desktop app.",
  call_word: "The term is the call's own word, not a vocabulary file's.",
  callback_not_allowed: "The callback URL's host is not on this key's callback host list.",
  cancelled: "The request or the work it waited on was stopped before it finished.",
  capture_failed: "The capture helper could not start; `stage` says where.",
  cursor_stale: "The cursor is older than what the call still holds; read again from the start.",
  decode_failed: "The audio could not be decoded.",
  diarize_unavailable:
    "The job asked for speaker labels and no `akou-diarize` helper is here; the message names the settings that fix it.",
  dictation_busy: "A dictation is already running.",
  dictation_off: "Dictation is off (`dictation.enabled`).",
  dictation_starting: "The dictation helper is still starting.",
  engine_unavailable:
    "A speech engine of the job's preset is down or could not load, so the job failed rather than come back with its text missing.",
  enhance_running: "The notes of this call are being written already.",
  export_not_configured: "No export folder: set `export.dir` or name one.",
  final_running: "The final pass of this call is running.",
  final_unavailable: "The final pass cannot run on this machine.",
  forbidden: "The key's scope does not reach this route.",
  idempotency_conflict: "The Idempotency-Key was used with another file or other options.",
  internal: "An unexpected failure inside akou.",
  interrupted: "The job was running when the server stopped.",
  json_required: "A request that changes something needs `Content-Type: application/json`.",
  key_exists: "A key with that name exists already.",
  keychain: "The system keychain refused to store a secret.",
  keys_busy: "The key store is busy; retry.",
  last_refused: "`last` is not accepted here; name the call or use `live`.",
  line_changed: "The line changed while it was being fixed.",
  locked: "Another writer holds the call's log.",
  log_closed: "The call's log is closed.",
  method_not_allowed: "The path exists, with other methods.",
  missing_field: "A required body field or part is missing; `field` names it.",
  model_download_failed: "The model the job waited on could not be downloaded.",
  model_in_use: "The model is in use or downloading.",
  models_missing: "The speech models are not downloaded yet.",
  multipart_required: "An upload needs `Content-Type: multipart/form-data`.",
  no_audio: "There is no audio to send.",
  no_calls: "There are no calls yet, so `last` names none.",
  no_draft_box: "The draft box needs the desktop window.",
  no_lan: "No private LAN address on this machine.",
  no_live_call: "Nothing is recording, so `live` names no call; `last` names the latest.",
  no_remote: "No remote dictation server is set.",
  no_tailnet: "This machine is not on a tailnet.",
  no_target: "There is no field to put the text into.",
  no_text: "The dictation has no text.",
  not_dictating: "No dictation is listening.",
  not_done: "The job has not finished; `status` says where it is.",
  not_ended: "The call is still recording.",
  not_found: "The thing named does not exist.",
  not_implemented: "Not built yet.",
  not_imported: "Nothing to import.",
  not_live: "The call is not recording.",
  not_merged: "The speaker is not merged into anyone.",
  not_paused: "The call is not paused.",
  not_ready: "akou is still starting.",
  not_recording: "The call is not recording.",
  not_restartable: "The call cannot get a new part in its state.",
  pass_running: "The vocabulary pass of this call is running.",
  permission: "The system refused the capture permission; `stage` says which.",
  preset_unavailable: "The preset or model cannot run now; the message says why.",
  provider_unavailable: "No language model provider can answer; `reason` says why.",
  queue_full: "The queue is full; retry after `retry_after_s` seconds.",
  quitting: "akou is quitting.",
  refused: "The log refused the event.",
  remote_refused: "The remote server the job was sent to refused it.",
  restart_in_progress: "A restart of this call is already running.",
  share_port: "The share could not get its port.",
  stale_restart: "The last audio is over an hour old; restart with `force`.",
  term_exists: "The vocabulary file has the term already.",
  too_long: "The audio is longer than the length limit.",
  transcription_failed: "The transcription failed.",
  unauthorized: "A valid bearer token is required.",
  unknown_field: "The body has a field the route does not take; `field` names it.",
  unknown_model: "No model of that name in the catalog.",
  unsupported_language:
    "A `languages[]` code is one no engine here can choose; `codes` names them.",
  vocab_file_invalid: "The vocabulary file could not be read.",
  workspace_not_folder: "The workspace's name is taken by something that is not a folder.",
} as const satisfies Record<string, string>;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Codes answered before any route matches, so no operation of the OpenAPI file lists them: a path
 * that exists with other methods (405), and `not_found` for a path that does not exist at all.
 */
export const UNROUTED_ERRORS: readonly ErrorCode[] = ["method_not_allowed", "not_found"];

/** The refusals of a route, by HTTP status. */
export type RouteErrors = Readonly<Partial<Record<number, readonly ErrorCode[]>>>;

/** Several sets of refusals as one, each status's codes once and sorted. */
export function errorsOf(...sets: (RouteErrors | undefined)[]): RouteErrors {
  const out = new Map<number, Set<ErrorCode>>();
  for (const s of sets) {
    for (const [status, codes] of Object.entries(s ?? {})) {
      const n = Number(status);
      const into = out.get(n) ?? new Set<ErrorCode>();
      for (const c of codes ?? []) into.add(c);
      out.set(n, into);
    }
  }
  return Object.fromEntries(
    [...out.entries()].sort(([a], [b]) => a - b).map(([s, codes]) => [s, [...codes].sort()]),
  );
}
