# whatsagent

Local single-user WhatsApp desktop client with an AI drafting agent. The agent pre-drafts replies in your voice for 1:1 chats that need one; you edit, approve, and send. The agent never sends on its own.

Two-tier local runtime in one repo: a persistent Node backend (Baileys, SQLite, draft agent, paced outbox) and a SvelteKit SPA. Development is one command.

## Privacy

**There is no whatsagent server, and there never will be.** No account, no sign-up, no telemetry, no crash reporting, no analytics, no update ping that carries your data. The author of this project cannot read your messages, contacts, or drafts, and has built no mechanism that could. Everything runs on your machine, against a SQLite file on your disk.

**The only thing that ever leaves your machine is what you send to the LLM you chose**, and you choose it:

| Provider setting | Where your conversation text goes |
| --- | --- |
| `ollama` | Nowhere. The model runs on your machine — **zero network egress**. |
| `claude` | Anthropic, under your own Claude subscription login. |
| `codex` | OpenAI, under your own ChatGPT/Codex subscription login. |

With a cloud provider, drafting sends recent messages from the chat being drafted — including the other person's words — to that provider, under your account and their terms. That is the deal you are opting into by picking a cloud model, and it is the same deal you already accepted when you installed that CLI. If you would rather not make it on someone else's behalf, run Ollama and the app is fully airgapped from everyone, including us.

WhatsApp itself is the other party you already have a relationship with: the app connects as a linked device using your own account, exactly like WhatsApp Web.

## Safety and risk

Read this before pairing.

- **The agent never sends on its own.** This is structural, not a setting. Exactly one code path can call WhatsApp's send function — the outbox pacer — and its only inputs are messages you approved or typed yourself. There is no toggle that makes the agent autonomous, because there is no code to enable.
- **Sends are human-paced.** Approving ten drafts at once does not produce ten instant messages; the outbox spaces them out on a global clock.
- **Account-ban risk is real.** whatsagent talks to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial reimplementation of the WhatsApp Web protocol. WhatsApp does not sanction third-party clients and can ban accounts that use them. Repeated re-pairing is the main trigger, more than ordinary message traffic — but the risk is never zero, and it is a risk to the phone number you actually use. Pair only if you accept that.
- **Your local data is worth protecting.** The SQLite database contains your message history in plaintext, and the WhatsApp auth blobs are account-hijack credentials. They are encrypted at rest with a key in your login keychain, and the DB is `0600` in a `0700` directory — that protects against a stray copy in a synced folder or an unencrypted backup. It does **not** protect against malware already running as you: the keychain item is authorized for `/usr/bin/security` without a password prompt, so any process running under your account can read the key. Same terms as the credentials already sitting in `~/.claude` and `~/.codex`.

## Prerequisites

