# CLAUDE.md

Guidance for coding agents and contributors working in this repository.

## What this is

A local, single-user WhatsApp desktop client with an AI drafting agent: the agent
pre-drafts replies (in the owner's voice/language) for 1:1 chats that need one;
the owner edits, approves, and sends. The agent **never** sends autonomously —
that is a hard, structural invariant (R9), not a config toggle. Built as an
extensible shell so other channels (email, calendar, iMessage) can be added later
without restructuring core storage/UI.

Privacy, safety, and account-ban risk are documented at the top of
[`README.md`](./README.md) — read those sections before pairing or changing send
paths. Do not duplicate them here.

- Requirements: `docs/brainstorms/2026-07-25-whatsapp-agent-shell-requirements.md`
  (R1–R16, flows F1–F3, acceptance examples AE1–AE6)
- Implementation plan: `docs/plans/2026-07-25-001-feat-whatsapp-agent-shell-plan.md`
  (Implementation Units U1–U10)

Treat the plan as the source of truth for architecture decisions, file layout,
and per-unit test scenarios — do not re-derive these from scratch. Debugged root
causes live under `docs/solutions/`; read the relevant one before touching that
area.

## Architecture

Two-tier local runtime, one repo, `npm run dev`:

- **Node backend** (persistent process): owns the Baileys WhatsApp socket,
  `better-sqlite3` storage (WAL mode), the draft agent, and a paced outbox.
  REST + WebSocket API.
- **SvelteKit SPA** (`adapter-static`, served by the backend on localhost): chat
  list, conversation pane, composer. No SSR — this is a local single-user app.

Directory shape:

```
src/                    # SvelteKit SPA (routes, lib/components, lib/client)
server/
  channels/whatsapp/    # Baileys connection, auth-store, ingest, history, send, media
  channels/channel.ts   # Channel interface — the multi-channel extensibility seam
  store/                # db.ts, migrations/, typed accessors
  agent/                # scheduler → classifier → drafter; memory/
  providers/            # DraftProvider impls: claude, codex, ollama
  outbox/pacer.ts        # sole path through which WhatsApp sends happen
shared/                 # pure predicates imported by BOTH server and client
```

### The `shared/` boundary

The server must not import from `src/lib/client/`: that inverts the layering and
makes "client" a lie. Anything both sides need — rules where a server-side view
builder and a client-side renderer would otherwise drift apart — goes in
`shared/`, dependency-free (no Node built-ins, nothing from `$lib`) so it bundles
for the browser. Its tests need their own entry in `vite.config.ts`'s
`test.include`; they belong to neither side and would otherwise run nowhere.

### Key architectural decisions

Do not relitigate without cause — see the plan for rationale.

- **Own SQLite persistence for everything**, including WhatsApp auth
  creds/signal keys — Baileys' file/in-memory helpers are demo-only. Auth blobs
  are account-hijack credentials: encrypt at rest, `0600` file perms.
- **Provider layer = CLI spawn**, not API keys. `claude` and Codex CLIs under the
  owner's existing subscription login, with `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` explicitly stripped from the spawned
  child's env (these silently override subscription login and cause API billing).
  Ollama via native HTTP. Env sanitization applies to every provider adapter.
- **Needs-reply classification is deterministic** (1:1 + last message inbound +
  not skipped/muted/archived); the drafting LLM itself may return a structured
  `no_reply_needed` verdict instead of a separate classifier pass.
- **Draft debounce** (~60s after last inbound), not draft-per-message.
- **Outbox is the only send path** — manual composer sends and approved drafts
  both route through `outbox/pacer.ts`; nothing else may call the WhatsApp send
  function. Sends are paced with randomized jitter (~30–90s) using the *global*
  last-send time, not per-chat, and are restart-safe (resume pending rows, no
  dup sends).
- **Memory behind an interface** (`Memory`: retain/recall + domain helpers) with
  a Hindsight-backed implementation (local Docker, embedded Postgres) and a
  `NullMemory` no-op so the app runs without Docker.
- **1:1 only for the agent** — groups are fully usable in the shell but
  structurally excluded from classification/drafting (R8).
- **Origin/Host validation** on every mutating REST endpoint and the WS upgrade
  handshake (localhost CSRF/DNS-rebinding defense) — required for R9 to hold.
- **Neumorphic UI at the token layer**: cofounder.co-derived `@theme` CSS
  variables in `app.css`; catalog components are restyled via tokens, not
  per-component surgery. Reusable UI primitives under `src/lib/components/ui/`
  and `src/lib/components/ai-elements/` are **vendored** into this repo (see
  `src/lib/components/README.md`). App-specific widgets live in
  `src/lib/components/app/`.

### Safety invariants (structural, not configurable)

- **R9:** no code path reaches WhatsApp `sendMessage` except the outbox pacer,
  whose only inputs are owner-approved or owner-composed rows.
- **R10:** sends are human-paced, never bursted, even when many drafts are
  approved at once.
- Draft approval binds to the draft's basis message id — if newer inbound
  arrived since drafting, the UI must re-confirm rather than silently sending a
  stale draft.

## Contributor conventions

- **Gate before finishing:** `npm run check` (svelte-check 0 errors / 0 warnings
  + server `tsc`), `npm test`, and `npm run build` must all exit 0.
- **Repo-wide `tsc --noEmit` is not the gate** — use `npm run check` /
  `npm run check:server`. See
  `docs/solutions/2026-07-25-sveltekit-catalog-scaffold-gotchas.md`.
- **Never open the live WhatsApp database from a git worktree.**
  `openDatabase()` without an explicit `dataDir` refuses. Use
  `npm run preview:ui` for UI work, or pass an explicit `dataDir` in scripts.
  Override only with `WHATSAGENT_ALLOW_WORKTREE_LIVE_DB=1`, and only
  deliberately.
- **Provider adapters:** read
  `docs/solutions/2026-07-25-subscription-provider-cli-adapters.md` before
  changing spawn/env behavior, and
  `docs/solutions/2026-07-29-draft-provider-tool-surface.md` for the
  attacker-controlled-text / tool-surface story (why `--disable shell_tool` was
  not a fix and what was).
- **Migrations:** pick the next integer by listing
  `server/store/migrations/` — collisions fail every `openDatabase()`. See
  `docs/solutions/2026-07-26-migration-numbering-and-high-water-mark.md`.
- **Fixtures / CSS:** a green gate does not prove rendering. See
  `docs/solutions/2026-07-26-message-fixture-and-test-harness-traps.md`.
- **tsconfig:** keep `strict: true` only; do not tighten
  (`exactOptionalPropertyTypes`, etc.) inside a feature task — it breaks
  vendored catalog types.

---

<!-- PRIVATE-ONLY. The publish export strips everything from this marker down;
     it is meaningless to anyone outside this machine. -->

# SlayZone Environment

You are an agent running inside a [SlayZone](https://slayzone.com) task. Other agents may be running in their own tasks in parallel, and a human or another agent can reach you through this terminal at any time.

## Interact with SlayZone

If useful, you have a toolbox for acting on SlayZone itself. You can:

- create and update tasks, and spawn sub-tasks with their own agents
- attach assets, run processes, open web panels, set up automations
- change your own task's state

The toolbox is the `slay` CLI. `$SLAYZONE_TASK_ID` holds your task's ID, and most `slay` commands default to it. **Load the `slay` skill before running any `slay` command** — it holds the full reference of commands, flags, and domain-specific guides. Never guess subcommands or flags.

## Role-specific briefings (SlayZone-hosted, provider-agnostic)

Role context is delivered by SlayZone, not provider config, and lives in provider-neutral `.slayzone/`:

* **Worker** (session has a task ID): the `worker-briefing-on-create` automation stamps `.slayzone/worker.md` (read live from the main tree) into every new task's description, so workers of any provider receive it via their task brief. Delivered automatically — do not fetch it. If the file is ever missing, the automation appends a loud `!! WORKER BRIEFING MISSING !!` block instead of silently attaching nothing.
* **Orchestrator** (global agent session — no task ID; `$SLAYZONE_TASK_ID` is `__global-agent-panel`, which is the proxy for that): **read `/Users/robert/dev/whatsagent/.slayzone/orchestrator.md` at session start.** It's binding. `.slayzone/emit-role-brief.sh` prints it for you and is wired to SessionStart/PostCompact in `.claude/settings.json`, but that wiring is per-provider — if you have not seen the brief's contents in this session, run the script or read the file before acting as orchestrator. Never assume delivery happened.

Because each role's brief arrives on its own, **nothing else should restate it** — kickoffs, ping messages, and automations point at the brief rather than copying it, or they drift out of sync with it. **Only a project's orchestrator may edit that project's local role files** (`.slayzone/worker-local.md`, `.slayzone/orchestrator-local.md`) — it has standing permission to fold loop learnings into them. The core files (`.slayzone/worker.md`, `.slayzone/orchestrator.md`) are symlinks and read-only from inside a project; only the slayzone-meta orchestrator, working in `~/.agents` itself, promotes a learning into them. **Workers must never edit any of the four files**; surface a learning in the execution report instead and the orchestrator harvests it. This file stays role-neutral.

## Worker routing

Before an orchestrator dispatches any slay worker task, it must route it through the global **`slay-route-worker`** skill (`~/.agents/skills/slay-route-worker/`, symlinked into `~/.claude/skills/`, `~/.codex/skills/`, `~/.qwen/skills/` — available under any harness in every project). It picks the use-case lane (code-std/code-hard/design-std/design-hard/design-imagegen), which resolves the provider+model, and applies it via `~/.agents/skills/slay-route-worker/route-worker.sh <lane> <task-id> [model-key]`. This is stated here explicitly, not left to skill-description auto-discovery, because that varies by harness. Orchestrator-only — `route-worker.sh` refuses to run outside the global agent panel session.
