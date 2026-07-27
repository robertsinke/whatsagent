#!/bin/sh
#
# Build (and optionally publish) the public snapshot of this repository.
#
#   scripts/publish-oss.sh                      # export + gate only. Default.
#   scripts/publish-oss.sh --clone <path>       # also sync into an existing clone
#   scripts/publish-oss.sh --clone <path> --push
#
# ## Why an export and not a shared repo
#
# This repository is and stays the working repo, with its full history and its
# local orchestration rails. The public repository is a **publication target
# only, sharing no refs with this one.** That is the entire safety argument:
# `main`'s history still contains files that were deleted from the tip, and under
# a shared-repo topology the only thing between that history and the internet is
# a push refspec — one `git config` away. Under this topology there is no ref
# path at all, so the failure mode does not exist.
#
# **Never add a public remote to this repository.** The clone at `--clone` is the
# only thing that ever has one.
#
# ## Why `git archive` and not `cp -r`
#
# `git archive HEAD` materialises exactly the *tracked* tree at HEAD, so nothing
# untracked, ignored, or half-staged can ride along — no `.env`, no stray
# screenshot, no build output. It also writes the committed blob for paths that
# are symlinks on this machine, which is what we want: the public tree gets real
# file content, never a symlink into somebody's home directory.
#
# We copy what should ship; we never `git rm --cached` to subtract. That command
# records a real deletion, so merging such a commit deletes the file from disk in
# every other checkout — it silently removed live tooling config here once
# already.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLONE=""
PUSH=0
KEEP=0

while [ $# -gt 0 ]; do
	case "$1" in
		--clone) CLONE="${2:?--clone needs a path}"; shift 2 ;;
		--push) PUSH=1; shift ;;
		--keep) KEEP=1; shift ;;
		-h|--help) sed -n '2,12p' "$0"; exit 0 ;;
		*) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
	esac
done

say()  { printf '%s\n' "$*" >&2; }
head2() { printf '\n=== %s ===\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

FAILED=0
fail() { printf 'GATE FAIL: %s\n' "$*" >&2; FAILED=1; }
pass() { printf 'gate ok:   %s\n' "$*" >&2; }

# --- what does NOT ship ------------------------------------------------------
#
# Everything else that is tracked does ship, including `docs/` — decided
# 2026-07-27: plan docs are architecture rationale and solution docs are debugged
# root causes, both genuinely useful to a contributor.
#
# The exclusions are only things that are meaningless or misleading outside this
# machine:
EXCLUDE_PATHS="
.slayzone
.githooks
.claude
scripts/publish-oss.sh
docs/solutions/2026-07-26-capturing-visual-evidence.md
docs/plans/2026-07-27-001-oss-readiness-plan.md
"
# - .slayzone / .githooks / .claude — task-orchestration rails. They assume a
#   binary and a task database that exist on one machine.
# - this script itself — it is a tool for *maintaining* the publication, useless
#   in the published tree, and it necessarily names the private rails and paths
#   it strips. Its own gates flagged it on the first dry run, which is the gate
#   working: anything describing what must not ship must not ship either.
# - capturing-visual-evidence.md — a worker procedure, not a contributor doc.
# - the OSS-readiness plan — meta-documentation *about* publishing this repo. It
#   names what the private history contains, the worktree paths, and the rails.
#   The FINAL `docs/` decision said docs ship; this one file is a deliberate
#   exception on its own merits, and it is the only place that judgement is
#   applied. Remove this line if you would rather publish it.

STAGE="$(mktemp -d)"
[ "$KEEP" -eq 1 ] || trap 'rm -rf "$STAGE"' EXIT INT TERM

head2 "Exporting tracked tree at HEAD"
( cd "$REPO_ROOT" && git archive HEAD ) | tar -x -C "$STAGE"
say "exported $(find "$STAGE" -type f | wc -l | tr -d ' ') tracked files to $STAGE"

head2 "Removing what must not ship"
for p in $EXCLUDE_PATHS; do
	if [ -e "$STAGE/$p" ]; then
		rm -rf "${STAGE:?}/$p"
		say "removed $p"
	else
		say "note: $p was not in the export (already gone?)"
	fi
done

head2 "Truncating CLAUDE.md at the PRIVATE-ONLY marker"
CLAUDE_MD="$STAGE/CLAUDE.md"
[ -f "$CLAUDE_MD" ] || die "CLAUDE.md missing from the export"
grep -q 'PRIVATE-ONLY' "$CLAUDE_MD" || die "CLAUDE.md has no PRIVATE-ONLY marker — refusing to guess where to cut"
# Keep a witness line from *above* the cut, so a truncation bug that eats the
# whole file cannot read as success below.
WITNESS="$(head -1 "$CLAUDE_MD")"
awk '/PRIVATE-ONLY/{exit} {print}' "$CLAUDE_MD" > "$CLAUDE_MD.cut"
mv "$CLAUDE_MD.cut" "$CLAUDE_MD"
say "truncated to $(wc -l < "$CLAUDE_MD" | tr -d ' ') lines"

# --- gates -------------------------------------------------------------------
#
# Run against the exported directory, BEFORE it is allowed near a git repo.
#
# Calibrated against a real export on 2026-07-28, not written from intent. Two
# rows in the original plan ("zero mentions of the orchestration tool anywhere",
# "zero /Users/robert") were unreachable against a tree that ships `docs/`, and
# an unreachable gate gets weakened under pressure rather than satisfied. So the
# accepted residue is named explicitly below and anything outside it fails.

head2 "Gates"

# 1. The private-data digit gate — the repo's own durable check.
if ( cd "$STAGE" && node scripts/check-no-private-data.mjs >/dev/null 2>&1 ); then
	pass "no undeclared 11-15 digit identifiers"
else
	fail "check-no-private-data.mjs — run it in $STAGE to see the findings"
fi

# 2. No absolute owner paths. CLAUDE.md's are below the truncation marker and the
#    only other holder was the excluded plan doc, so zero IS reachable here.
HITS="$(cd "$STAGE" && grep -rl '/Users/robert' . 2>/dev/null || true)"
if [ -z "$HITS" ]; then
	pass "no /Users/robert anywhere in the export"
else
	fail "/Users/robert appears in:
$HITS"
fi

# 3. Orchestration references. NOT zero — two mentions are legitimate and
#    verified, so this gate is an allowlist rather than a count:
#      scripts/check-hooks.mjs      explains why it no-ops without .slayzone/
#      docs/plans/2026-07-25-001…   cites SlayZone as a THIRD-PARTY open-source
#                                   project whose adapter architecture informed
#                                   this design — public technical attribution
ALLOWED_SLAY="scripts/check-hooks.mjs docs/plans/2026-07-25-001-feat-whatsapp-agent-shell-plan.md"
UNEXPECTED=""
for f in $(cd "$STAGE" && grep -ril 'slayzone\|slay tasks\|slay pty' . 2>/dev/null | sed 's|^\./||' || true); do
	case " $ALLOWED_SLAY " in
		*" $f "*) ;;
		*) UNEXPECTED="$UNEXPECTED $f" ;;
	esac
