# Execution report — chat switching "performance" (task d161a914)

**Branch:** `perf-chat-switching` (commit `477e5c1`)
**Worktree:** `/Users/robert/dev/whatsagent-wt/perf-chat-switching`
**Status:** fix committed, gates green, **live verification pending a merge + backend restart** (worker cannot merge — protected-branch guard)

---

## The reported problem was not the actual problem

Reported: "switching between chats takes a very long time, presumably because we don't have lazy loading of messages from SQLite."

Measured against the live backend (8787) before touching any code:

| Measurement | Result |
| --- | --- |
| `GET /api/chats/:jid/messages?limit=60` | **2–6 ms**, sampled across 50 chats (avg 1.9 ms) |
| Whole database | **1158 messages**, 901 chats, largest chat = 114 messages |
| Lazy loading | **already implemented** — cursor pages (`beforeTs`/`beforeId`), focused pages, `idx_messages_chat_ts` present |
| Chat switch, click → rendered | **35–300 ms** warm, **187 ms** cold |
| 15 rapid switches @ 50 ms apart | no request pileup; slowest request 63 ms |
| Chat list at 901 rows vs filtered to 1 row | **no difference** — the list is not on the switch path |

So: no lazy-loading defect, no slow query, no main-thread block. The UI was not slow — it was **frozen**.

## Root cause

`chat-updated` was emitted with the **raw store `Chat`** from three sites, while every REST path emits the enriched `ChatView`:

- `server/api/events.ts:97` — ingest hook (fires on every incoming WhatsApp message)
- `server/index.ts:133` — draft scheduler hook
- `server/index.ts:161` — outbox pacer hook

The SPA consumes a `ChatView`. `displayName()` (`src/lib/client/view.ts`) dereferences `display_jid`, which the raw row does not have. The first such event replaced a complete chat in client state with a partial one, and the next render threw

```
TypeError: Cannot read properties of undefined (reading 'split')
```

**inside Svelte's effect flush**. A throw there does not degrade one row — it stops the reactive graph.

### Evidence

- 33 identical exceptions in the live console.
- Traced through the minified bundle: frame `Ec` = `displayName` (`e.display_jid.split('@')`), caller `jc` = `toChatRow`. Both the flush path and the click-handler path land on the same pair.
- Live symptom: `document.querySelectorAll('.chat-row.selected').length` grew 9 → 10 → 11 as chats were clicked and then **stayed at 11** across five further switches. Every previously clicked row keeps its pressed styling — the owner's "multiple chats seem selected".
- The chat list stops updating entirely: previews, timestamps, unread badges and reordering all freeze.
- The conversation pane *does* still switch (verified jid-keyed A→B→A→B→A: header follows correctly), which is why the failure reads as "some things work, some don't" rather than a crash.

## Fix (commit `477e5c1`)

- `chatNeedsReply` moved to `server/api/chat-view.ts` next to the view it feeds; new `chatViewFor(db, chat)` is the single correct way to build the payload. `routes.ts` re-exports `chatNeedsReply` for compatibility.
- `ServerEvent['chat-updated']` narrowed from `Chat | ChatView` to `ChatView`, so the **compiler** catches the next raw emit instead of the browser.
- All three emitters wrapped in `chatViewFor`.
- Client hardening (defence in depth, since these run inside effects where a throw is fatal to the whole app):
  - `displayName` / `jidDigits` fall back to the routing jid instead of throwing.
  - `#mergeChat` merges field-wise, so a partial payload can no longer strip `display_jid`/`preview`/`needs_reply` off a good row.
- Tests: `server/api/events.test.ts` (new — asserts the ingest hook emits a full view) and three cases in `src/lib/client/view.test.ts`.

Checked for the same class of bug elsewhere: `message-new`/`message-updated` already wrap via `toMessageView`; `draft-updated` and `outbox-updated` emit the same raw rows their REST handlers return, so there is no mismatch. `chat-updated` was the only one.

## Gates

- `npm run check` — svelte-check 0 errors / 0 warnings, `tsc -p tsconfig.server.json` clean
- `npx vitest run` — **378 passed / 378**, 27 files
- Build not re-run (no build-affecting change beyond source already covered by `check`)

## What is NOT verified

The fix runs on a server and a bundle that are not running anywhere: 8787 serves the **built** SPA from the main tree. Live verification requires merge → rebuild → backend restart, then re-running the browser check for:

1. zero `split` exceptions in the console,
2. `document.querySelectorAll('.chat-row.selected').length === 1` after every switch,
3. chat list reordering/previews updating as messages arrive.

## Learnings for the orchestrator

- **The protected-branch guard also blocks recovery.** `reference-transaction` denies *every* ref update on `main`, including `git merge --abort`. A worker that starts a merge (even one that is correctly refused) leaves `main` mid-merge with staged content and **no sanctioned way to undo it** — the escape hatch `WHATSAGENT_ALLOW_WORKER_MAIN_WRITE=1` is required just to clean up. Either allow aborts, or have the guard refuse *before* `MERGE_HEAD` is written. (Cleaned up here; `main` is back at `604bff2`, clean.)
- **REST/WS shape parity is unenforced by default.** The bug existed because one event type was typed as a union of "store row or view". Any `Chat | ChatView`-shaped union in an event contract is a latent version of this bug; narrowing the type was the actual fix, the wrapping was mechanical.
- **A frozen SPA reads to the owner as "slow".** Worth remembering when a performance report arrives with a plausible-sounding cause attached: the console had the answer in 33 identical exceptions, and no amount of query timing would have found it.
