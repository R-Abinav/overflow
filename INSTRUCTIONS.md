# Overflow — Push to Prod Build Spec

**Repo:** `overflow`
**Description:** Peer-to-peer sandboxed code execution for AI agents — built on Edgent
**Base project:** `edgent` (P2P compute delegation for edge agents — ETHGlobal Open Agents 2026), same author, separate repo since GitHub won't let you fork your own repo.

You currently have two local folders:
```
~/Desktop/Hacks/push_to_prod/
├── edgent/     # original project, full git history, working code
└── overflow/   # new empty repo — just LICENSE + README so far
```

---

## 0. Decisions

| Question | Decision |
|---|---|
| Model | Claude API only (Anthropic Messages API) for the sandbox agent loop |
| ollama/tinyllama | Kept as-is, only for the "not constrained" local fast path |
| ZK proof (circom/snarkjs) | Cut for demo |
| KeeperHub / x402 | Cut for demo |
| Escrow stake/release | P1 — wire back in only if P0 is done with time to spare |
| ENS names | P1 — trivial, keep if time allows |
| Docker | Two containers, `overflow-requester` / `overflow-provider` — **built last**, after logic is proven locally (see §2) |
| Sandbox language | Python, **stdlib only, no pip packages installed** — this is deliberate, see §2 Step 4 |
| Demo objective | **Never hardcoded.** Passed at runtime via CLI flag or HTTP body. See §2 Step 6 and §5. |

---

## 1. Repo consolidation — do this first, before any code changes

`overflow` already has its own initial commit (LICENSE + README), so it can't be a clean fork/remote-swap of `edgent`. Copy the code across and mark the import as a single commit — that commit boundary is your disclosure line for judges.

```bash
cd ~/Desktop/Hacks/push_to_prod/overflow

# copy source from edgent, excluding what we don't need
rsync -av --progress ../edgent/ ./ \
  --exclude .git \
  --exclude axl-bin \
  --exclude node_modules \
  --exclude circuits \
  --exclude hardhat \
  --exclude compute_proof.sym

git add -A
git commit -m "chore: import base from edgent (pre-existing work, ETHGlobal Open Agents 2026) — see github.com/R-Abinav/edgent"
git push -u origin main
```

Notes on the excludes:
- `axl-bin/` — excluded on purpose. The committed binary is a macOS build; you'll rebuild AXL from source (`gensyn-ai/axl`) both for local dev and inside Docker. See §2 Step 2.
- `circuits/` and `hardhat/` — excluded because ZK proofs and contract deployment tooling aren't part of this build. The escrow contract is already deployed on Base Sepolia; `src/core/escrow.ts` only needs the contract address in `.env`, not the `hardhat/` folder itself. If you do P1 escrow, you don't need to bring `hardhat/` back — it's only needed for redeploying, which you're not doing.

Add a short section at the top of `overflow/README.md`:
```md
## Provenance
Built on top of [Edgent](https://github.com/R-Abinav/edgent) (pre-existing work, ETHGlobal Open Agents 2026).
Everything after commit `<paste the import commit hash here>` was built during Push to Prod (Aug 8, 2026).
```

---

## 2. P0 — full instructions (read this whole section before writing anything)

**P0 is the only thing that matters for the demo.** It is exactly this: a requester agent, given an arbitrary task at runtime, detects it can't run locally, delegates it over the AXL mesh to a peer, the peer runs it in a sandbox where Claude writes and executes real code — self-correcting on real failures, not scripted ones — and the requester gets back a genuinely correct result. Nothing else is required to win. Don't touch P1/P2 until every step below is checkpointed.

### The no-hardcoding rule

The task objective is never baked into any source file. It arrives at runtime as a CLI argument (`--objective="..."`) or an HTTP body field, exactly like `--prompt=` does today. `sandbox.ts` and the message handlers must contain **zero** task-specific branches, special-cased strings, or "if objective contains X" logic. The system has to work correctly for an objective it has never seen before, decided by whoever's typing at demo time — including a judge, if you want to let them try it. This is also why the sandbox environment has no pip packages pre-installed (Step 4) — that constraint is what makes self-correction real instead of staged.

### Step 1 — Baseline check, no code changes (≈15 min)

Before changing anything, confirm the existing mesh still works exactly as it did in `edgent`, now inside `overflow`. Run both roles locally (not Docker yet — fast iteration matters more right now than demo polish):

