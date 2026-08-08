#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Overflow — Installer
#  Peer-to-peer sandboxed code execution for AI agents, built on Edgent.
#  Usage:  ./install.sh   (run from inside a clone of this repo)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

log()  { echo -e "${CYAN}[overflow]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✓]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
die()  { echo -e "${RED}[✗]${RESET} $*" >&2; exit 1; }

MIN_NODE=22

echo ""
echo -e "${BOLD}${CYAN}  Overflow — Installer${RESET}"
echo -e "  Peer-to-peer sandboxed code execution for AI agents"
echo ""

# ── 1. Confirm we're inside the repo ──────────────────────────────────────────
[[ -f "package.json" ]] && grep -q '"overflow": "\./bin/overflow.js"' package.json 2>/dev/null \
  || die "Run this from inside the overflow repo (package.json's bin.overflow not found)."
ok "Inside the overflow repo"

# ── 2. Check Node.js ───────────────────────────────────────────────────────────
log "Checking Node.js (need v${MIN_NODE}+)..."
command -v node &>/dev/null || die "Node.js not found. Install Node ${MIN_NODE}+ first: https://nodejs.org"
NODE_VER="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
(( NODE_VER >= MIN_NODE )) || die "Node.js v${NODE_VER} found, need v${MIN_NODE}+."
ok "Node.js $(node --version)"

# ── 3. Check Go (needed to build the AXL mesh binary from source) ────────────
# AXL's own go.mod requires a modern Go (tested: Debian's apt "golang" package,
# 1.19.8, fails to even parse it — "invalid go version ...: must match format
# 1.23"). Require 1.23+ explicitly rather than "any go", found by testing this
# installer against a genuinely clean container, not assumed.
MIN_GO_MAJOR=1
MIN_GO_MINOR=23
log "Checking Go (need v${MIN_GO_MAJOR}.${MIN_GO_MINOR}+)..."
command -v go &>/dev/null || die "Go not found. Install Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+: https://go.dev/dl (needed to build the AXL mesh binary from source — the committed axl-bin/node is a macOS build and won't run on other platforms)."
GO_VER_RAW="$(go version | awk '{print $3}' | sed 's/^go//')"
GO_MAJOR="$(echo "$GO_VER_RAW" | cut -d. -f1)"
GO_MINOR="$(echo "$GO_VER_RAW" | cut -d. -f2)"
if (( GO_MAJOR < MIN_GO_MAJOR || (GO_MAJOR == MIN_GO_MAJOR && GO_MINOR < MIN_GO_MINOR) )); then
  die "Go ${GO_VER_RAW} found, need ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ (older Go cannot parse AXL's go.mod). Install a current Go: https://go.dev/dl"
fi
ok "Go $(go version | awk '{print $3}')"

# ── 4. npm install ─────────────────────────────────────────────────────────────
log "Installing Node dependencies..."
npm install
ok "npm packages installed"

# ── 5. Build the AXL mesh binary from source ──────────────────────────────────
# axl-bin/node as committed to this repo is a macOS ARM64 build (a local dev
# artifact) — it will not run on Linux or a different architecture. Every
# environment (including this installer and the project's own Dockerfile)
# rebuilds it from the real gensyn-ai/axl source instead of trusting the
# committed binary.
log "Building AXL mesh binary from source..."
if [[ -f "axl-bin/node" ]] && ./axl-bin/node --help 2>&1 | grep -q "Usage of"; then
  ok "axl-bin/node already present and runnable on this platform — skipping rebuild"
else
  rm -rf axl-src
  git clone --depth 1 https://github.com/gensyn-ai/axl.git axl-src
  # Same normalization the project's own Dockerfile applies — pins go.mod's
  # version directive to a known-good value rather than trusting whatever
  # upstream AXL currently declares.
  sed -i -E 's/^go .*/go 1.25.0/' axl-src/go.mod
  (cd axl-src && go build -o ../axl-bin/node ./cmd/node) || die "AXL build failed"
  rm -rf axl-src
  chmod +x axl-bin/node
  ok "AXL binary built → axl-bin/node"
fi

# ── 6. Generate the 4 AXL identity keypairs ───────────────────────────────────
# Each of the 3 requester roles + 1 provider role needs its OWN keypair — AXL
# routes messages by public key, so two nodes sharing one identity would be
# indistinguishable to the provider. private-a.pem is the provider's identity
# (node-config-a.json); private-b/c/d.pem back requester-1/2/3 respectively
# (node-config-b/c/d.json). These are gitignored on purpose (real key
# material) — a fresh clone has none of them and must generate its own.
log "Generating AXL identity keypairs (private-a/b/c/d.pem)..."
for letter in a b c d; do
  keyfile="private-${letter}.pem"
  if [[ -f "$keyfile" ]]; then
    ok "${keyfile} already exists — skipping"
  else
    openssl genpkey -algorithm Ed25519 -out "$keyfile" 2>/dev/null
    chmod 600 "$keyfile"
    ok "Generated ${keyfile}"
  fi
done

# ── 7. Link the `overflow` CLI globally ────────────────────────────────────────
log "Linking the overflow CLI (npm link)..."
npm link
ok "overflow CLI linked — 'overflow --role=provider|requester' now available globally"

# ── 8. Copy .env.example → .env ───────────────────────────────────────────────
log "Setting up environment config..."
if [[ -f ".env" ]]; then
  warn ".env already exists — skipping copy (not overwriting your config)"
else
  if [[ -f ".env.example" ]]; then
    cp .env.example .env
    ok ".env created from .env.example"
    warn "Edit .env and fill in ANTHROPIC_API_KEY (required) before starting a node"
  else
    warn ".env.example not found — create .env manually"
  fi
fi

# ── 9. Check Python 3 (needed at runtime by the sandbox, not by this installer) ─
log "Checking Python 3 (used by the sandbox to execute generated code)..."
if command -v python3 &>/dev/null; then
  ok "python3 found: $(python3 --version)"
else
  warn "python3 not found on PATH — the sandbox execution path requires it. Install python3 before running a node."
fi

# ── 10. Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  ✅ Overflow installed!${RESET}"
echo ""
echo "  Next steps:"
echo ""
echo -e "  1. ${BOLD}Edit .env${RESET} — at minimum, set ANTHROPIC_API_KEY"
echo ""
echo -e "  2. ${BOLD}Start a node${RESET} (provider is the default role)"
echo ""
echo "     overflow --role=provider"
echo "     # or, in another terminal:"
echo "     overflow --role=requester"
echo ""
echo -e "  3. ${BOLD}Trigger delegation${RESET} (from a third terminal, while both are running)"
echo ""
echo "     npx tsx src/core/agent.ts --force-delegate --objective=\"your task here\""
echo ""
echo -e "  4. ${BOLD}Open the dashboard${RESET}"
echo ""
echo "     http://localhost:3001/dashboard   # provider"
echo "     http://localhost:3002/dashboard   # requester"
echo ""
echo -e "${CYAN}  Full docs: README.md${RESET}"
echo ""
