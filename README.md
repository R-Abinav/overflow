# Overflow

**Peer-to-peer sandboxed code execution for AI agents. When your agent can't run a task locally, it finds a peer, delegates the task, and a sandboxed Claude agent writes real code, runs it, self-corrects on real failures, and returns a working result. No human. No cloud account. No coordinator.**

Built during Push to Prod (Aug 8, 2026), part of Basecamp Bengaluru. Built on Anthropic/Claude as the core reasoning layer.

## Provenance

Built on top of [Edgent](https://github.com/R-Abinav/edgent) (pre-existing work, ETHGlobal Open Agents 2026) — a P2P compute delegation daemon for edge AI agents over the Gensyn AXL mesh, with a Solidity escrow contract, ZK proof-of-output system, and KeeperHub-executed payments.

Edgent's original scope was inference offload: "my agent's local model can't run, find a peer, pay them, get text back." Overflow extends that to task delegation: the peer doesn't run a fixed model call, it runs an agent loop that writes new code per-task, hits real errors, and adapts. Edgent solved "find a peer, pay them, get an answer" over a P2P mesh; Overflow adds "get back something *correct*," not just a forwarded prompt.

Everything after commit `8ededa8` (the import commit) was built during Push to Prod. The ZK proof system and KeeperHub payment execution are Edgent's, disclosed below, and are not part of the live message flow in this build — see [Why ZK/KeeperHub were cut](#why-these-design-decisions).

---

## Quick Start

```bash
git clone https://github.com/R-Abinav/overflow.git
cd overflow
./install.sh
```

`install.sh` installs Node dependencies, builds the AXL mesh binary from source (the committed `axl-bin/node` is a macOS build and won't run elsewhere), generates the 4 AXL identity keypairs (`private-a/b/c/d.pem` — see below for why there are 4), links the `overflow` CLI globally via `npm link`, and copies `.env.example` → `.env`. Verified against a genuinely clean `node:20-bookworm-slim` container, not just a dev machine with everything already cached — see `install.sh`'s comments for the two real gaps that testing caught (Debian's `apt` Go package is too old to parse AXL's `go.mod`; a dependency now requires Node 22+).

**Prerequisites** `install.sh` checks for and won't silently work around: Node.js 22+, Go 1.23+ (only needed to build the AXL binary — `die()`s with a clear message and a download link if missing, doesn't auto-install).

**Then:**

```bash
# Edit .env — at minimum, set ANTHROPIC_API_KEY
# Terminal 1 — provider node
overflow --role=provider
# Terminal 2 — requester node
overflow --role=requester
# Terminal 3 — agent (triggers delegation)
npx tsx src/core/agent.ts --force-delegate --objective="your task here"
```

Set `FREE_RAM_THRESHOLD_MB=999999` in `.env` on the requester to reliably trigger the real `isConstrained` detection path on any hardware, or `FORCE_CONSTRAINED=true`/`false` to override the check entirely (used by the multi-agent Docker Compose topology — see `docker-compose.yml`, 3 requesters + 1 provider).

### Why 4 keypairs?

AXL routes messages by public key, so every node needs its own identity — two nodes sharing one key would be indistinguishable to a peer. `private-a.pem` backs the provider (`node-config-a.json`); `private-b/c/d.pem` back up to 3 concurrent requester identities (`node-config-b/c/d.json`), matching the 3-requester + 1-provider Docker Compose topology. For plain local two-terminal use (one provider, one requester) you only need `private-a.pem` and `private-b.pem`, but `install.sh` generates all 4 unconditionally since they're needed the moment you run `docker compose up`. These are gitignored — real key material, generated fresh per install, never committed.

### Required `.env` vars

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude is primary — the sandbox's code generation/self-correction and the RCA reference client's diagnosis/patch calls all go through this. |
| `GEMINI_API_KEY` | No | Legacy dev-time fallback only (`llm.ts` checks Anthropic first); leave unset. |
| `SANDBOX_MAX_ATTEMPTS` | No (defaults to 3) | Max code-generation/self-correction attempts per task. |
| `SANDBOX_TIMEOUT_MS` | No (defaults to 20000) | Per-attempt execution timeout for generated code. |
| `GITHUB_TOKEN` / `GITHUB_REPO` | Only for `examples/rca-agent.ts` | PAT (repo scope) and `owner/repo` for the demo repo the RCA client opens real PRs against. Not needed for the core daemon. |

See `.env.example` for the full list, including P1-only vars (escrow/ENS/KeeperHub) that are unused in the live message flow.

---

## Architecture

### Message flow

```
Requester (agent)                    AXL Mesh                    Provider (sandbox host)
──────────────────                   ─────────                   ───────────────────────
isConstrained() = true (or FORCE_CONSTRAINED=true)
        │
        ├── resource_request ──────────────────────────────────►│
        │                                                         │ getResources()
        │◄────────────────────────────────────── resource_ad ────┤
        │
   generateCandidateCode() locally (won't execute it here)
        │
        ├── task_request ──────────────────────────────────────►│
        │   { kind: 'code_exec', objective, language,            │
        │     inputData?, code?, localError? }                   │
        │                                                         │ runSandboxedTask()
        │                                                         │   attempt 1: run requester's
        │                                                         │     code directly if supplied,
        │                                                         │     else cold-start generate
        │                                                         │   execFile(python3, timeout)
        │                                                         │   exit != 0 → feed real stderr back
        │                                                         │   attempt N: self-correct
        │                                                         │   exit == 0 → done
        │◄──────────────────────────────────────── task_result ──┤
        │   { success, finalOutput, finalCode, attempts: [...],   │
        │     durationMs, usedFallbackApproach, containerName }   │
        │
   print result to agent
```

If the requester is unconstrained, it skips the mesh entirely and runs the same `generateCandidateCode()` + `runScript()` pair locally — the identical executor the provider uses, not a separate mechanism, not a mocked stub (see [Known limitations, fixed](#known-limitations-and-fixes-found-during-this-build) for why that distinction mattered).

### Component map

| Component | File | Status |
|---|---|---|
| P2P transport | `src/core/axl.ts` | Unmodified — Gensyn AXL, encrypted mesh, no HTTP between nodes |
| Constraint detection | `src/core/resources.ts` | Modified — added `FORCE_CONSTRAINED` override for deterministic demo/topology behavior |
| LLM client | `src/core/llm.ts` | Claude (Anthropic Messages API) primary, Gemini fallback |
| Sandbox agent loop | `src/core/sandbox.ts` | Core write/execute/self-correct loop; runs requester-supplied code first if present, generates cold-start otherwise |
| Requester delegation flow | `src/core/agent.ts` | `runDelegationFlow()` — constraint check → local generation+execution or delegate; CLI wrapper on top |
| Daemon / message router | `src/index.ts` | AXL message loop, `/delegate` `/status` `/jobs` `/dashboard` HTTP endpoints |
| Unified CLI | `bin/overflow.js` | `overflow --role=provider\|requester`, thin wrapper around `src/index.ts` |
| RCA reference client | `examples/rca-agent.ts` | Standalone client of the generic delegation pipeline — log → diagnosis → patch → real GitHub PR |
| GitHub integration | `examples/github.ts` | Raw REST API client (branch/commit/PR), no SDK dependency |
| Escrow | `src/core/escrow.ts` | Unmodified, P1-optional — Base Sepolia USDC stake/release, not wired into the live message flow |
| Identity | `src/core/ens.ts` | Unmodified, P1-optional |
| Removed from live flow | `src/core/integrity.ts` (ZK), `src/core/payment.ts` (KeeperHub) | Not called; files left in place for disclosure |
| Dead/legacy | `src/core/executor.ts` | Never actually called Ollama — was a mocked stub; the unconstrained path no longer uses it at all (see fixes below) |

---

## Why these design decisions

**Why cut ZK proofs and KeeperHub payment?**
The ZK circuit proves "the peer possesses the output and controls the payout wallet" — an anti-fraud proof for a fixed-format text output. It says nothing about whether the code that ran was *correct*. Once the deliverable is arbitrary code execution instead of a single text blob, that specific proof stops being the interesting property to prove. Disclosed as a deliberate scope cut, not a missing feature.

**Why is the sandbox's Python environment stdlib-only, with nothing installed via pip?**
Load-bearing for demo integrity. If common libraries were pre-installed, a "self-correcting agent" demo is one bug-fix away from looking staged. With no third-party packages available, any objective that naturally invites `pandas`/`numpy`/`matplotlib` produces a *real* `ModuleNotFoundError`, and self-correction is the model genuinely reasoning about genuine stderr.

**Why Claude specifically, not a local model on the provider?**
Two separate concerns are being delegated at once — compute (the sandbox has spare CPU/RAM) and reasoning quality (writing correct code from an ambiguous instruction, then debugging it). A dumber model breaks the self-correction loop because it can't reliably read a stack trace and produce a valid fix. This is also exactly what "AI Depth & Nativeness" as a judging criterion asks: does the product's central capability *depend* on the model, or could you swap it for something dumber and mostly still work? Here, no.

**Why build AXL from source instead of shipping the committed binary?**
The committed `axl-bin/node` is a macOS build (a local dev artifact) and won't run in a Linux container or on most install targets. AXL's own install path already builds from `gensyn-ai/axl` source via `go build`, so the Dockerfile and `install.sh` both do the same thing rather than fighting cross-compilation. Testing `install.sh` against a genuinely clean container caught that Debian's `apt` Go package (1.19) can't even parse AXL's `go.mod` version directive — 1.23+ is required.

**Why Docker, and why 4 requester identities?**
AXL routes by public key, so identities can't be shared across containers. The 3-requester + 1-provider Compose topology (each requester with its own `FORCE_CONSTRAINED` value) demonstrates one provider serving multiple concurrent, independently-constrained peers — the actual "multi-agent" claim, not just a two-terminal demo.

---

## Security model — stated honestly

**What it is:** each execution attempt runs in a fresh temp directory, as a separate OS subprocess (`child_process.execFile`, not `exec` — avoids shell interpretation of generated code), with a wall-clock timeout, and the container it runs inside has Docker-level `--memory`/`--cpus` limits as the outer resource boundary. No pip packages are installed, so there is no ambient dependency surface to exploit.

**What it is not:** this is not a hardened, adversarial-input security sandbox — no gVisor, Firecracker, seccomp profiles, or syscall allowlist. It's a resource- and time-bounded execution boundary appropriate for a compute-delegation demo among cooperating peers, not a boundary for untrusted, actively adversarial code in production. A production version would sit each execution in a proper micro-VM or gVisor-style boundary; the escrow/payment layer (already partially built, P1) is the mechanism that would let you price and insure against a bad peer rather than trying to eliminate the risk through pure isolation alone.

**What stops a malicious peer from returning a fake success?** Today: nothing beyond `exitCode === 0`, stated plainly. This is the same class of gap Edgent's ZK proof partially addressed for text output (proving possession, not correctness). For arbitrary code execution, the more relevant check would be closer to output verification — a second peer or the requester re-running deterministic parts of the task — which is explicitly future work, not solved here.

---

## Known limitations — and fixes found during this build

Two categories: things still true today, and real bugs this build found and fixed (kept here rather than erased, since the fixes are part of the actual engineering record — see `CHANGELOG.md` for the full list with commit references).

**Still true:**
- Sandbox isolation is process/timeout-level, not a hardened VM boundary (see above).
- No correctness verification of the peer's output beyond exit code.
- Sandbox currently supports Python only; the message schema is language-agnostic but only one executor is implemented.
- The sandbox has no network isolation, only dependency isolation — an objective designed to test "graceful failure with no network access" will actually succeed if the generated code makes a real outbound call. Out of scope to fix for this build.
- Resource limits on the sandbox are the Docker container's own `--memory`/`--cpus` ceiling, not per-attempt granular limits.

**Found and fixed during this build, not left as known issues:**
- The "unconstrained requester runs locally" path was a mocked stub that never executed anything or called a real model — found while verifying the demo contrast, replaced with the same real sandbox executor the provider uses.
- LLM-written diagnosis text could cite plausible-looking but hand-written (not computed) numbers, and could get timestamp extraction wrong via a single over-rigid regex — both found via repeated real-run auditing, fixed by tightening the generation objective, verified 5/5 after the fix.
- A `/delegate` timeout could be silently treated as valid pipeline output, cascading into a real GitHub PR built from a fabricated diagnosis (`{"error":"Task timeout"}` read as if it were real analysis) — found live, fixed with an explicit output-validation guard that halts the pipeline loudly at the first untrustworthy step instead of letting it cascade, plus a timeout increase sized from measured Claude response times, not guessed.

---

## Demoing across two physical machines

The default demo topology is Docker Compose on one machine (`overflow-provider` + `overflow-requester-1/2/3`) — reliable, no networking setup required. If asked to prove this works across real, physically separate hardware:

**Why this isn't a 10-second ask by default:** AXL connects outbound to peers and needs at least one publicly reachable node to bootstrap a fresh network. Two laptops on the same venue WiFi are typically both behind NAT and can't peer with zero setup — true of almost any P2P overlay without a rendezvous point.

**The fix: Tailscale.** Installed ahead of time on two devices, it gives each a stable, always-routable IP regardless of NAT, turning "two real machines" into a peer-address swap instead of a networking project. Pre-flight checklist: install Tailscale on both devices and confirm they're in the same tailnet, note each device's `tailscale ip -4`, confirm they can ping each other, and run the actual two-device AXL handshake at least once *before* the event — a successful ping is not the same as a successful AXL handshake.

**The flip:** template `node-config-*.json`'s `Peers`/`Listen` from an `AXL_PEER_OVERRIDE` env var at container startup instead of hardcoding them, so switching from Compose service names to a real Tailscale IP is an env var change, not a file edit under time pressure.

**What not to attempt live:** installing anything on a device that isn't yours mid-pitch, debugging a NAT/firewall issue in real time, or standing up a third physical peer for the first time at the venue. If the two-machine path doesn't cooperate, the honest fallback is immediate and costs nothing: "that's currently running as two Docker containers, let me show you those talking to each other instead."

---

## Judge Q&A

**"Isn't this just calling Claude on a different machine — why does that need P2P/mesh/escrow at all?"**
The point isn't routing a call to a bigger server — the *execution environment* (CPU, RAM, a place to actually run and observe code) has to be local to wherever the task runs, and that environment is supplied by an untrusted peer with its own economic incentives, not a service you have an account with. The mesh and staking exist because "peer" implies no pre-existing trust relationship.

**"How is this different from just running Claude Code / Code Interpreter locally?"**
Those assume an account, credentials, and a cloud connection configured in advance. The premise here is an edge agent with none of that pre-arranged, recovering autonomously at the moment it hits a constraint, by finding whichever peer happens to be reachable on the mesh right now.

**"What stops a malicious peer from returning a fake success?"**
See [Security model](#security-model--stated-honestly) — nothing beyond exit code today, stated plainly rather than overclaimed.

**"Why Python and not the requester's own language/runtime?"**
Clearest, most legible failure/fix demo — errors are short and readable, and the stdlib is broad enough that "no third-party packages" still leaves genuinely solvable tasks. The protocol itself is language-agnostic (`language` is a message-schema field); Python is the concrete choice for this build, not a hard constraint.

**"What's actually novel here vs. just prompting an LLM to write and run code, which already exists elsewhere?"**
The loop itself isn't the novel part — it's that it's triggered *autonomously* by a resource-constrained agent's own failure, delegated over an *untrusted, permissionless peer network*, with the beginnings of an economic settlement layer underneath, no human in the loop after the agent starts. Take away the P2P/constraint-triggered/economic pieces and this is Code Interpreter; keep them, and it's a decentralized execution substrate other agents could depend on.

---

## Judging criteria — explicit mapping

| Criterion | How Overflow answers it |
|---|---|
| Problem Authenticity | Autonomous recovery from resource constraints without human/cloud pre-setup — extended from "can't run inference" (Edgent) to "can't run the right code at all" |
| AI Depth & Nativeness | The central capability (writing correct code for an unknown task, reading a real failure, fixing it) can't be done by a smaller/dumber model — Claude is load-bearing, not decorative |
| Solution Effectiveness | One complete pipeline (constrained → delegate → sandbox → self-correct → return), tested end-to-end across a real objective matrix on both Gemini and Claude, not a partial multi-feature build |
| Technical Depth & Ingenuity | Reused a working P2P protocol correctly, deliberately descoped what didn't serve the new claim (ZK/KeeperHub), made a specific defensible design call (stdlib-only sandbox) to keep the demo honest, and found/fixed real bugs (mocked execution, fabricated-PR cascade) via actual adversarial testing rather than assuming success |
| Innovation & Craft | Shift from "delegate an inference call" to "delegate a task with real execution and real failure recovery" — a different capability, not a UI skin on the same one |

---

## Tech stack

| Layer | Technology |
|---|---|
| Daemon | TypeScript, Node.js, `tsx` |
| P2P mesh | Gensyn AXL (Go, built from source) |
| Sandbox agent | Anthropic Messages API (`@anthropic-ai/sdk`), Claude primary; `@google/genai` Gemini fallback |
| Sandbox execution | Python 3 stdlib only, `child_process.execFile`, temp-dir isolation, stdin piping for large inputs |
| Containerization | Docker, Docker Compose (1 provider + 3 requesters) |
| RCA reference client | Diagnosis + patch generation via Claude, real GitHub PRs via raw REST API (`examples/`) |
| Dashboard | Static HTML served by Express |
| Escrow (P1, unwired) | Solidity `EdgentEscrow.sol`, USDC on Base Sepolia, `viem` |
| Identity (P1, unwired) | ENS via `viem`, Ethereum Sepolia |

---

## Repository structure

```
overflow/
├── bin/
│   └── overflow.js           # Unified CLI — overflow --role=provider|requester
├── src/
│   ├── index.ts               # Daemon entrypoint, AXL message loop, HTTP endpoints
│   ├── config/
│   │   └── env.config.ts      # Typed env loader
│   ├── core/
│   │   ├── axl.ts             # AXL process management and messaging
│   │   ├── resources.ts       # Resource monitoring, isConstrained, FORCE_CONSTRAINED
│   │   ├── llm.ts             # Claude/Gemini client
│   │   ├── sandbox.ts         # Write/execute/self-correct loop
│   │   ├── agent.ts           # runDelegationFlow() + CLI wrapper
│   │   ├── escrow.ts          # P1, unwired
│   │   ├── wallet.ts          # P1, unwired
│   │   ├── ens.ts             # P1, unwired
│   │   ├── integrity.ts       # ZK — not called, kept for disclosure
│   │   ├── payment.ts         # KeeperHub — not called, kept for disclosure
│   │   └── executor.ts        # Legacy mocked stub, unused
│   └── tests/
│       └── sandbox.manual.ts  # Standalone objective-matrix test harness
├── examples/
│   ├── rca-agent.ts           # RCA reference client — log → diagnosis → patch → PR
│   ├── github.ts              # Raw GitHub REST client
│   └── rca-demo/
│       └── auth-service.log   # Synthetic incident log fixture
├── docs/
│   └── phase-2.1-results.md   # Full regression results, Gemini objective-matrix findings
├── dashboard/
│   └── index.html
├── node-config-a/b/c/d.json   # AXL configs — provider + 3 requester identities
├── docker-compose.yml         # 1 provider + 3 requesters, FORCE_CONSTRAINED per node
├── Dockerfile
├── install.sh
├── .env.example
├── CHANGELOG.md
└── LICENSE
```

---

Built for Push to Prod: Building at the Frontier, Aug 8, 2026.
