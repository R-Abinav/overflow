# Overflow — P2P.md

This doc is about one thing only: **what happens if a judge asks "show me this on two actual machines," and how you answer that in under two minutes instead of live-debugging.**

P0 remains two Docker containers on one machine (`overflow-requester`, `overflow-provider`, Compose bridge network). That's what you build, test, and rely on. This doc is the rehearsed escape hatch on top of it — not a replacement for it, not something you build live under pressure.

---

## 1. Why this is a real question, not paranoia

From AXL's own docs (checked directly, not assumed):

> "No port forwarding needed — connects outbound to peers... **At least one public node is required for spinning up fresh networks.**"

Two laptops on the same venue WiFi, both behind that network's NAT, generally **cannot** peer with each other with zero setup — same reason this is true of nearly every P2P overlay without a rendezvous point. So "just run it on my laptop and my teammate's laptop" is not a 10-second ask unless the reachability problem was solved *before* you're standing at the judging table.

**The fix: Tailscale.** It gives every device in your tailnet a stable, always-routable IP regardless of NAT/firewall, with zero router config. Install it on your own two devices *before the event*, and "two real machines" becomes a peer-address swap, not a networking project.

---

## 2. The two topologies

| | P0 — single machine | Stretch — two laptops |
|---|---|---|
| Containers | `overflow-requester` + `overflow-provider`, one Compose file, one host | Each laptop runs one role, its own container |
| Peer addressing | Compose service names (`tls://overflow-provider:9001`) | Tailscale IPs (`tls://100.x.x.x:9001`) |
| Reachability | Docker's internal bridge network — always works | Tailscale overlay — needs to be pre-authenticated, tested in advance |
| Risk if it fails live | None, this is your rehearsed baseline | Falls back to P0 instantly — you already have a working demo |

You always demo P0 first. The two-laptop version is only for "can you prove it" — and if it doesn't cooperate in the moment, you say "sure — that's actually running on two Docker containers right now, here's the second one," and you've lost nothing.

---

## 3. Do this *before* the event, not on demo day

- [ ] Install Tailscale on both devices (your Mac + a teammate's laptop, or your Mac + a second machine — not a judge's device, see §5), log both into the same tailnet.
- [ ] `tailscale ip -4` on each — write down both IPs.
- [ ] Confirm each device can `ping` the other's Tailscale IP.
- [ ] Run the actual two-laptop test end-to-end (§4) **at least once, ideally twice, well before the event** — ping-only success is not the same as an AXL handshake succeeding.
- [ ] Confirm `ANTHROPIC_API_KEY` is set on whichever laptop runs `--role=provider` — that's the one actually calling Claude.

If you can't get a second physical laptop, the fallback is your Mac talking to itself over Tailscale's loopback-via-overlay — weaker as a claim, but still proves the config isn't hardcoded to `localhost`/Compose service names.

---

## 4. The flip procedure (rehearse this until it's under 2 minutes)

**One-time setup addition to the codebase** (add this to P0, it's cheap and buys you this entire section): template `node-config-a.json` / `node-config-b.json`'s `Peers`/`Listen` fields from an environment variable at container startup instead of hardcoding them, e.g. a small entrypoint step that does:

```bash
# entrypoint.sh, runs before spawning AXL
if [ -n "$AXL_PEER_OVERRIDE" ]; then
  jq --arg peer "$AXL_PEER_OVERRIDE" '.Peers = [$peer]' node-config-b.json > tmp.json && mv tmp.json node-config-b.json
fi
```

This turns "reconfigure for two laptops" into an env var, not a file edit under pressure. Ask your IDE agent to add this as a small addition inside the Docker Dockerfile/entrypoint work in P0 §5 of `instructions.md` — it's a few lines, not new scope.

**Then, at demo time, on each laptop:**

Laptop A (provider):
```bash
docker run -p 9001:9001 -p 3001:3001 \
  -e ROLE=provider \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  overflow:latest
```

Laptop B (requester), using Laptop A's Tailscale IP:
```bash
docker run -p 3002:3002 \
  -e ROLE=requester \
  -e AXL_PEER_OVERRIDE="tls://<LAPTOP_A_TAILSCALE_IP>:9001" \
  overflow:latest

# then, on Laptop B:
docker exec -it <container> npx tsx src/core/agent.ts --force-delegate --objective="<whatever they ask for>"
```

**Checkpoint before you ever do this live:** run this exact two-command sequence in your pre-event test (§3) and confirm you see `resource_request` → `resource_ad` → `task_request` → `task_result` in both containers' logs, same as the P0 checkpoints, just across real hardware this time.

---

## 5. If a judge asks to use *their own* device

Don't do this live — installing Tailscale (or anything) on someone else's laptop mid-pitch is a real way to lose two minutes to Wi-Fi/permissions/OS friction you can't debug in front of them. Better answer:

> "I don't want to install anything on your machine mid-demo, but here's exactly what that would look like" → walk them through the same commands from §4, and if you deployed a public bootstrap node (see the earlier setup discussion — a small always-on VPS), you can genuinely say: "if you clone the repo tonight and point your peer config at `<your-public-ip>:9001`, you're on the live network, no coordination with us needed." That's a stronger claim than a live install anyway — it says the network exists independent of you standing there.

---

## 6. What NOT to attempt live, even if asked
- Installing Tailscale or Docker on a device that isn't yours, mid-pitch.
- Debugging a NAT/firewall issue in real time — if the Tailscale path fails, revert to P0 immediately and say so plainly ("that's currently running as two Docker containers, let me show you those talking to each other instead") rather than troubleshooting in front of the judges.
- Standing up the phone as a third peer for the first time at the venue — if you didn't get it stable in pre-event testing (§3), it doesn't appear at demo time, full stop.