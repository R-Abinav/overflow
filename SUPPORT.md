# Overflow — Technical Support Doc

Companion to `instructions.md`. That file tells you what to build. This one is the deep reference — architecture, rationale for every non-obvious decision, the sandbox's actual security model (stated honestly), and prepared answers for judge Q&A. Read this before the pitch, not during it.

---

## 1. One-liner and elevator pitch

**One-liner:** Peer-to-peer sandboxed code execution for AI agents — built on Edgent.

**30-second pitch:** When an edge AI agent runs out of local compute today, it crashes, waits, or needs a pre-configured cloud account — always with a human involved. Edgent already solved the "find a peer, pay them, get an answer" problem over a P2P mesh. Overflow extends that: instead of delegating a single LLM call, the requester delegates an entire task. The peer runs it inside a sandbox where Claude writes real code, executes it, reads the real failure if it breaks, fixes it, and re-runs — autonomously, with no pre-installed shortcuts to lean on. The agent gets back a working result, not a guess.

---

## 2. What problem this actually solves

Edgent's original scope: "my agent's local model can't run, find a peer, pay them, get text back." That's inference offload — useful, but the intelligence still lives entirely in a static local model call; the peer is just extra horsepower for the same fixed operation.

Overflow's scope: "my agent has a *task*, not just a prompt, and no local machine — mine or a stranger's — can be assumed to have the exact right library pre-installed for it." The peer doesn't run a fixed model call; it runs an agent loop that writes new code per-task, hits real errors, and adapts. That's the difference between "delegate compute" and "delegate reasoning under constraint" — the second one is why this counts as agentic infrastructure rather than a load-balancer with a payment rail bolted on.

---

## 3. Architecture — full message flow

```
Requester (agent)                    AXL Mesh                    Provider (sandbox host)
──────────────────                   ─────────                   ───────────────────────
isConstrained() = true
        │
        ├── resource_request ──────────────────────────────────►│
        │                                                         │ getResources()
        │◄────────────────────────────────────── resource_ad ────┤
        │
   stakeForJob() [Base Sepolia, optional P1]
        │
        ├── task_request ──────────────────────────────────────►│
        │   { kind: 'code_exec', objective, language,            │
        │     inputData? }                                       │
        │                                                         │ runSandboxedTask()
        │                                                         │   attempt 1: Claude writes code
        │                                                         │   execFile(python3, timeout)
        │                                                         │   exit != 0 → feed real stderr back
        │                                                         │   attempt 2: Claude fixes it
        │                                                         │   exit == 0 → done
        │◄──────────────────────────────────────── task_result ──┤
        │   { success, finalOutput, finalCode,                    │
        │     attempts: [...], durationMs }                       │
        │
   print result to agent
```

Everything above the dashed line (mesh transport, resource advertisement, escrow) is Edgent, unmodified. Everything inside `runSandboxedTask()` is new.

### Component map

| Component | File | Status |
|---|---|---|
| P2P transport | `src/core/axl.ts` | Unmodified — Gensyn AXL, encrypted mesh, no HTTP between nodes |
| Constraint detection | `src/core/resources.ts` | Unmodified — RAM/CPU thresholds via `systeminformation` |
| Local fast path | `src/core/executor.ts` | Unmodified — ollama/tinyllama, used only when not constrained |
| Sandbox agent loop | `src/core/sandbox.ts` | **New** — Claude-driven write/execute/self-correct loop |
| Daemon / message router | `src/index.ts` | **Modified** — new `task_request`/`task_result` schema, ZK/payment blocks removed |
| Escrow | `src/core/escrow.ts` | Unmodified, P1-optional — Base Sepolia USDC stake/release |
| Identity | `src/core/ens.ts` | Unmodified, P1-optional |
| Removed for this build | `src/core/integrity.ts` (ZK), `src/core/payment.ts` (KeeperHub) | Not called, files left in place for disclosure |

---

## 4. Why each non-obvious decision was made

**Why cut ZK proofs and KeeperHub payment?**
The ZK circuit proves "the peer possesses the output and controls the payout wallet" — an anti-fraud proof for a fixed-format text output. It says nothing about whether the code that ran was *correct*. Once the deliverable is arbitrary code execution instead of a single text blob, that specific proof stops being the interesting property to prove, and re-purposing it under a 5-hour clock was higher risk than value. We disclose this as a deliberate scope cut, not a missing feature we ran out of time for.

**Why is the sandbox's Python environment stdlib-only, with nothing installed via pip?**
This is the load-bearing decision for demo integrity. If common libraries were pre-installed, a "self-correcting agent" demo is one bug-fix away from looking staged — you can't tell if attempt 2 succeeded because Claude reasoned about a real error or because you rigged the first attempt to fail. With no third-party packages available, any objective that naturally invites `pandas`/`numpy`/`requests` produces a *real* `ModuleNotFoundError`, and the self-correction on attempt 2 is Claude genuinely reasoning about genuine stderr. It also mirrors a true constraint: a resource-constrained edge peer plausibly doesn't have your project's exact dependency stack pre-installed either.

