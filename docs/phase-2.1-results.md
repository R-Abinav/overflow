# Phase 2.1 — Full CLI/Compose Regression Results

Run against the live Docker Compose mesh (`overflow-provider` + `overflow-requester`), Gemini as the LLM, through the real `bin/overflow.js` CLI daemon post-Phase-1 unification and the Phase 1.5 code-attached architecture. All commands and raw JSON responses referenced below were captured directly from `docker exec`/`curl` output, not reconstructed from memory.

---

## Part A — code-attached path (8 objectives, normal requester flow)

Run via `docker exec overflow-requester npx tsx src/core/agent.ts --force-delegate --objective="..."` — the real, unmodified CLI flow. `agent.ts` generates candidate code locally first (Phase 1.5), so every one of these exercises the fast path: the provider tries the requester's code directly, no LLM call on the provider side, unless it fails.

| # | Objective | Success | Attempts | Source (attempt 1) | usedFallbackApproach | durationMs |
|---|---|---|---|---|---|---|
| 1 | Fibonacci (20th) | true | 1 | `requester-original` | false | 75 |
| 2 | Stats (mean/median/stdev of a list) | true | 1 | `requester-original` | false | 32 |
| 3 | CSV average (price column) | true | 1 | `requester-original` | false | 53 |
| 4 | String reverse + vowel count | true | 1 | `requester-original` | false | 24 |
| 5 | Sort list of dicts by key | true | 1 | `requester-original` | false | 26 |
| 6 | ASCII bar chart (original wording) | true | 1 | `requester-original` | false | 18 |
| 7 | "Impossible" network fetch | true | 1 | `requester-original` | false | 728 |
| 8 | Sum of squares 1–100 (new) | true | 1 | `requester-original` | false | 20 |

**Result: 8/8 pass, all via the fast path.** This is expected and correct, not a gap in coverage — it's the direct consequence of the Phase 1.5 architecture: the requester always generates code locally with the identical stdlib-only system prompt the provider would have used cold-start, so there's rarely a reason for the fast-path attempt to fail on these objectives. Objective 8 (`print(sum(i**2 for i in range(1, 101)))` → `338350`, verified correct) was added specifically to give an unambiguous "trivially correct code, fast path skips the LLM entirely" case distinct from the original 7.

---

## Part B — cold-start / objective-only path (methodology and findings)

**Method:** `agent.ts` now always generates code locally before delegating (Phase 1.5), so there is no CLI flag to force a cold-start run. To isolate the provider's from-scratch generation behavior, objectives were sent directly to the running `/delegate` endpoint (`curl -X POST http://localhost:3002/delegate`) with no `code` field — this is the same backend handler the CLI itself calls into, just without `agent.ts`'s local pre-generation step in front of it.

### Objectives 2, 3, 6 (original wording) — 3 runs each, 9 runs total

All 9 runs returned `success: true`, `attempts: 1`, `usedFallbackApproach: false`. **Self-correction never triggered.** More specifically, all 3 runs of each objective produced **byte-identical generated code** — not just the same outcome, the exact same script every time.

**Root cause:** `src/core/llm.ts`'s Gemini call is `temperature: 0`. At temperature 0 there is no sampling variance, so given the stdlib-only system prompt, Gemini deterministically never reaches for `numpy`, `pandas`, or `matplotlib` for these three objectives — not occasionally, never. The original test-matrix design (Steps 2/3/6 "tempt" a non-stdlib import) does not hold for this model/temperature combination.

### Explicit-library-naming variant — does naming the library in the objective force temptation?

Tested rewording each objective to explicitly request the tempting library by name:

- `"Using numpy, ... compute and print the mean, median, and standard deviation"` → model still wrote `import statistics` (stdlib), reasoning past the explicit request. **No self-correction.**
- `"Using pandas, parse this CSV data ..."` → model still wrote `import csv` (stdlib), with an inline comment noting pandas isn't available. **No self-correction.**
- `"Using matplotlib, generate a simple bar chart from the list [3, 7, 2, 9, 4] and print confirmation it was saved"` → model wrote `import matplotlib.pyplot as plt`, got a real `ModuleNotFoundError: No module named 'matplotlib'`, and self-corrected to a stdlib block-character bar chart on attempt 2. **Confirmed reproducible 3/3 runs**, `usedFallbackApproach: true` every time.

The difference: numpy/pandas requests have a clean, obvious stdlib substitute (`statistics`, `csv`) the model reaches for immediately regardless of what was asked. `matplotlib`'s specific request — "save a plot as an image and confirm it" — has no equally clean stdlib substitute, so the model attempts the literal import first before discovering it's unavailable and falling back.

### Objective 7 (network fetch), cold-start

Also succeeded (`success: true`, 1 attempt, real HTTP call to `worldtimeapi.org` returned a live timestamp). Same outcome and same caveat as Part A — see "Known limitation" below.

---

## Recommended demo objective for Act 4 — and the new objective 9

**Objective 9 (new):** `"Using matplotlib, generate a simple bar chart from the list [3, 7, 2, 9, 4] and print confirmation it was saved"`

This is the only objective in the matrix that reliably (3/3, reproducible) exercises genuine self-correction on Gemini: a real `ModuleNotFoundError`, followed by a real stdlib rewrite, followed by success. **Confirmed working two ways** (see item 4 below) — recommended as the standing Act 4 self-correction demo case, replacing no existing objective (original objective 6 is kept, see the standing-matrix update).

The original objectives 1–8 are fast-path/stdlib-native cases: correct, useful for proving round-trip plumbing and the fast path, but not reliable self-correction demonstrations on this model.

---

## Item 4 — is objective 9 reproducible through the normal CLI (code-attached), or only the `/delegate` bypass?

**Answer: reproducible through the real, unmodified `agent.ts --force-delegate` CLI flow — no bypass needed.** Tested 3/3 via `docker exec overflow-requester npx tsx src/core/agent.ts --force-delegate --objective="Using matplotlib, ..."`:

```
run1: attempt 1 [requester-original] exitCode=1 → attempt 2 [self-corrected] exitCode=0, usedFallbackApproach: true
run2: attempt 1 [requester-original] exitCode=1 → attempt 2 [self-corrected] exitCode=0, usedFallbackApproach: true
run3: attempt 1 [requester-original] exitCode=1 → attempt 2 [self-corrected] exitCode=0, usedFallbackApproach: true
```

One nuance for demo narration: because `agent.ts` always generates code locally first (Phase 1.5), attempt 1's `source` here is `requester-original`, not `cold-start-generated` as in the Part B bypass test. The failure and self-correction behavior is identical either way — only the provenance label differs, since both paths call the same `generateCandidateCode()` function with the same system prompt. **Act 4 can use the plain CLI command as originally scripted; the `/delegate` bypass used in Part B was a testing convenience, not a demo requirement.**

---

## Known limitation — objective 7 no longer tests graceful failure

The sandbox has **no network isolation, only dependency isolation.** The "impossible" objective (`"access the internet and fetch today's date from an external API"`) was originally designed to fail gracefully after exhausting `SANDBOX_MAX_ATTEMPTS`, proving `success: false` without a crash. In practice, the generated code successfully reaches `worldtimeapi.org` over the container's real network connection and returns a live result — so this objective currently demonstrates a **successful** network call, not a graceful failure.

This is a known limitation, not a bug to fix now — network isolation (e.g. a Docker network policy blocking egress except to specific hosts) is out of scope for P0. Flagging it here for Q&A, matching the pattern already used in the Technical Support Doc's limitations section (`SUPPORT.md` §9): if asked "does this objective still prove graceful failure," the honest answer is no, not as currently scoped — it proves the sandbox has real (if dependency-constrained) network access, which is a different but also legitimate property.
