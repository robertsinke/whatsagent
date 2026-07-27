# W4-U15 — owner-triggered "Generate draft", always available

**Branch** `w4-u15-generate-draft` (worktree `/Users/robert/dev/whatsagent-wt/u15-generate-draft`)
**Commits** `df58376` implementation, `247a08d` preview fixture, `+1` no-op fixes (below)
**Status** complete, all gates green, nothing merged or pushed

## What landed

The owner can now ask the agent for a draft on demand in any 1:1 chat, without
waiting for the ~60 s debounce and regardless of whether the deterministic
classifier considers the chat eligible.

### Backend seam — `server/agent/drafter.ts`

`DraftChatOptions.ownerRequested` selects a manual path that **bypasses** every
needs-reply condition — trailing outbound message, muted, archived, `skipped`,
`quiet` — because the owner asking is the authority. Three things it deliberately
does not do:

1. **It does not bypass R8.** `classifyNeedsReply` is where `chat.kind !== '1:1'`
   is enforced, so skipping the classifier would have silently dropped the group
   exclusion and left the route's 400 as the only guard. The check is restated
   inside `draftChat` on the branch that skips the classifier, and again in
   `DraftScheduler.generate()`. Both are tested directly, not only through the
   endpoint.
2. **It does not weaken approval staleness.** Basis is the last message in the
   chat, in either direction. `isCurrentBasis` drops only its *direction* clause
   in owner-requested mode (an outbound basis would otherwise supersede the run
   before the provider was ever called, at drafter.ts:170) — message identity
   still governs, so newer inbound after generation still marks the draft stale
   and forces approval to re-confirm. Covered by a test that lands an inbound
   mid-run.
3. **It does not touch the send path.** See R9 below.

Two prompt-level decisions that matter more than they look:

- The base system prompt invites `no_reply_needed` "when no response is
  warranted". The owner-requested path is entered *precisely* when automatic
  classification declined — most often because the owner spoke last — so without
  a counter-instruction the primary manual case would return no draft. An
  owner-requested clause now states plainly that a reply is wanted and that
  `no_reply_needed` is not an option.
- If the provider declines anyway, agent state is **cleared** rather than
  demoted to `quiet`. `quiet` is documented in the code as "the agent's own
  verdict"; setting it on an owner-requested run would demote the chat *because*
  the owner asked for help.

The trailing owner message stays mapped to an `assistant` turn. Mapping it to
`user` is `devDraftFromMeMessageId` semantics — reply to the owner themselves —
and is wrong for general manual generation, where the honest ask is "write the
next message the owner would send."

### Scheduler — `server/agent/scheduler.ts`

`generate(chatJid): boolean`, modelled on `retry()`. Routing through the
scheduler rather than calling `draftChat` directly means manual runs share the
one queue, the one concurrency limit and the one hook set — and `#schedule(jid,
0)` replaces a pending debounce timer for that chat instead of racing it
(tested: an inbound 10 s earlier plus a generate produces exactly one provider
call).

The owner marker is a `Set` **consumed once**, read-and-deleted at the top of
`#run` before the await. A marker that could survive its run would let the next
*automatic* debounce for that chat draft in a muted or skipped chat with no owner
request behind it — not an R9 break, but a silent violation of the skip/mute
contract. There is a test for exactly that sequence. The one place the marker is
deliberately re-added is a rate-limit reschedule, which is a continuation of the
same request rather than a new automatic run.

`generate()` refuses groups and refuses when a draft is `drafting` or `approved`,
so the seam is safe for any caller and not only for the route that guards ahead
of it. `retry()` has no kind check today; that gap was not copied.

### Endpoint — `POST /api/chats/:jid/draft/generate`

Ordering: 404 unknown chat → 400 group → 503 no provider → 409 empty chat → 409
`drafting`/`approved` → 202 accept. Mutating, so the existing Origin/Host
validation already covers it — verified with a test that a foreign Origin gets
403; no second check was added. The response does **not** block on the provider;
the existing `draft-updated` events carry the UI through `drafting → ready` and
`DraftStatus` already renders a shimmer for `drafting`.

The **empty-chat 409** is not in the brief's list but had to be added. History
sync creates chat rows independently of message delivery, so a 1:1 chat with no
messages is reachable; the drafter returns `not_needed` for it and emits no
event at all. A 202 there would have been precisely the silent no-op the brief
forbids — the owner presses the button and nothing whatsoever happens.

### Client and UI

`api.generateDraft(jid)`, plus `generating` / `generateError` on `AppState`
mirroring how `refineDraft` handles its in-flight flag and error surface. No
optimistic write — the 202 carries no draft.

**In-flight is scoped to the drafting run, not to the HTTP accept.** The brief
asked for the in-flight label to work "the same way Regenerate shows
'Refining…'", and `refining` covers a whole provider round-trip. The 202 arrives
*before* the scheduler runs: at the concurrency limit the chat sits in `#queue`
with no `drafting` row and no event, so clearing the flag on the response would
show "No draft" with a live button while the request was still pending.
`generating` is therefore held until the first `draft-updated` or `draft-removed`
for that chat, released on chat switch (the request belongs to the chat that
asked), and backed by a 30 s timeout so a run that somehow emits nothing cannot
strand the button disabled. Four client tests cover this.

The no-draft card gains a
**Generate draft** button, an "Asking the agent…" in-flight label, a short line
of copy, and an inline error on failure. The passive explanation of the automatic
behaviour stays; the button is an addition to it. `Regenerate` is untouched —
not restyled, not moved, not rerouted.

## R9 — unaffected, and verified

Generating a draft writes a draft row and nothing else. It enqueues no outbox
row, wakes no pacer, and reaches no send transport. The outbox pacer remains the
only path to WhatsApp send.

