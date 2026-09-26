# Read me first

One line per document, in the order to read them.

- [README.md](../README.md): what akou is, the status, the pitch, licence and credit.
- [install.md](install.md): installing the unsigned app and the command line, the first open, the speech models, permissions, uninstalling.
- [POSITIONING.md](POSITIONING.md): who it is for, what it does, the comparison with Granola, Minutes, anarlog, Meetily and Otter, and the non-goals.
- [DESIGN.md](DESIGN.md): the architecture, covering processes, capture per OS, recognition, the event log, the query engine, agent surfaces, the window, hand-off, packaging, milestones and risks.
- [REQUIREMENTS.md](REQUIREMENTS.md): every predecessor feature and interface, and whether akou carried, changed or dropped it, plus the new vocabulary requirements.
- [TRAPS.md](TRAPS.md): failures that already happened once, each rewritten as an invariant with a named test and a milestone.
- [providers.md](providers.md): what answers questions and writes notes (your own Claude Code or Codex, an API, a local model), when each runs on its own, session reuse and how it is measured, and the open terms-of-service risk.
- [knowledge-handoff.md](knowledge-handoff.md): how a finished call leaves akou (export folder, hooks, signed webhook, pull) and how the vocabulary grows only by what you approve.
- [ROADMAP.md](ROADMAP.md): M0 gates with pass criteria, then M1 to M4 with checkable exit criteria, and what waits for demand.
- [ux/PRINCIPLES.md](ux/PRINCIPLES.md): the rules every screen, command and tool follows, the one priority scale, the ranked P0 list, rulings where the UX docs disagree, the docs that still lag, and the open decisions.
- [ux/COMPETITOR-MATRIX.md](ux/COMPETITOR-MATRIX.md): every nicety we found in competing tools, where it was seen, and which doc owns it.
- [ux/WINDOW.md](ux/WINDOW.md): the main window, its states, controls, keys, accessibility and languages.
- [ux/DESKTOP.md](ux/DESKTOP.md): the tray, hotkeys, menus, floating indicator, notifications, first run, updates, the model manager and the settings registry.
- [ux/CLI.md](ux/CLI.md): the command line: naming a call, output, exit codes, errors, help, `akou watch`, and parity with the other doors.
- [ux/PROGRAMMABILITY.md](ux/PROGRAMMABILITY.md): the API, the event stream, MCP, skills, hooks, the webhook, `akou://` and the security model.
- [ux/DICTATION.md](ux/DICTATION.md): hold a key, speak, and the text lands where the cursor is: the hotkeys, the pill, the draft box and Send, learning from what you fix, the engines and a remote akou as the engine, the helper per OS, the doors, the tests and the DC- plan.
- [api/openapi.json](api/openapi.json): the OpenAPI 3.1 file of the HTTP API, generated from the route table with `bun run openapi`; CI fails when it drifts.
- [TESTING.md](TESTING.md): which suite proves what, the fakes, the model-gated and hardware tests, and the flake policy.
- [CI-CD.md](CI-CD.md): the pipeline, branch protection, nightly jobs and releases.
- [gates/M0-results.md](gates/M0-results.md): what each M0 gate measured on the reference Mac mini, with the raw outputs beside it.
- [research/asr-benchmark.md](research/asr-benchmark.md): why akou ships the fp32 Parakeet build and stays on Parakeet rather than Qwen3-ASR, with the FLEURS numbers and the method.
- [research/asr-architecture.md](research/asr-architecture.md): how akou makes the best transcript, live and final, from any number of engines: streaming live engines, the in-call upgrade, the final pass fused by confidence ROVER, the settings, what ships per OS, and the ASR- plan, with every benchmark number behind it. It replaces the decision above to stay on Parakeet alone.
- [research/service-interface.md](research/service-interface.md): what a hosted akou exposes to Executor, services with signed callbacks, agents and OpenAI-speaking tools, all from one OpenAPI contract; why OAuth and remote MCP wait; and the SI- plan.
