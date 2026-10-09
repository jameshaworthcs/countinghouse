# Running it as a service

How to run the app on a machine of your own as a long-lived service: a systemd unit, Caddy in
front of it on a private network, deploys from a worktree that roll back on failure, sign-in, agent
access and backups. Everything here is optional: `npm run dev` and `npm run demo` need none of it.

## The layout

Code and data live in two repositories, so the code can be shared and the data never is.

```
browser (on your private network, a tailnet say)
  │   finance.example.com → this machine's private addresses only
  ▼
Caddy (binds only those addresses, :443/:80)
  │   reverse_proxy, keeps Host, never buffers the event stream
  ▼
finance.service  →  node (tsx) src/server/main.ts   127.0.0.1:4750   (loopback only)
   code: ~/dev/finance-live          a worktree of the code checkout, at the commit last deployed
   data: ~/dev/finance-data/data     the data repository: git-versioned, auto-committed on main
         ~/dev/finance-data/.work/live  uploads waiting for review, job state, the audit log,
                                     agent session transcripts (not in git)
         ~/dev/finance-data/inbox    drop folder
   claude CLI (your login) for PDFs, screenshots and agent jobs
```

- **The code checkout** (`~/dev/finance` in these examples) is where you develop. It holds no real
  data: `npm run dev` and `npm run demo` use generated demo data, gitignored.
- **The data repository** (`~/dev/finance-data`) holds `data/`, the work area and the inbox. Make
  it with `npm run init-data -- ~/dev/finance-data`: it is a git repository of its own, with no
  remote and a `pre-push` hook that refuses every push, and its `.gitignore` keeps the work area
  and the inbox out of git. The command prints the `.env` lines that point the app at it.
- **The live worktree** (`~/dev/finance-live`) is a `git worktree` of the code checkout at the
  commit last deployed. You never edit it.

Paths are examples: `FINANCE_DATA_REPO` and `FINANCE_LIVE_DIR` choose others.

## Development and live

The live site and development are separate, so nothing you build, test or half-edit reaches it
until you deploy.

| | Code checkout | Live worktree |
|---|---|---|
| Code | whatever is on disk | the commit last deployed, detached, never edited |
| Data | demo data (gitignored) | `FINANCE_DATA_DIR`, in the data repository |
| `.env` | no production settings | the login, `PORT=4750`, the allowed host and the data paths (0600) |
| Ports | `npm run dev` API 4760 + UI 4761, `npm run demo` 4770 | 4750, behind Caddy |

- **Deploy** with `npm run deploy` (or `npm run deploy -- <commit>`) from the code checkout.
  - It checks out the commit in the live worktree and runs `npm ci` if the lockfile changed.
  - It builds the UI, refreshes the systemd unit if `deploy/finance.service.in` changed, and
    restarts.
  - It waits for `/api/health` to report the new commit, and rolls back to the previous commit
    if the build or the health check fails.
- **Check** what is live with `npm run deploy -- --status`; **roll back** with
  `npm run deploy -- <previous commit>`.
- **Restart** with `sudo systemctl restart finance`. It does not rebuild: it restarts the deployed
  commit exactly as it was.
- **Data auto-commits land on `main` in the data repository.** If that checkout is on another
  branch or a detached HEAD, the app holds its commits and says why under Settings → Data & git;
  the next change after you switch back commits them all.
- **Real data always needs a login.** A server started on a data directory tracked in git refuses
  to run without one, even on loopback, so other local accounts cannot read your finances from a
  development server. Demo and temporary data need no login.
- **Data tracked in the code's own repository is refused.** That is the layout before code and data
  were split: its commits would land in the code's history. In production the app will not start;
  in development the data is left as it is and nothing is committed (Settings → Data & git says
  why). Move it with `npm run init-data`.
- **A missing data directory is an error in production.** A wrong `FINANCE_DATA_DIR` fails the start
  instead of creating an empty dataset. `FINANCE_INIT_DATA=1` creates one on purpose.

## Setting up

1. **Install and make the data repository:**

   ```bash
   cd ~/dev/finance
   npm ci
   npm run init-data -- ~/dev/finance-data     # prints the .env lines to add
   ```

2. **Give it a login** in the code checkout's `.env`: OIDC (see "Sign-in" below) or a password
   (`npm run set-password`). Add the name the site is reached by to `FINANCE_ALLOWED_HOSTS`.
   `chmod 600 .env`.
3. **Make the live worktree and the service:** `npm run deploy -- --setup`. It creates the
   worktree, writes its `.env` (the login from the code checkout's, plus the data repository's
   paths, which `FINANCE_DATA_REPO` chooses), installs the systemd unit (with `sudo`) and starts it.
   From then on the login lives only in the live worktree's `.env`; change it there and restart.
