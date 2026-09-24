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
- [gates/M0-results.md](gates/M0-results.md): what each M0 gate measured on the reference Mac mini, with the raw outputs beside it.
- [research/asr-benchmark.md](research/asr-benchmark.md): why akou ships the fp32 Parakeet build and stays on Parakeet rather than Qwen3-ASR, with the FLEURS numbers and the method.
