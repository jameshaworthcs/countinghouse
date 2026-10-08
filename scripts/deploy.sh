#!/usr/bin/env bash
# Deploy a commit of this repository to the live service (finance.service on P360).
#
#   npm run deploy                  deploy main
#   npm run deploy -- <ref>         deploy a commit, tag or branch
#   npm run deploy -- --setup       first time: create the live worktree and its .env, install the unit
#   npm run deploy -- --status      show what is deployed
#
# How it fits together (docs/SELF_HOSTING.md, "Development and live"):
#   - The service runs from its own worktree of this repository, LIVE_DIR (default ~/dev/finance-live),
#     at a detached commit, with a sparse checkout that leaves out data/.
#   - It reads and writes THIS checkout's data/ (FINANCE_DATA_DIR in LIVE_DIR/.env), so the app's
#     data auto-commits keep landing on main here.
#   - Building, testing or editing code here never touches the live site until you deploy.
#
# A deploy checks out the commit in LIVE_DIR, installs dependencies if the lockfile changed, builds
# the UI, refreshes the systemd unit if its template changed, restarts, and waits for /api/health to
# report the new commit. If the build or the health check fails it rolls back to the previous commit.
set -euo pipefail

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)"
LIVE_DIR="${FINANCE_LIVE_DIR:-$HOME/dev/finance-live}"
UNIT=/etc/systemd/system/finance.service
HEALTH=http://127.0.0.1:4750/api/health

say() { printf '%s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

render_unit() {
  local node_bin
  node_bin="$(dirname "$(command -v node)")"
  sed -e "s#@NODE_BIN@#$node_bin#g" -e "s#@APP_DIR@#$LIVE_DIR#g" -e "s#@USER@#$(id -un)#g" \
      -e "s#@HOME@#$HOME#g" -e "s#@DATA_REPO@#$REPO#g" "$REPO/deploy/finance.service.in"
}

install_unit_if_changed() {
  local rendered
  rendered="$(render_unit)"
  if [[ ! -f "$UNIT" ]] || [[ "$(cat "$UNIT")" != "$rendered" ]]; then
    say "Installing $UNIT"
    printf '%s\n' "$rendered" | sudo tee "$UNIT" >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable finance.service >/dev/null
  fi
}

# Wait until the service reports `want` (a short commit hash) as healthy.
wait_healthy() {
  local want="$1" body=""
  for _ in $(seq 1 60); do
    body="$(curl -fsS "$HEALTH" 2>/dev/null || true)"
    if [[ "$body" == *"\"commit\":\"$want\""* ]]; then return 0; fi
    sleep 1
  done
  say "health: ${body:-no response}"
  return 1
}

build_live() {
  local prev="$1" next="$2"
  if [[ ! -d "$LIVE_DIR/node_modules" ]] || ! git -C "$REPO" diff --quiet "$prev" "$next" -- package-lock.json; then
    say "Installing dependencies (npm ci)…"
    (cd "$LIVE_DIR" && npm ci --no-audit --no-fund --loglevel=error)
  fi
  say "Building the UI…"
  (cd "$LIVE_DIR" && npm run build --silent >/dev/null)
}

setup() {
  local commit
  commit="$(git -C "$REPO" rev-parse --verify main^{commit})"
  if [[ ! -e "$LIVE_DIR/.git" ]]; then
    say "Creating the live worktree at $LIVE_DIR (without data/)…"
    git -C "$REPO" worktree add --no-checkout --detach "$LIVE_DIR" "$commit"
    git -C "$LIVE_DIR" sparse-checkout set --no-cone '/*' '!/data/'
    git -C "$LIVE_DIR" checkout --quiet --detach "$commit"
  fi
  if [[ ! -f "$LIVE_DIR/.env" ]]; then
    [[ -f "$REPO/.env" ]] || die "no $REPO/.env to take the login from; run 'npm run set-password' in $LIVE_DIR after setup"
    say "Creating $LIVE_DIR/.env from $REPO/.env plus the live paths (values are not printed)…"
    umask 077
    {
      grep -E '^(FINANCE_USERNAME|FINANCE_PASSWORD_HASH|FINANCE_OIDC_[A-Z_]+|FINANCE_SESSION_SECRET|FINANCE_ALLOWED_HOSTS|ANTHROPIC_API_KEY)=' "$REPO/.env" || true
      printf 'HOST=127.0.0.1\nPORT=4750\n'
      printf 'FINANCE_DATA_DIR=%s/data\nFINANCE_INBOX_DIR=%s/inbox\nFINANCE_WORK_DIR=%s/.work/live\nFINANCE_DATA_BRANCH=main\n' "$REPO" "$REPO" "$REPO"
    } >"$LIVE_DIR/.env"
    chmod 600 "$LIVE_DIR/.env"
  fi
  build_live "$commit" "$commit"
  install_unit_if_changed
  sudo systemctl restart finance.service
  wait_healthy "$(git -C "$REPO" rev-parse --short "$commit")" || die "the service did not come up; see: journalctl -u finance -n 50"
  say "Live worktree ready and serving $(git -C "$REPO" log -1 --format='%h %s' "$commit")"
}

status() {
  [[ -e "$LIVE_DIR/.git" ]] || die "no live worktree at $LIVE_DIR (run: npm run deploy -- --setup)"
  say "Deployed:  $(git -C "$LIVE_DIR" log -1 --format='%h %s (%cr)')"
  say "main:      $(git -C "$REPO" log -1 --format='%h %s (%cr)' main)"
  say "Behind by: $(git -C "$REPO" rev-list --count "$(git -C "$LIVE_DIR" rev-parse HEAD)..main") commit(s)"
  say "Health:    $(curl -fsS "$HEALTH" 2>/dev/null || echo 'no response')"
}

case "${1:-}" in
  --setup) setup; exit 0 ;;
  --status) status; exit 0 ;;
  -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