**Why Claude specifically, not a local model on the provider?**
Two separate concerns are being delegated at once — compute (the sandbox has spare CPU/RAM) and reasoning quality (writing correct code from an ambiguous instruction, then debugging it, needs a strong model). Running tinyllama in the sandbox would demo the compute-delegation part fine but produce unreliable code, which undermines the actual claim being made. Claude is the part of this that can't be faked by a smaller model, which is also exactly what "AI Depth & Nativeness" as a judging criterion is asking for: does the product's central capability *depend* on the model, or could you swap it for something dumber and mostly still work? Here, no — a dumber model breaks the self-correction loop, because it can't reliably read a stack trace and produce a valid fix.

**Why Docker, and why build AXL from source inside the image instead of shipping the binary?**
The committed `axl-bin/node` from the original repo is a macOS ARM64 build (a local artifact from development), which won't execute inside a Linux container regardless of the host machine's own architecture. AXL's own install path already builds from `gensyn-ai/axl` source via `go build`, so the Dockerfile does the same thing rather than fighting cross-compilation. Two containers (`overflow-requester`, `overflow-provider`) on one Compose network is also just an honest, low-risk way to demonstrate "these are two separate machines" without needing two physical devices to be present and networked correctly in the room.

**Why local-first, then Docker last, in the build order?**
Iterating on `sandbox.ts` correctness inside Docker means a rebuild per change. Iterating with `tsx` directly against two local processes is seconds, not minutes. Docker is added only once the logic is proven, specifically so that if containerization has last-mile issues under time pressure, there is already a fully working non-Docker demo to fall back to — two terminals, real network calls between two processes, real self-correction. That is not a degraded demo; it's the same system, presented locally instead of containerized.

---

## 5. The sandbox's actual security model — say this accurately if asked

Be precise here rather than oversold; judges who know infrastructure will probe this, and overclaiming is worse than a modest, accurate answer.

**What it is:** each execution attempt runs in a fresh temp directory, as a separate OS subprocess (`child_process.execFile`, not `exec` — avoids shell interpretation of generated code), with a wall-clock timeout, and the *container* it runs inside has Docker-level `--memory`/`--cpus` limits as the outer resource boundary. No pip packages are installed, so there is no ambient dependency surface to exploit and no ambient way to "just import the answer."

**What it is not:** this is not a hardened, adversarial-input security sandbox — it does not use gVisor, Firecracker, seccomp profiles, or a syscall allowlist. It is a resource- and time-bounded execution boundary appropriate for a compute-delegation demo among cooperating peers, not a boundary you'd put in front of untrusted, actively adversarial code in production. If asked "would you run a stranger's arbitrary code like this in prod," the honest answer is: this is the trust/isolation model for the hackathon build; a production version would sit each execution in a proper micro-VM or gVisor-style boundary, and the escrow/payment layer (already partially built) is exactly the mechanism that would let you price and insure against a bad peer, rather than trying to eliminate the risk entirely through pure isolation.

---

## 6. Tech stack

| Layer | Technology |
|---|---|
| Daemon | TypeScript, Node.js, `tsx` |
| P2P mesh | Gensyn AXL (Go, built from source) |
| Sandbox agent | Anthropic Messages API (`@anthropic-ai/sdk`), Claude |
| Sandbox execution | Python 3 stdlib only, `child_process.execFile`, temp-dir isolation |
| Local fast path | ollama REST API, tinyllama |
| Escrow (P1) | Solidity `EdgentEscrow.sol`, USDC on Base Sepolia, `viem` |
| Identity (P1) | ENS via `viem`, Ethereum Sepolia |
| Containerization | Docker, Docker Compose |
| Dashboard | Static HTML served by Express |

---

## 7. Demo script with talking points

1. **Frame the gap (15s):** "Edgent already lets an agent pay a peer for compute. What it couldn't do is hand off an actual task and get back something *correct* — it could only forward a prompt to a bigger model. Overflow closes that gap."
2. **Trigger delegation (live):** run an objective — live-typed or judge-supplied — via `--objective=`. Point out this is arbitrary input, not a demo string in the code.
3. **Narrate the mesh (watch terminals):** resource_request → resource_ad → task_request, over the encrypted AXL mesh, between two containers.
4. **The actual moment:** show attempt 1's real stderr (e.g. `ModuleNotFoundError: No module named 'pandas'`), then attempt 2 succeeding with a stdlib rewrite. Say explicitly: "nothing is installed to make that first attempt fail on purpose — the sandbox just doesn't have third-party packages, so this is Claude reading a real error and fixing it."
5. **Land the result:** show the final output back on the requester side, and the `attempts` array as evidence of the trace.
6. **(If P1 landed) Payment beat:** show the Basescan transaction — "and the peer actually gets paid for this, on top of just returning an answer."
7. **Close:** "This is the infrastructure layer other agent builders would sit on top of — not another chatbot wrapper, a way for any resource-constrained agent to borrow both compute *and* correct reasoning from whoever's nearby with spare capacity."

