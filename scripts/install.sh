#!/bin/sh
#
# whatsagent installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/robertsinke/whatsagent/main/scripts/install.sh | sh
#
# ## Why a shell script and not a .dmg
#
# Gatekeeper's notarization check only fires on files carrying the
# `com.apple.quarantine` extended attribute, and that attribute is written by the
# *downloading application* — browsers set it, `curl` does not. whatsagent is
# ad-hoc signed and cannot be notarized (there is no Apple Developer account), so
# a browser-downloaded DMG is the one distribution channel that could never work,
# while a `curl`-fetched tarball works with no right-click→Open and no
# `xattr -d`. This script is the mechanism, not a convenience wrapper.
#
# ## Deliberately dependency-free
#
# POSIX sh, curl, tar, shasum, grep, sed. No Node, no jq, no Homebrew — the whole
# point is that it runs on a Mac that has none of them.
#
# ## Environment overrides
#
#   WHATSAGENT_REPO      owner/name to install from (default robertsinke/whatsagent)
#   WHATSAGENT_BASE_URL  fetch the assets from here instead of a GitHub release.
#                        Must serve SHA256SUMS and the tarball it names. Used to
#                        rehearse this script against a locally served build.
#   WHATSAGENT_PREFIX    install directory (default /Applications, falling back
#                        to ~/Applications when /Applications is not writable)

set -eu

REPO="${WHATSAGENT_REPO:-robertsinke/whatsagent}"
APP_NAME="whatsagent-desktop.app"

say() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "whatsagent's desktop build is macOS only (this is $(uname -s))."

ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
	die "no prebuilt binary for $ARCH.

Releases are arm64 only: each architecture has to be built on its own runner
(better-sqlite3 ships per-arch prebuilds), and two runners would each emit a
latest-mac.yml that overwrites the other's, leaving one architecture unable to
update. On an Intel Mac, build from source instead:

  git clone https://github.com/$REPO && cd whatsagent
  npm install && node node_modules/electron/install.js
  npm run dist:mac"
fi

for tool in curl tar shasum; do
	command -v "$tool" >/dev/null 2>&1 || die "\`$tool\` is required but not on PATH."
done

# --- where the assets live ---------------------------------------------------

if [ -n "${WHATSAGENT_BASE_URL:-}" ]; then
	BASE_URL="${WHATSAGENT_BASE_URL%/}"
	say "Installing from $BASE_URL"
else
	# Resolve "latest" through the release redirect rather than the JSON API: no
	# parser needed, and it is not subject to the API's unauthenticated rate limit.
	say "Finding the latest release of ${REPO}…"
	LATEST_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
		"https://github.com/$REPO/releases/latest")" \
		|| die "could not reach GitHub. Are you online?"
	TAG="${LATEST_URL##*/}"
	[ -n "$TAG" ] && [ "$TAG" != "releases" ] \
		|| die "$REPO has no published releases yet."
	BASE_URL="https://github.com/$REPO/releases/download/$TAG"
	say "Latest release: $TAG"
fi

WORK="$(mktemp -d)"
# shellcheck disable=SC2064  # $WORK must expand now, not at trap time.
trap "rm -rf '$WORK'" EXIT INT TERM

# --- fetch and verify --------------------------------------------------------

# SHA256SUMS is the single source of truth for both the file name and its
# checksum, so nothing here has to reconstruct a version string.
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$WORK/SHA256SUMS" \
	|| die "could not download $BASE_URL/SHA256SUMS"

SUM_LINE="$(grep -E "$ARCH\.tar\.gz\$" "$WORK/SHA256SUMS" || true)"
[ -n "$SUM_LINE" ] || die "SHA256SUMS lists no $ARCH tarball:
$(cat "$WORK/SHA256SUMS")"

TARBALL="$(printf '%s' "$SUM_LINE" | sed -e 's/^[0-9a-f]*[[:space:]]*[*]*//')"
say "Downloading ${TARBALL}…"
curl -fSL --progress-bar "$BASE_URL/$TARBALL" -o "$WORK/$TARBALL" \
	|| die "could not download $BASE_URL/$TARBALL"

say "Verifying checksum…"
# `shasum -c` matches by the name inside the file, so verify from $WORK.
( cd "$WORK" && printf '%s\n' "$SUM_LINE" > expected.sha256 \
	&& shasum -a 256 -c expected.sha256 >/dev/null ) \
	|| die "checksum mismatch — the download is corrupt or has been tampered with.
Nothing was installed."

# --- unpack ------------------------------------------------------------------

mkdir "$WORK/unpacked"
tar -xzf "$WORK/$TARBALL" -C "$WORK/unpacked"
[ -d "$WORK/unpacked/$APP_NAME" ] || die "archive did not contain $APP_NAME."

# --- choose a destination ----------------------------------------------------

if [ -n "${WHATSAGENT_PREFIX:-}" ]; then
	PREFIX="$WHATSAGENT_PREFIX"
	mkdir -p "$PREFIX" || die "cannot create $PREFIX"
elif [ -w /Applications ]; then
	PREFIX=/Applications
else
	# A non-admin account cannot write /Applications, and asking for sudo to
	# install a WhatsApp client is a worse trade than a per-user install. macOS
	# treats ~/Applications as a first-class app location.
	PREFIX="$HOME/Applications"
	say "/Applications is not writable; installing to $PREFIX instead."
	mkdir -p "$PREFIX"
fi

TARGET="$PREFIX/$APP_NAME"

if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
	die "whatsagent is running from $TARGET. Quit it and run this again."
fi

# --- install -----------------------------------------------------------------

if [ -e "$TARGET" ]; then
	say "Replacing the existing install at ${TARGET}…"
	PREVIOUS="$TARGET.previous.$$"
	mv "$TARGET" "$PREVIOUS" || die "could not move $TARGET aside."
	if mv "$WORK/unpacked/$APP_NAME" "$TARGET"; then
		rm -rf "$PREVIOUS"
	else
		mv "$PREVIOUS" "$TARGET"
		die "could not install into $PREFIX; the previous version is untouched."
	fi
else
	mv "$WORK/unpacked/$APP_NAME" "$TARGET" || die "could not install into $PREFIX."
fi

# --- prove the mechanism ------------------------------------------------------

# The whole design rests on this attribute being absent, so check rather than
# assume. If some future curl or tar starts setting it, this is where it surfaces.
if xattr -l "$TARGET" 2>/dev/null | grep -q com.apple.quarantine; then
	say ""
	say "warning: $TARGET carries com.apple.quarantine, which should be impossible"
	say "for a curl-fetched tarball. macOS will refuse to open it. Clear it with:"
	say "  xattr -dr com.apple.quarantine \"$TARGET\""
fi

say ""
say "Installed $TARGET"
say ""
say "whatsagent is ad-hoc signed and not notarized by Apple — see the README."
say "It runs entirely on this machine and sends nothing anywhere except to the"
say "LLM provider you choose (nothing at all if you choose a local model)."
say ""
say "Open it with:  open \"$TARGET\""