done
if [ -z "$UNEXPECTED" ]; then
	pass "orchestration references limited to the two allowlisted files"
else
	fail "unexpected orchestration references in:$UNEXPECTED
    If one of these is legitimate, add it to ALLOWED_SLAY with a reason.
    Do not delete the gate."
fi

# 4. The rails are gone.
for p in .slayzone .githooks .claude; do
	[ -e "$STAGE/$p" ] && fail "$p survived into the export"
done
[ -e "$STAGE/.slayzone" ] || pass "orchestration directories absent"

# 5. The truncation really happened, and did not eat the file.
if grep -q 'PRIVATE-ONLY' "$CLAUDE_MD"; then
	fail "CLAUDE.md still contains the PRIVATE-ONLY marker"
elif [ ! -s "$CLAUDE_MD" ]; then
	fail "CLAUDE.md is empty — truncation ate the whole file"
elif [ "$(head -1 "$CLAUDE_MD")" != "$WITNESS" ]; then
	fail "CLAUDE.md lost its first line — truncation cut too much"
else
	pass "CLAUDE.md truncated, non-empty, first line intact"
fi

# 6. The export must be buildable. This is the gate that actually proves a
#    stranger can use it, and the only one that takes real time.
head2 "Building the exported tree (npm ci + check + test + build)"
if ( cd "$STAGE" && npm ci >/dev/null 2>&1 \
	&& node scripts/patch-baileys.mjs >/dev/null 2>&1 \
	&& npm run check >/dev/null 2>&1 \
	&& npm test >/dev/null 2>&1 \
	&& npm run build >/dev/null 2>&1 ); then
	pass "npm ci && check && test && build all succeeded on the exported tree"
else
	fail "the exported tree does not build — rerun the steps in $STAGE to see why"
fi

if [ "$FAILED" -ne 0 ]; then
	say ""
	die "gates failed. Nothing was published. Staged tree: $STAGE (rerun with --keep to inspect)"
fi

head2 "All gates green"
say "Export is at: $STAGE"

# --- publish -----------------------------------------------------------------

if [ -z "$CLONE" ]; then
	say ""
	say "Dry run: no --clone given, so nothing was written to any repository."
	[ "$KEEP" -eq 1 ] && say "Staged tree kept at $STAGE"
	exit 0
fi

[ -d "$CLONE/.git" ] || die "$CLONE is not a git clone. Create the public repo and clone it first; this script will not create it."
( cd "$CLONE" && git rev-parse --abbrev-ref HEAD >/dev/null ) || die "$CLONE has no checked-out branch"

head2 "Syncing the export into $CLONE"
# Delete-and-replace so a file removed from the private tree also disappears
# publicly; --delete without --exclude .git would take the clone's history with
# it, which is why .git is excluded explicitly rather than by luck.
rsync -a --delete --exclude '.git' "$STAGE/" "$CLONE/"
( cd "$CLONE" && git add -A && git status --short )

if [ "$PUSH" -ne 1 ]; then
	say ""
	say "Staged into $CLONE but NOT committed or pushed (--push not given)."
	say "Review the diff above, then rerun with --push."
	exit 0
fi

head2 "Committing and pushing"
say "This is the point of no return: once pushed, it is mirrored and cannot be recalled."
( cd "$CLONE" \
	&& git commit -q -m "whatsagent $(cd "$REPO_ROOT" && git rev-parse --short HEAD)" \
	&& git push )
say "Published."