---

## 8. Anticipated judge questions and prepared answers

**"Isn't this just calling Claude on a different machine — why does that need P2P/mesh/escrow at all?"**
Because the point isn't routing a call to a bigger server — it's that the *execution environment* (CPU, RAM, a place to actually run and observe code) has to be local to wherever the task runs, and that environment is supplied by an untrusted peer with its own economic incentives, not a service you have an account with. The mesh, staking, and (optionally) proof-of-payment exist because "peer" implies no pre-existing trust relationship — that's the whole premise Edgent already established, and Overflow needs it for the same reason, now for code execution instead of inference.

**"How is this different from just running Claude Code / Code Interpreter locally?"**
Those assume you have an account, credentials, and usually a cloud connection configured in advance. The premise here is an edge agent with none of that pre-arranged, recovering autonomously at the moment it hits a constraint, by finding whichever peer happens to be reachable on the mesh right now. It's the "no human touches anything after initial wallet funding" property from Edgent, extended to code execution instead of text generation.

**"What stops a malicious peer from returning a fake success?"**
Today: nothing beyond `exitCode === 0`, honestly stated. This is the same class of problem Edgent's ZK proof partially addressed for text output (proving possession, not correctness) — for arbitrary code execution, the right analogous check is closer to "output verification" than "possession proof": e.g. a second peer, or the requester itself, re-running deterministic parts of the task, or a lighter-weight assertion the objective can specify. That's explicitly future work, not solved in this build — say so plainly if asked, rather than overclaiming the `attempts` log as a correctness guarantee.

**"Why Python and not the requester's own language/runtime?"**
Python gives the clearest, most legible failure/fix demo — errors are short, readable on a projector, and the stdlib is broad enough that "no third-party packages" still leaves genuinely solvable tasks. The protocol itself is language-agnostic (`language` is a field in the message schema); Python is the concrete choice for this build, not a hard architectural constraint.

**"What's actually novel here vs. just prompting an LLM to write and run code, which already exists elsewhere?"**
The code-writing-and-running loop by itself isn't the novel part — it's that this loop is triggered *autonomously* by a resource-constrained agent's own failure, delegated over an *untrusted, permissionless peer network*, with the beginnings of an economic settlement layer underneath it, and no human in the loop after the agent starts. Take away the P2P/constraint-triggered/economic pieces and this is Code Interpreter; keep them, and it's a decentralized execution substrate other agents could depend on — that's the "infrastructure everyone else will build on" claim, not "we made an agent that writes Python."

---

## 9. Known limitations (own these proactively, don't wait to be asked)

- Sandbox isolation is process/timeout-level, not a hardened VM boundary (see §5).
- No correctness verification of the peer's output beyond exit code — a bad-faith peer could return a plausible-looking wrong answer.
- Payment/escrow (P1) is not wired to output correctness — it would currently pay for a confident wrong answer just as readily as a right one, same limitation as above.
- Sandbox currently supports Python only; the message schema is language-agnostic but only one executor is implemented.
- Resource limits on the sandbox are the Docker container's own `--memory`/`--cpus` ceiling, not per-attempt granular limits.

---

## 10. Judging criteria — explicit mapping

| Criterion | How Overflow answers it |
|---|---|
| Problem Authenticity | Autonomous recovery from resource constraints without human/cloud pre-setup — same real gap Edgent identified, extended from "can't run inference" to "can't run the right code at all" |
| AI Depth & Nativeness | The central capability (writing correct code for an unknown task, reading a real failure, fixing it) cannot be done by a smaller/dumber model — Claude is load-bearing, not decorative |
| Solution Effectiveness | One complete pipeline (constrained → delegate → sandbox → self-correct → return), tested end-to-end across a real objective matrix, not a partial multi-feature build |
| Technical Depth & Ingenuity | Reused a working P2P/escrow protocol correctly, deliberately descoped what didn't serve the new claim (ZK/KeeperHub), and made a specific, defensible design call (stdlib-only sandbox) purely to keep the demo honest |
| Innovation & Craft | Shift from "delegate an inference call" to "delegate a task with real execution and real failure recovery" — a different capability, not a UI skin on the same one |