- **Node.js 20+**
- **npm** (ships with Node)
- **macOS only.** WhatsApp auth is encrypted with the login keychain; the app exits at startup on other platforms.
- Optional draft providers (pick at least one you will use):
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, logged in with your subscription (`claude auth status`)
  - [Codex CLI](https://github.com/openai/codex), logged in with your subscription
  - [Ollama](https://ollama.com) running locally
- Optional voice memory: Docker + `docker compose` for Hindsight (see below)

## Install

```bash
npm install
```

Copy the example environment file if you want to override defaults or feed Docker Compose:

```bash
cp .env.example .env
```

`.env` is gitignored. The app itself reads `PORT` (and Node's usual `NODE_ENV`); Compose reads the `HINDSIGHT_*` variables. App settings (provider, dry-run, memory mode) live in SQLite, not in `.env`.

## Development

One command starts the persistent backend and the Vite SPA (with `/api` proxied to the backend):

```bash
npm run dev
```

| Process | URL | Role |
| --- | --- | --- |
| Backend | `http://127.0.0.1:8787` | REST + WebSocket + Baileys + SQLite |
| SPA (Vite) | `http://localhost:5173` | UI; use this origin in development |

Ctrl+C (or SIGTERM) stops both processes cleanly: the runner owns shutdown and forwards the signal to each process group, then escalates to SIGKILL after a short grace period.

Individual processes if you need them:

```bash
npm run dev:server   # backend only (tsx watch)
npm run dev:web      # Vite only
```

## Production build and start

```bash
npm run build   # svelte-check + strict server typecheck + static build
npm start       # serves API + the built SPA from build/ on 8787
```

In production there is no Vite proxy — the backend serves the SPA and API from one origin.

## WhatsApp pairing and restart

1. Start the app (`npm run dev` or `npm start`).
2. Open the UI and scan the QR with WhatsApp → Linked Devices.
3. History sync runs; the session is stored encrypted in the app-data SQLite DB.

Restarting the app resumes the same session — it does not re-pair. Re-pair only when the UI shows `qr_expired` or `logged_out` (use the regenerate-pairing affordance). Avoid frequent re-pairing; that is the main ban risk, not ordinary message traffic.

`npm install` applies a local Baileys compatibility shim for the current
WhatsApp Desktop pairing identity. The runtime also resolves the live WhatsApp
Web protocol version with a tested fallback. `npm run check` fails if a Baileys
upgrade changes the patched layout, so the shim cannot silently disappear.

## Draft providers (subscription CLIs)

Provider choice is a setting (`provider`: `claude` | `codex` | `ollama`, optional `provider_model`). Defaults to Claude.

Claude and Codex ride your existing CLI subscription login. Adapters spawn the CLIs with an **explicit child environment** that strips billing override keys:

| Provider | Stripped from child env |
| --- | --- |
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` |
| Codex | `OPENAI_API_KEY`, `CODEX_API_KEY` |

Those variables silently force API billing even when the CLI is subscription-logged-in. Keep them out of the process that runs whatsagent if you can; the adapters strip them regardless.

Ollama uses local HTTP (`/api/chat`) — no API key, no spawn sanitization beyond the shared provider helpers.

## Ollama and Hindsight Docker

**Ollama:** install and run the daemon; set `provider=ollama` (and optionally `provider_model`). Default model name is `qwen3` if unset.

**Hindsight (optional voice memory):**

```bash
docker compose up -d
docker compose config --quiet   # validate the compose file
```

Then set `memory=hindsight` (optional `hindsight_url`, default `http://127.0.0.1:8888`). With `memory=null` or `off`, the app drafts without Docker. Compose defaults point Hindsight's LLM at Ollama on the host (`host.docker.internal:11434`); override via `.env` (see `.env.example`).

### Process-local Hindsight retain queue

When Hindsight is unreachable, retain observations queue **in memory** (capped) while SQLite still stores draft feedback durably. A process exit during an outage does **not** replay unsent Hindsight observations. Drafting continues via the local fallback.

## Settings and restart semantics

Settings are stored in SQLite (`GET`/`PUT /api/settings`) and edited from the Settings UI.

These are read when the Node process boots and require a **backend restart** after change:

- `provider`, `provider_model`
- `memory`, `hindsight_url`, `hindsight_bank`
- `outbox_dry_run`
- `pacing_min_seconds`, `pacing_max_seconds`

Saving them in the UI updates the DB immediately but does not hot-reload the running provider, memory backend, or outbox pacer.

## Draft refinement (preview only)

The draft surface exposes compact refinement controls — **Regenerate**, **Shorter**, **Longer**, **More formal**, and **Less formal** — that update the visible draft preview without approving, queuing, or sending anything.

- Refinement applies to the **unsaved editor text** when the draft editor is open; otherwise it transforms the saved preview. On success the transformed text replaces the preview and the editor stays open so you can keep editing.
- **Regenerate** writes a fresh reply from the current conversation context and advances the draft's basis to the latest inbound message. The four transforms (**shorter / longer / more / less formal**) rework the displayed draft while keeping its original basis.
- Refinement **never** calls the composer send endpoint, writes an outbox row, writes memory feedback, or wakes the pacer. The existing approve/edit/skip flows remain the only durable learning signals and the only path to a send.
- While a refinement request is in flight, every refinement control disables and a local progress label appears. On a provider failure or a 409 (the draft or inbound history changed while the provider was running), the **prior preview is preserved**, a recoverable error is surfaced, and the editor stays open — you can retry or edit manually.
- Approval after a refinement still exercises the server-side stale-basis guard: if newer inbound arrived since the (possibly advanced) basis, the UI asks you to re-confirm rather than sending a stale draft.
- Controls only render for drafts in a refinable state (`ready` or `stale`). A `failed` draft has no valid preview to transform; `drafting` has no text yet.

## Dry-run vs deliberate live sends

The outbox pacer is the **only** path that can call WhatsApp `sendMessage`.

- **Dry-run (safe default):** when `outbox_dry_run` is unset, malformed, or `true`, dry-run is **on** in every environment. Queued rows advance through the full state machine and are logged; `sendMessage` is never called.
- **Live sends:** set `outbox_dry_run=false` and restart the backend. Use deliberately — typically one manual send to your own number after dry-run confidence. Sends use a configurable global spacing window (0–1s by default) and remain serialized through one clock.

Manual composer sends and approved drafts both go through the same paced outbox.

To exercise drafting without waiting for an inbound message, open any 1:1 chat
and press **Generate draft**. It bypasses the needs-reply classifier — including
a trailing owner message, and a muted, archived, skipped or quiet chat — but not
the group exclusion, and not the outbox send path. (This replaced a
`WHATSAGENT_DEV_DRAFT_FROM_ME_MESSAGE_ID` environment override that could only
target one hardcoded message id.)

## App data and credential security

App data lives **outside the repo**:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/whatsagent` |
| Linux | `$XDG_DATA_HOME/whatsagent` or `~/.local/share/whatsagent` |
| Windows | `%APPDATA%\whatsagent` |

- SQLite DB file mode `0600`; data directory mode `0700`
- WhatsApp auth/signal blobs are encrypted at rest with a key stored in the macOS login keychain (`whatsagent.whatsapp-auth`)
- Treat the DB and keychain entry as account-hijack credentials — do not copy them into the repo, chat logs, or backups without encryption

### Pointing the app at a different data directory

`WHATSAGENT_DATA_DIR` (or `--data-dir <path>`, which wins over the env var)
overrides the table above for `npm start`, `npm run dev:server`, and the desktop
app. Use it to run the full app against a throwaway directory:

```bash
WHATSAGENT_DATA_DIR=/tmp/whatsagent-scratch npm start
```

The process logs the directory it opened at startup, so you can confirm which
database is live before pairing anything.

This is the **only** safe way to run a second copy of the app. Two processes on
the same data directory means two Baileys sockets on one WhatsApp account, which
is the primary account-ban risk — a fresh directory pairs as its own device
instead.

`WHATSAGENT_ALLOW_WORKTREE_LIVE_DB=1` is a different, narrower escape hatch: it
disarms the guard that refuses to open the **default** directory from a git
worktree. The two are unrelated, and the override above is almost always what you
want. Note that neither one protects a packaged desktop app, which is not a git
checkout at all — the desktop build therefore defaults to its own
`whatsagent-desktop` directory rather than the one in the table.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `Port 5173 is already in use` | Vite uses `strictPort: true` on 5173 (Origin allowlist). Free that port or stop the other Vite. |
| SPA loads but API/WS fail | Backend up on 8787? Dev origin must be `http://localhost:5173` (strict). |
| `Origin not allowed` / 403 on mutations | Foreign origin or wrong Host — loopback + allowed origins only. |
| Claude/Codex drafts bill the API | Ensure subscription login; confirm stripped env keys (see above). `total_cost_usd` in Claude CLI output is a usage estimate, not proof of API billing. |
| Provider / memory / dry-run change ignored | Restart the backend process. |
| Pairing every launch | Auth DB/keychain missing or `logged_out` — do not delete app-data casually. |
| Hindsight mode but no recall | `docker compose ps`; app still drafts via fallback when Hindsight is down. |
| `npm run check` noise about catalog exports | Use `npm run check` (svelte-check + `tsconfig.server.json`), not raw repo-wide `tsc --noEmit`. |

## npm audit status

As of this closeout, `npm audit` reports **6 low** severity findings in the SvelteKit / Bits UI cookie dependency chain (`cookie` via `@sveltejs/kit`, plus related UI packages). No moderate/high/critical. Do not run `npm audit fix --force` casually — it can pull breaking major upgrades. Re-check on dependency bumps.

## Scripts reference

| Script | Purpose |
| --- | --- |
| `npm run dev` | Backend + Vite together |
| `npm run dev:server` / `dev:web` | Split processes |
| `npm start` | Production-style backend (+ built SPA) |
| `npm run build` | Check + static build |
| `npm test` | Vitest |
| `npm run check` | svelte-check + strict server typecheck |

`npx tsx scripts/u6-refinement-smoke.ts` runs a disposable end-to-end smoke of the refinement contract (no live Baileys): it seeds a DB, starts `createApp` without a channel serving `build/`, and verifies refinement is preview-only and the SPA loads.