4. **Put Caddy in front** (see "Caddy").
5. **Give it a name** that resolves only to the machine's private addresses (a DNS record you
   control, or your tailnet's own names).
6. **Check it:** `curl -s http://127.0.0.1:4750/api/health`, then open the site from another device
   on the network.

The app refuses to bind a non-loopback address without a login. Behind Caddy it stays on loopback.

## systemd

`deploy/finance.service.in` is the unit's template; `npm run deploy` fills in the node binary, the
live worktree, the user and the home directory, and installs it as
`/etc/systemd/system/finance.service` whenever the template changes.

- It runs as your user, in the live worktree, with `NODE_ENV=production` and `UMask=0077`.
- It is sandboxed: the operating system is read-only except your home directory, which stays
  writable because the `claude` CLI keeps its login and state there.
- `Restart=on-failure`; logs go to the journal: `journalctl -u finance -f`.

## Caddy

`deploy/Caddyfile.example` is a site block to adapt: your name, and the addresses to bind (the
machine's addresses on the private network, so nothing else can reach it). It keeps the `Host`
header (the app allow-lists it and checks `Origin` against it), never buffers the server-sent event
stream, allows uploads of up to 250 MB and sets the usual security headers.

A certificate for a name only your network can reach needs a DNS challenge, through your DNS
provider's Caddy module, or your network's own certificates (Tailscale issues them for `*.ts.net`
names). Validate before reloading: `sudo caddy validate --config /etc/caddy/Caddyfile`.

## Sign-in

One user, `FINANCE_USERNAME`, signs in one of two ways; a server uses exactly one.

- **OpenID Connect**, when `FINANCE_OIDC_CLIENT_ID` is set (authorization code with PKCE, state and
  nonce; `src/server/oidc.ts`):

  ```
  FINANCE_USERNAME=you
  FINANCE_ALLOWED_HOSTS=finance.example.com
  FINANCE_OIDC_ISSUER=https://auth.example.com     # required: there is no default
  FINANCE_OIDC_NAME=Example ID                     # what "Sign in with …" says (default: the issuer's host)
  FINANCE_OIDC_CLIENT_ID=…
  FINANCE_OIDC_CLIENT_SECRET=…                     # add it with an editor, not on the command line
  FINANCE_OIDC_ALLOWED_EMAILS=you@example.com
  # optional: FINANCE_OIDC_REDIRECT_URI (default https://<first allowed host>/api/auth/oidc/callback)
  ```

  - Register a confidential client with that redirect URI and the scopes `openid profile email`.
    The ID token's signing algorithm is taken from the provider's discovery document (RS256 when
    offered).
  - A signed-out visit to any page goes to the provider and comes back to the page it asked for.
  - Two gates: the provider may limit who reaches the client at all, and the app then admits only a
    verified address on `FINANCE_OIDC_ALLOWED_EMAILS`, as `FINANCE_USERNAME`.
  - Password sign-in is refused while OIDC is configured. Signing out of the app does not sign you
    out of the provider.
  - The sign-in page explains a failure in a sentence; `journalctl -u finance` has the detail. "Not
    with an account that can use" it: the address is not on the list, or not verified. "Couldn't
    be verified": the client secret is wrong, or the redirect URI does not match the registration
    exactly. "Took too long": more than 10 minutes at the provider, or two tabs.
- **A password** otherwise: `npm run set-password` stores a scrypt hash in `.env`. Sign-in is
  throttled at 10 failures per client and 50 in total per 15 minutes.

Changing the password, the OIDC client or the allowed addresses signs everyone out, as does a new
`FINANCE_SESSION_SECRET`.

## The demo in a codespace

The README's "Open in GitHub Codespaces" button runs the demo in the visitor's own codespace
(`.devcontainer/`): `npm ci` when it is created, then `npm run demo` on `127.0.0.1:4770` in a terminal
each time the editor attaches (`postAttachCommand`: Codespaces kills what a `postStartCommand`
leaves running in the background), with port 4770 forwarded and opened in the browser. Closing that
terminal stops the demo; `bash .devcontainer/start-demo.sh` starts it again. It
has no prebuilds, so it costs the repository nothing; no Claude, no local model and no real data.

GitHub's port forwarding reaches the app on loopback, with `Host: localhost:4770`, the codespace's
address in `X-Forwarded-Host`, and `X-Forwarded-For`/`-Proto`. So the app sees a proxied request,
which needs a login, and the cookie stays `Secure`. It also rewrites the `Origin` of the page's own
requests to `http://localhost:4770` (other origins pass through unchanged), which the CSRF check
would refuse. The devcontainer sets `FINANCE_DEMO_CODESPACE=1` for both (`src/server/codespace.ts`):

- **A throwaway login.** User `demo` with a random password, made at each start, kept in memory
  only, and shown on the sign-in page with a "Fill in" button. Anyone who can open the page can
  read it: the data is invented, and the port is private to the codespace's owner unless they make
  it public.
- **The proxy's Origin.** The CSRF check also accepts an `Origin` of `http://` + the `Host`, on a
  proxied request to a loopback `Host`. The `x-finance-csrf` header is still required, and every
  other guard is unchanged: `FINANCE_ALLOWED_HOSTS` stays empty, because the proxy never sends the
  public host as `Host`.

The app refuses to start with `FINANCE_DEMO_CODESPACE=1` unless the data already exists, is not
tracked in git, and its directory's name contains `demo`, and unless no login of its own
(`FINANCE_USERNAME`, `FINANCE_PASSWORD_HASH`, `FINANCE_OIDC_CLIENT_ID`) is set. Never set it
anywhere else.

## Agent access

Agents (a Claude Code session on the server, a script) use the live API with a token, without you
in the loop.

1. **Make a token** in Settings → Agent access: name it, tick what it may change, and choose when it
   expires (7, 30 or 90 days, or a year). It is shown once.
2. **Keep it where the helper looks:**

   ```bash
   mkdir -p ~/.config/finance && (umask 077; cat > ~/.config/finance/token)   # paste, Enter, Ctrl-D
   ```

3. **Use it** with the helper, which never prints the token:

   ```bash
   npm run -s api -- GET /imports                     # the imports waiting for review
   npm run -s api -- POST /proposals @proposal.json   # propose a fix (you apply or dismiss it)
   npm run -s api -- PUT /imports/<id>/draft @draft.json
   ```

   - The token comes from `FINANCE_TOKEN` or `~/.config/finance/token`; the server from
     `FINANCE_API_URL` (default `http://127.0.0.1:4750`).
   - By hand, send `Authorization: Bearer <token>`, plus `x-finance-csrf: 1` on anything that
     changes something.
   - In a Claude Code session the helper also sends `X-Agent-Session`, so the Agent sessions page
     groups a session's requests.

**What a token can do:** read every `GET` under `/api` always; and, by scope, import upkeep
(reprocess, refresh, choose the account, edit a draft, link transfer legs), agent records
(research, instruments, insights, proposed fixes, Ask feedback), and jobs (start, rerun, cancel,
while agents are on). No token can commit, dismiss or discard an import, upload files, change
transactions, balances, figures, accounts, rules or settings, apply a proposed fix, or make tokens.
A new route is closed to tokens until it is added to the list in `src/server/tokens.ts`. Only a
hash of each token is kept, in the work area, with a log of every use; the audit log shows what
each changed.

## The local model service (optional)

Work you set to the local model in Settings → Models goes to an OpenAI-compatible service of your
own (`src/server/inference.ts`): `INFERENCE_BASE_URL` and `INFERENCE_API_KEY` in the live `.env`
(and the code checkout's, for `npm run eval`). Nothing sent to it should leave your machines.
Without them, that work waits, and Settings → Models says why.

## Operations

- **Logs:** `journalctl -u finance -f`.
- **Agent sessions** (`/sessions`): what every Claude run did, with its transcript. They hold
  document contents, so they stay in the work area: never in git. Transcripts are kept 90 days, up
  to 10 MB each and 1 GB together (`FINANCE_TRANSCRIPT_DAYS`, `FINANCE_TRANSCRIPT_MAX_MB`,
  `FINANCE_TRANSCRIPTS_TOTAL_MB`).
- **Audit log:** Settings → Audit log, from the work area's `audit/`. On a tailnet, device names
  come from the local `tailscale whois`; `FINANCE_AUDIT_DEVICES=0` turns that off.
- **Update:** commit to `main` in the code checkout, then `npm run deploy`.
- **Backups:** back up the data repository every night, encrypted and off the machine: a
  `git bundle --all` of it (every data commit), the live `.env`, the work area (imports waiting for
  review, the audit log) and the inbox. Verify the bundle by cloning it, keep a few generations, and
  rehearse a restore. The data repository has no remote on purpose: nothing is pushed anywhere.
- **Sign everyone out:** change `FINANCE_SESSION_SECRET` in the live `.env` (or delete the work
  area's `session-secret` if it is not set) and restart. Agent tokens are separate: revoke them in
  Settings → Agent access, or delete the work area's `agent-tokens.json` and restart.
- **Remove the service:** `sudo systemctl disable --now finance`, `git worktree remove
  ~/dev/finance-live`, and take the site block out of Caddy's configuration.