```bash
npm install
npx tsx src/index.ts --role=provider
# separate terminal
npx tsx src/index.ts --role=requester
npx tsx src/core/agent.ts --force-delegate --prompt="test"
```

**Checkpoint:** you see `resource_request` → `resource_ad` → `task_request` → `task_result` in both terminal logs. If this doesn't work, stop and fix it before writing new code — everything else builds on this.

### Step 2 — Strip ZK / KeeperHub / x402 (≈20 min)

In `src/index.ts`, remove or comment out:
- The `zkProof` generation call and `generateZKProof`/`axlKeyToBigInts` import (from `src/core/integrity.ts`)
- The `verifyZKProof` call in the `task_result` handler
- The `payment_request` send block after `task_result` in the `task_request` handler
- The entire `payment_request` case (KeeperHub call, `notifyKeeperHub`)
- The `payment_confirmed` case can stay as a no-op or be removed — your call, it's dead code either way without KeeperHub calling it

Leave `stakeForJob` / `verifyStake` (escrow) in place — don't remove them, just don't build anything new around them yet.

**Checkpoint:** re-run Step 1's test. The mesh handshake and task delegation still work end-to-end without ZK/payment, just returning plain output. This proves you removed the right things.

### Step 3 — Build `src/core/sandbox.ts`, standalone, no AXL involved yet (≈60–90 min)

```ts
export async function runSandboxedTask(
  objective: string,
  language: 'python',
  inputData?: string
): Promise<{
  success: boolean;
  finalOutput: string;
  finalCode: string;
  attempts: Array<{ attemptNumber: number; code: string; stdout: string; stderr: string; exitCode: number }>;
  durationMs: number;
}>
```

