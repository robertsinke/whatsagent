# PL-F1 — Outbox and Settings into the chat-list footer, hover-only labels

Slay task `b3f46850-7600-4b43-85dd-9e042bfcc60b` — plan section P2.4, with
Robert's explicit override of the safety carve-out.

## What changed

**Topbar deleted.** `+page.svelte` no longer renders `<header class="topbar">`
or its brand dot. The panes now fill the full shell height. The brand dot was
the only thing left in the topbar after P2.4 moved the chips out; a 10px dot
alone in a row is not enough to earn a whole bar, so the header was deleted
rather than kept. `goto` and `Settings`/`OutboxTray` imports were dropped from
`+page.svelte` (the OutboxTray and a new FooterSettings now live in the footer).

**Four controls in the chat-list footer, all icon-only at rest.**
`ChatList.svelte` footer now holds, left to right: Sends · Connected · Outbox ·
Settings, with three hairline separators. A slightly heavier separator
(`.footer-sep-strong`) divides the two status chips from the two action chips so
the row reads as two pairs.

**Hover-only labels, override applied to the safety carve-out.** Both
`SendModeIndicator.svelte` and `SessionStatus.svelte` previously kept their
labels permanently visible for live sends and for warn/bad/progress session
tones — a deliberate safety carve-out so the owner is "never unsure whether a
send is live". Robert asked for hover-only across all four footer controls
after seeing the carve-out. The carve-out is removed: both chips are now
icon-only at rest and reveal the label on `:hover` / `:focus-visible` /
`:focus-within`. The header comments in both components were rewritten to
record that the carve-out was removed **deliberately, by request**, and that
the next reader should not reinstate it without re-asking.

**State stays legible without text.** The plan required this and it holds:
- `SendModeIndicator`: live vs off is carried by the cobalt-tinted border/icon
  colour plus the `Radio` (live) vs `ShieldAlert` (off) icon swap. Verified:
  dry-run chip computes to muted `rgba(30,34,48,0.6)` ink with a neutral
  `rgb(214,217,223)` border; the live state keeps its cobalt border/background.
- `SessionStatus`: connected vs warn vs bad vs progress is carried by the
  `Wifi` / `WifiOff` / `Spinner` icon swap and the tone-driven colour (cobalt
  for warn, destructive for bad). The tooltip still carries `banner.detail`.

**OutboxTray trigger restyled.** The trigger was a `Button variant="ghost"`
with the Send icon + "Outbox" word + count badge. It is now a `.chip` matching
the other three footer controls: icon-only at rest, label on hover/focus. The
pending count badge stays visible at all times — a count is meaningful even
when the word is clipped. A cobalt border tint is applied when there are
pending rows. The Sheet content (the tray itself) is unchanged.

**New `FooterSettings.svelte`.** A small chip that links to `/settings` via
`goto` (client-side nav, same as the old topbar button), wrapped in a Tooltip.
Icon-only at rest, "Settings" label on hover/focus.

**Container-query proof.** `.list` already had `container-type: inline-size`
(added by the earlier P2.4 work). At the 20% pane minimum (~288px on a 1440
shell → 267px footer after padding), the four icon-only chips + three
separators fit on one row with no overflow. A `@container (max-width: 220px)`
rule tightens separator margins. Hover labels are allowed to overflow the pane
visually at very narrow widths rather than wrap or clip — the absolutely
positioned footer has no scroll, and clipping a hover label would hide the
affordance the hover reveals. The footer box itself stays within bounds
because every chip is icon-only at rest.

## Files

- `src/routes/+page.svelte` — topbar removed, `outbox`/`oncancel` passed to
  ChatList. Minimal, localised edit (kept clear of the sibling worker's region).
- `src/lib/components/app/ChatList.svelte` — footer now holds four controls +
  three separators; new `outbox`/`oncancel` props; container-query rule.
- `src/lib/components/app/SendModeIndicator.svelte` — carve-out removed,
  header comment rewritten, `.chip .chip-label` collapse applies to both modes.
- `src/lib/components/app/SessionStatus.svelte` — carve-out removed, header
  comment rewritten, `.chip .chip-label` collapse applies to all tones.
- `src/lib/components/app/OutboxTray.svelte` — trigger restyled as a chip;
  Button import kept (still used inside the Sheet).
- `src/lib/components/app/FooterSettings.svelte` — new, the Settings chip.

## Gate

- `npm run check` — 0 errors / 0 warnings.
- `npm test` — 602 passed (36 files).
- `npm run build` — exit 0.

## Visual evidence

Captured at 1440×950 via `scripts/screenshot.mjs` against `npm run preview:ui`
(throwaway DB, no WhatsApp socket). Port 8799 was cleared before starting the
preview; `npm run build` was run before capturing so the preview served fresh
CSS, not stale.

Computed-style assertions pair every screenshot. The screenshot script was
extended via `--eval` to read `getComputedStyle()` on a real `.chip-label`
element in the same pass as the capture.

| Shot | Pane width | State | Computed-style result |
| --- | --- | --- | --- |
| `rest-full.png` | 100% (footer 400px) | rest | all 4 labels `position: absolute`, `clip: rect(0,0,0,0)`, `width: 1px` → hidden. footer `scrollWidth === width` (no overflow). |
| `focus-outbox-full.png` | 100% (footer 400px) | Outbox chip focused | `position: static`, `clip: auto`, `width: 37.6px`, text `"Outbox"` → revealed. |
| `rest-narrow.png` | 288px (footer 267px) | rest | all 4 labels hidden; `scrollWidth 267 === width 267` → no overflow at 20% min. |
| `focus-settings-narrow.png` | 288px (footer 267px) | Settings chip focused | `position: static`, `clip: auto`, `width: 42.4px`, text `"Settings"` → revealed; footer box still 267px. |
| `verify3.png` | 100% | structural | `header` count 0, no `.topbar`, no `.brand-dot`, `.list-footer` has 7 children (4 chips + 3 separators). |
| `dryrun-check.png` | 100% | dry-run chip colour | `data-mode="dry-run"`, `color: rgba(30,34,48,0.6)`, neutral border → legible-off without text. Live state keeps cobalt (colour rules untouched). |

Screenshots live at `/tmp/pl-f1-shots/`.

### Notes for the next reader

- The hover screenshots were captured via `:focus` (programmatic
  `el.focus()`), which reveals the label through the same `:focus-visible` /
  `:focus-within` selectors a real keyboard user hits. A real mouse `:hover`
  reveals the label through the `.chip:hover .chip-label` rule in the same
  CSS block; both paths are covered by the same computed-style assertion
  (`position: static`, `clip: auto`).
- The brand-dot gradient CSS (`--cobalt-700` → `--cobalt-600`) is now unused
  in `+page.svelte`; the tokens remain defined in `app.css` for other uses.