esac

REF="${1:-main}"
[[ -e "$LIVE_DIR/.git" ]] || die "no live worktree at $LIVE_DIR (run: npm run deploy -- --setup)"
NEXT="$(git -C "$REPO" rev-parse --verify "$REF^{commit}" 2>/dev/null)" || die "unknown ref '$REF'"
PREV="$(git -C "$LIVE_DIR" rev-parse HEAD)"
SHORT="$(git -C "$REPO" rev-parse --short "$NEXT")"
[[ -z "$(git -C "$LIVE_DIR" status --porcelain --untracked-files=no)" ]] || die "$LIVE_DIR has local changes; the live worktree must stay clean"

say "Deploying $(git -C "$REPO" log -1 --format='%h %s' "$NEXT") (was $(git -C "$REPO" rev-parse --short "$PREV"))"
git -C "$LIVE_DIR" checkout --quiet --detach "$NEXT"
if ! build_live "$PREV" "$NEXT"; then
  say "Build failed; restoring $PREV"
  git -C "$LIVE_DIR" checkout --quiet --detach "$PREV"
  build_live "$NEXT" "$PREV" || true
  die "build failed; the live site is unchanged"
fi
install_unit_if_changed
sudo systemctl restart finance.service
if wait_healthy "$SHORT"; then
  say "Live at $SHORT"
  exit 0
fi
say "The new version did not become healthy; rolling back to $(git -C "$REPO" rev-parse --short "$PREV")"
sudo journalctl -u finance -n 20 --no-pager || true
git -C "$LIVE_DIR" checkout --quiet --detach "$PREV"
build_live "$NEXT" "$PREV" || true
sudo systemctl restart finance.service
wait_healthy "$(git -C "$REPO" rev-parse --short "$PREV")" || say "warning: the previous version is not healthy either"
die "deploy of $SHORT failed and was rolled back"