- Every route test in the new `owner-triggered generate` block asserts
  `SELECT COUNT(*) FROM outbox` is 0.
- Verified live in the running preview app as well: after clicking Generate
  draft and receiving a ready draft, `/api/outbox` returned `{outboxRows: 0}`.

## Should `devDraftFromMeMessageId` and `ownerRequested` be unified?

**No — and they should not be, beyond eventually deleting the dev hack.** They
look similar and are not. `devDraftFromMeMessageId` names *one exact message id*,
rewrites that message's role from `assistant` to `user`, and adds a "Development
test: treat the final owner-authored message as inbound" prompt clause — its
whole purpose is to fake an inbound so the automatic pipeline can be exercised
end to end. It flows through `classifyNeedsReply` and `listNeedsReplyCandidates`
(including a sort key that floats it to the front of the backlog), so it is a
*classifier* concept.

`ownerRequested` is a per-run authorisation that replaces classification
entirely, is not tied to any message id, and keeps the conversation faithful.
Folding one into the other would either drag the role-rewrite into manual mode
(wrong output) or drag classifier plumbing into a path that has no classifier.
The honest cleanup is to **delete `devDraftFromMeMessageId` once manual generate
has been used in anger** — it exists to trigger drafting without waiting for an
inbound, and the Generate button now does that properly, with a real UI, for
every chat rather than one hardcoded message. That deletion touches the
classifier, scheduler, drafter and `createApp` options and is a unit of its own,
not a rider on this one.

## Known gap

If the provider returns `no_reply_needed` **despite** the owner-requested prompt
clause forbidding it, the card shimmers briefly and then reverts to "No draft"
with no explanation of why. `draft-removed` does fire, so the button re-enables
and nothing hangs — it is cosmetic, not a silent no-op — but the owner is not
told the agent declined. Surfacing that verdict needs a channel the current
event set does not have (the reason string lives only in the provider result).
Worth a small follow-up; out of scope here.

## Tests

30 new, all passing. **441 total, up from the 411 baseline; zero failures.**

- `server/agent/drafter.test.ts` (6): outbound basis without self-supersession;
  trailing owner message stays an `assistant` turn and the prompt forbids
  `no_reply_needed`; group refused at the drafter; newer inbound still
  supersedes; a declined owner request does not silence the chat; empty chat
  returns `not_needed`.
- `server/agent/scheduler.test.ts` (8): drafts where the classifier rejects
  (outbound-last + skipped); drafts in a muted, archived, quiet chat; group
  refused at the seam; refused while `drafting` and while `approved`, leaving the
  row untouched; owner authority does not leak into the next automatic run;
  pending debounce cancelled rather than raced; existing draft marked stale and
  emitted before regenerating; agent state cleared instead of demoted to `quiet`.
- `server/api/routes.test.ts` (8): 202 + `drafting`→`ready` event sequence in a
  classifier-rejected chat; 400 group; 404 unknown chat; 409 empty chat; 503 no
  provider; 409 drafting; 409 approved with the approved text preserved; 403 on
  a foreign Origin. All assert an empty outbox.
- `src/lib/client/state.test.ts` (8): posts without an optimistic write; stays in
  flight past the 202 until the first draft event for *that* chat (an event for
  another chat does not release it); released when the run ends with no draft;
  released on chat switch; readable error on failure; 503 explained in the
  owner's terms; second press ignored while one is in flight; error cleared on
  chat switch.

## Gates

| Gate | Result |
| --- | --- |
| `npm run check` | 0 errors, 0 warnings (4870 files) |
| `npm run build` | pass |
| `npx vitest run` | 28 files, **441 passed**, 0 failed |

## Visual evidence

Captured with `npm run preview:ui` — throwaway database, no channel, no WhatsApp
socket, fake provider. The owner's live account was never touched. Screenshots
are committed under `docs/evidence/w4-u15/` so they outlive `/tmp`.

- **No-draft card with the Generate draft button** — `docs/evidence/w4-u15/generate-draft-button.png`
  Chat "Nadia Bakker": 1:1, owner sent the last message, `agent_state = 'skipped'`
  — declined twice over by the classifier. The passive explanation is kept and the
  button sits below it with the copy "Writes a draft for you to review — it still
  never sends itself."
- **After pressing it** — `docs/evidence/w4-u15/generated-draft-result.png`
  The draft arrived over the `draft-updated` socket event (nothing optimistic),
  the card switched to "Draft ready", and the existing Regenerate / Shorter /
  Longer / formality row and Approve & queue are unchanged. `/api/outbox`
  reported 0 rows at this point.
- **Group chat, no button** — `docs/evidence/w4-u15/group-no-generate-button.png`
  "Group Sandbox" shows "Group · agent excluded" and neither the no-draft card
  nor the Generate button. Asserted in the DOM as
  `{generateButton: false, noDraftCard: false}`.
- **Re-verified after the in-flight change** — `docs/evidence/w4-u15/generate-draft-button-post-change.png`
  The card is unchanged, and a live click still produced
  `{draftReady: true, hasRegenerate: true}` with `outboxRows=0`.

The preview fixture gained one chat (`247a08d`) because it had no 1:1 chat where
the owner spoke last — the exact case this button exists for.

Note: :8799 was occupied by another worker's preview mid-session, so the
re-verification ran on :8811. That worker's process was left running.

## Notes for the orchestrator

- Nothing was merged or pushed; the branch is local to the worktree.
- The real backend was never started from the worktree.
- One follow-up is worth queuing: delete `devDraftFromMeMessageId` now that
  manual generate supersedes its purpose. Rationale above.
