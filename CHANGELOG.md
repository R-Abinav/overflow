# Changelog

All notable changes to Overflow. Built during Push to Prod (Aug 8, 2026). Entries are grouped by build phase/milestone and sourced directly from git history — see the referenced commit hashes for the actual diffs.

## [1.0.0] — Push to Prod, Aug 8, 2026

### Provenance / import

- `8ededa8` — Imported base from [Edgent](https://github.com/R-Abinav/edgent) (pre-existing work, ETHGlobal Open Agents 2026) as a single commit boundary. Everything after this commit was built during Push to Prod.

### P0 — sandbox self-correction pipeline

- `aa90648` — Added the sandbox agent loop (`sandbox.ts`): LLM writes Python, executes via `child_process.execFile`, self-corrects on real stderr. Stripped the ZK proof (`integrity.ts`) and KeeperHub/x402 (`payment.ts`) calls out of the live message flow (files kept for disclosure, not deleted). Dockerized provider/requester roles, building the AXL binary from source instead of shipping the committed macOS binary.
- `5aeb55e` — Fixed issues found in a full P0 audit (obsolete `docker-compose.yml` `version` key).
- `970d476` — Unified the daemon entrypoint into a single `overflow` CLI (`bin/overflow.js`), `--role=provider` as the default.
- `06a3fa3` — Reworked `task_request` to carry the requester's own already-generated code. The provider now tries that code directly before falling back to self-correction, instead of always re-solving the task blind. Enforced stdlib-only fixes consistently, added `usedFallbackApproach` to the result shape.

### Multi-agent topology

- `5818aa1` — Extended the Docker Compose topology to 1 provider + 3 requesters, each with an independent AXL identity (4 keypairs total) and a `FORCE_CONSTRAINED` flag for deterministic demo behavior instead of depending on real host load.

### Bug: mocked local execution

- `82e691a` — Found and fixed: the "unconstrained requester runs locally" path was a mocked stub left over from early scaffolding — it never called a real model or executed anything, returning an identical hardcoded string regardless of the objective. Replaced with the same real `generateCandidateCode()` + `runScript()` executor the provider uses. Verified with two different objectives producing two different, independently-checked-correct outputs.

### RCA reference client + GitHub PR integration

- `1cb8116` — Added a synthetic production incident log fixture (`examples/rca-demo/auth-service.log`) — credential-stuffing burst → connection pool exhaustion → OOM crash, internally consistent (pool metrics causally tied to the failure cascade, not just prose).
- `f6924a7` — Fixed a real hang: the sandbox never piped `inputData` to a script's stdin, so any generated code that called `sys.stdin.read()` on a large input blocked until the outer timeout killed it. Fixed by piping stdin properly; stdin is now always explicitly closed so a script expecting no input gets immediate EOF instead of hanging.
- `a3c92c7` — Added `examples/rca-agent.ts`, a standalone reference client that reuses the same `runDelegationFlow()` the requester CLI uses — no duplicated delegation logic. Refactored `agent.ts` to expose that function separately from its CLI wrapper.
- `5efbbcc` — Bug found and fixed: the diagnosis objective's timestamp-extraction instruction assumed fixed whitespace in a single rigid regex, breaking on real log formatting. Fixed with a generic "parse robustly" instruction; verified 5/5 correct vs. a prior 2/3 failure rate.
- `aaa7df1` — Bug found and fixed: generated diagnosis code would correctly *compute* counts into a real variable, then the summary print statement would restate a hand-written (occasionally wrong) number instead of referencing that variable — a hallucination that couldn't be caught by "did the code run without error." Fixed by requiring cited numbers to be sourced from the actual computed variable; verified 5/5 accurate vs. a prior undercounting bug.
- `9a4d157` — Added the patch-generation step: a second LLM call turns a diagnosis into a concrete unified diff.
- `2435ef0` — Pinned patch generation to always target `connection_pool.py` (the actual root-cause file), verified 5/5.
- `5bf6254` — Wired real GitHub PR creation (`examples/github.ts`, raw REST API, no SDK dependency): branch → grounded fix (LLM given the real current file content, not a blind diff) → mechanically-computed real diff → commit → PR. Verified against a seeded, genuinely-incomplete baseline `connection_pool.py` on the demo repo.

### Provider swap: Gemini → Claude

- `d61b299` — Full CLI/Compose regression results on Gemini (`docs/phase-2.1-results.md`) — established the baseline objective matrix and found `temperature: 0` determinism characteristics before the provider swap.
- `299f8ee` — Swapped the primary LLM client from Gemini to Claude (Anthropic Messages API). Found and fixed in the same change: Claude 5 can return a leading `thinking` content block before the actual `text` block — the code assumed `content[0]` was always text, which broke ~1/3 of objectives. Fixed by locating the text block by type instead of position. Re-verified the full 9-objective matrix on Claude.

### Bug: fabricated PR from a cascaded failure

- `b1034bd` — Found live: a `/delegate` timeout resolves normally with `{"error":"Task timeout"}` rather than rejecting, and nothing validated that shape before using it — a failed diagnosis was silently treated as real, cascading through patch generation into a genuine GitHub PR built from a fabricated root-cause analysis. Fixed with an explicit validation guard that halts the pipeline loudly at the first untrustworthy step (error-shaped output, missing required sections, no real timestamp cited) instead of letting it cascade. Verified the guard fires correctly and creates zero branches/PRs on both the original failure shape and a second, different malformed-diagnosis shape found during testing.
- `890bb84` — Increased the `/delegate` timeout from a hardcoded 60s to 180s, sized from real measured Claude latency (29–38s per LLM call, up to ~100s observed worst-case across self-correction attempts) rather than guessed. Also added generic objective wording recommending `sys.stdin.read()` for large inputs, fixing a reproducible Claude-specific bug (consistently mis-closing a triple-quoted string when embedding a large log literally) — verified 4/4 real end-to-end runs after the fix, via the exact live demo command.

### Docs

- `ffb6ceb` — Wrote `install.sh` and `.env.example` from scratch for the actual current setup (previous versions were stale, targeting the original Edgent project). Verified against a genuinely clean `node:20-bookworm-slim` container, not a cached dev machine — caught two real gaps: Debian's `apt` Go package can't parse AXL's `go.mod`, and a dependency now requires Node 22+. Also found and fixed a real install-blocking bug: `.env.example` hardcoded `AXL_CONFIG_PATH`, which silently broke role-based config selection for any role other than provider once copied to `.env`.
- This commit — consolidated `INSTRUCTIONS.md`, `SUPPORT.md`, and `P2P.md` into `README.md` as the single user-facing doc; added this changelog.