Logic:
1. System prompt to Claude: "You are a code-execution agent running inside a sandboxed environment with Python 3 standard library only — no third-party packages are installed. Given a task, write a single self-contained Python script that accomplishes it using only the standard library, and prints its result to stdout. Respond with ONLY a python code block."
2. Call Claude (`@anthropic-ai/sdk`), extract the code block from the response.
3. Write it to a fresh temp dir (`fs.mkdtempSync`), run with `child_process.execFile('python3', [scriptPath], { timeout: SANDBOX_TIMEOUT_MS, cwd: tempDir })`.
4. Capture stdout/stderr/exitCode into the `attempts` array.
5. If `exitCode !== 0`: append the failed code + real stderr to the conversation and ask Claude to fix it. Repeat up to `SANDBOX_MAX_ATTEMPTS`.
6. Return on first success, or after exhausting attempts (`success: false`, last attempt's output).
7. Clean up the temp dir when done.

**Checkpoint — this is the part that needs real testing, not a smoke test.** Write a small script (`src/tests/sandbox.manual.ts` or similar) that calls `runSandboxedTask` directly, no AXL, against the test matrix below. Run every one of them, more than once each — you're checking for reliability, not just "it worked once."

**Test matrix (run all of these, log pass/fail and attempt count for each):**
1. `"compute the 20th Fibonacci number"` — should succeed attempt 1, no reason to fail
2. `"given the list [4, 8, 15, 16, 23, 42], return the mean, median, and standard deviation"` — stdlib `statistics` module exists, but Claude may reach for `numpy` first (not installed) → real self-correction
3. `"parse this CSV data and print the average of the 'price' column"` with `inputData` set to a small inline CSV string — tempts `pandas`, forces a stdlib `csv` fallback
4. `"reverse the string 'push to prod' and count the vowels in it"` — trivial, should pass attempt 1
5. `"sort this list of dictionaries by the 'age' key: [{'name':'a','age':30},{'name':'b','age':22}]"` — trivial but exercises structured input
6. `"generate a simple ASCII bar chart from the list [3, 7, 2, 9, 4]"` — **fast-path / stdlib-native case, no self-correction expected.** Per Phase 2.1 testing (see `docs/phase-2.1-results.md`), Gemini at `temperature: 0` writes a correct stdlib solution to this wording every time — it does not reliably tempt `matplotlib` on this model. Kept as-is for round-trip/fast-path coverage, not as a self-correction demo.
7. One deliberately impossible/ambiguous objective (e.g. `"access the internet and fetch today's date from an external API"`, with no network access available) — confirm it fails gracefully after `SANDBOX_MAX_ATTEMPTS` and returns `success: false` cleanly instead of crashing the daemon. **Known limitation (Phase 2.1):** the sandbox has no network isolation, only dependency isolation — this objective currently succeeds via a real call to `worldtimeapi.org` rather than failing gracefully. See `docs/phase-2.1-results.md` for detail; out of scope to fix for P0.
9. **(Added Phase 2.1 — the dedicated, reliable self-correction demo case.)** `"Using matplotlib, generate a simple bar chart from the list [3, 7, 2, 9, 4] and print confirmation it was saved"` — confirmed 3/3 reproducible on Gemini: real `import matplotlib.pyplot`, real `ModuleNotFoundError`, stdlib rewrite on attempt 2, `usedFallbackApproach: true`. Works both cold-start and through the normal `agent.ts --force-delegate` CLI flow — no bypass needed. This is the objective to use for Act 4 of the demo script. (Numbered 9, not 8, to match the identifier used in `docs/phase-2.1-results.md` — objective 8, "sum of squares 1–100," was a Phase 2.1 test-only addition to the code-attached matrix and isn't part of this standing list.)

**Acceptance for Step 3:** at least 5 of 7 objectives succeed reliably across repeated runs, the two "tempting" ones (2, 3, or 6) show a genuine multi-attempt trace at least sometimes, and the impossible case fails without throwing an unhandled exception. (Superseded in practice by Phase 2.1 findings — see `docs/phase-2.1-results.md` for what actually self-corrects on Gemini.)

### Step 4 — Wire `sandbox.ts` into the daemon (≈30–45 min)

- Update `task_request.task` shape to `{ kind: 'code_exec', objective, language, inputData? }` (replacing `{ model, prompt }`).
- Update `task_result.result` shape to the `sandbox.ts` return shape (§ above), replacing the old `{ output, tokensGenerated, durationMs }`.
- In `src/index.ts`'s `task_request` handler, call `runSandboxedTask(data.task.objective, data.task.language, data.task.inputData)` instead of `runInference(...)`.
- Update the `/delegate` endpoint and `src/core/agent.ts`'s force-delegate call to send `{ objective, language, inputData }` instead of `{ model, prompt, maxTokens }`. Rename the CLI flag from `--prompt=` to `--objective=`.

**Checkpoint:** repeat the Step 1 manual test, but now run the full test matrix from Step 3 **through the real AXL mesh** (two local processes), not standalone:
```bash
npx tsx src/core/agent.ts --force-delegate --objective="given the list [4, 8, 15, 16, 23, 42], return the mean, median, and standard deviation"
```
Confirm the full round trip: broadcast → resource_ad → stake → task_request → sandbox execution on the provider → task_result with `attempts` → result printed on the requester. Run at least 4 of the 7 test-matrix objectives through this real end-to-end path, not just Step 3's standalone harness — a bug in message serialization of the `attempts` array is a realistic failure mode you want to catch now, not at 4 PM.

### Step 5 — Dockerize (≈45–60 min, do this last)

Only start this once Step 4 is fully green locally. Docker is for the demo's physical-separation story and the submission's Docker requirement — it should not be where you're debugging core logic for the first time.

- `Dockerfile`: Node 18+, Python 3 (stdlib only — do not `pip install` anything into the image, that's the point), Go + git (to build AXL from source).
- Build AXL inside the image:
  ```
  RUN git clone https://github.com/gensyn-ai/axl.git axl && cd axl && go build -o ../axl-bin/node ./cmd/node
  ```
  Do not copy in the local `axl-bin/node` binary — it's a macOS build and won't run in a Linux container.
- `docker-compose.yml`: `overflow-requester` and `overflow-provider` services on a shared bridge network.
- Update `node-config-a.json` / `node-config-b.json`: `Peers` / `Listen` currently reference `127.0.0.1` — change to the Compose service names (e.g. `tls://overflow-provider:9001`).

**Checkpoint:** run the same 4+ test-matrix objectives from Step 4 again, this time via `docker compose up` and hitting the requester container's `/delegate` endpoint or exec'ing into it to run `agent.ts`. Confirm identical behavior to the local run. If something breaks here and you're low on time, **you already have a fully working non-Docker demo from Step 4** — two terminal windows, real network calls, real self-correction. That's a legitimate fallback, not a failure.

### P0 done when:
- [ ] `overflow` repo has the import commit + provenance note in README
- [ ] ZK/KeeperHub/x402 removed, mesh still works
- [ ] `sandbox.ts` passes the 7-objective test matrix standalone
- [ ] Same objectives round-trip correctly through the real AXL mesh, locally
- [ ] Same objectives round-trip correctly through Docker Compose (or you have a confirmed local fallback)
- [ ] No objective, code path, or demo string is hardcoded anywhere in `sandbox.ts` or the message handlers

---

## 3. P1 (only after every P0 checkbox is ticked)

- Re-wire `stakeForJob`/`verifyStake` around the task lifecycle, log the resulting Basescan tx.
- Surface `attempts` in `dashboard/index.html` as a live trace instead of plain text.
- ENS names in logs.
- Add the phone as a third physical peer (test this early if at all — cut immediately if it's not stable within the first attempt).

## 4. Cut without guilt (P2)
- ZK proof system, KeeperHub, x402 — already removed in P0, don't resurrect under time pressure.

---

## 5. Demo prep — no hardcoding, but still rehearsed

"No hardcoding" means the objective isn't baked into the code — it doesn't mean you show up and improvise blind. Keep a **pool of 5–6 objectives** (a text note, not code) that you've already run through the full Step 4/5 test matrix and know are reliable, including at least one that reliably produces a genuine self-correction trace because it naturally reaches for a library that isn't installed. At demo time, type one live or take one from a judge — the code has no idea which one is coming, which is the actual point.

---

## 6. Env vars

```
ANTHROPIC_API_KEY=sk-ant-...
SANDBOX_MAX_ATTEMPTS=3
SANDBOX_TIMEOUT_MS=20000
```

---

## 7. Prompt for your AI IDE agent

Paste this once the repo consolidation in §1 is done and you're working inside `overflow/`:

```
I'm building "Overflow" — a peer-to-peer sandboxed code execution protocol for AI agents, built on top of an existing project called Edgent (P2P compute delegation over the Gensyn AXL mesh, with a Solidity escrow contract). The Edgent code has already been imported into this repo as a single commit; read the existing code first: src/index.ts, src/core/axl.ts, src/core/executor.ts, src/core/agent.ts, src/core/resources.ts, src/core/escrow.ts, src/config/env.config.ts, node-config-a.json, node-config-b.json.

This is a 5-hour hackathon build. Follow the P0 section of the attached build spec exactly, in order, and do not skip the checkpoints — each step has a specific test I need you to actually run and show me the output of before moving to the next step. Specifically:

1. Confirm the baseline mesh (resource_request/resource_ad/task_request/task_result) still works locally, unmodified, before changing anything.
2. Strip the ZK proof (src/core/integrity.ts) and KeeperHub/x402 (src/core/payment.ts) calls out of src/index.ts's message handlers. Leave escrow stake/release code in place but untouched. Re-run the baseline test to confirm nothing broke.
3. Build src/core/sandbox.ts implementing runSandboxedTask(objective, language, inputData?) exactly as specified in the build spec's Step 3 — Claude writes Python using only the standard library (no pip packages installed in this environment, that's intentional), executes it via child_process.execFile with a timeout, and self-corrects on real stderr up to SANDBOX_MAX_ATTEMPTS times. Write a standalone test harness and run it against all 7 objectives in the build spec's test matrix. Show me pass/fail and attempt count for each — don't just tell me it works.
4. Update the task_request/task_result message shapes and handlers in src/index.ts, the /delegate endpoint, and agent.ts's --objective= flag (renamed from --prompt=) to use the new sandbox flow. Re-run at least 4 of the 7 test-matrix objectives through the real two-process AXL mesh locally and show me the full round-trip logs.
5. Only after step 4 is fully green: Dockerize both roles as overflow-requester/overflow-provider in docker-compose, building the AXL binary from github.com/gensyn-ai/axl source inside the image (not the committed macOS binary), and updating the node-config JSON peer addresses to the Compose service names. Re-run the same test objectives through Docker Compose.

Hard rule: no objective, task string, or demo-specific logic may be hardcoded anywhere in sandbox.ts or the message handlers — the objective is always runtime input, via CLI flag or HTTP body, exactly like the existing --prompt= flag worked. Don't touch circuits/, hardhat/, or ollama/executor.ts. Ask me before doing anything not listed above.
```