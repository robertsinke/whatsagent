/**
 * In-app updates for the ad-hoc signed macOS build.
 *
 * ## Why this is not just `autoUpdater.downloadUpdate()`
 *
 * `electron-updater` is used here for *detection only*. Its macOS install path
 * (`MacUpdater.doDownloadUpdate`) hands the downloaded zip to Electron's native
 * `autoUpdater`, which is Squirrel.Mac. Squirrel derives a `SQRLCodeSignature`
 * from the **running** bundle's designated requirement and refuses any update
 * that does not satisfy it. Under ad-hoc signing that requirement is a bare
 * cdhash, and the cdhash changes on every build — so every update fails, always.
 *
 * The unit spec assumed this could be turned off ("macOS signature verification
 * relaxed"). It cannot: `verifyUpdateCodeSignature` is a Windows-only option on
 * `NsisUpdater`, and `MacUpdater` exposes no equivalent. Verified by reading
 * `node_modules/electron-updater/out/MacUpdater.js` at 6.8.9.
 *
 * So the download and install half is ours: fetch the zip named by the feed,
 * verify it against the SHA-512 the feed already publishes, unpack it, confirm
 * the unpacked bundle's own ad-hoc signature is intact, and swap it in.
 *
 * ## What that actually guarantees, stated honestly
 *
 * TLS to GitHub, plus a SHA-512 from `latest-mac.yml` fetched over that same
 * connection, plus the build-provenance attestation on the release asset. It is
 * **not** a pinned code signature: an attacker who could rewrite the release
 * assets could rewrite the checksum file alongside them. That is the same trust
 * model as the `curl` install script, which is the point — the update path and
 * the install path have identical properties instead of one silently weaker one.
 *
 * `codesign --verify` on the unpacked bundle is an integrity check against a
 * truncated or tampered download, not an authenticity check. Ad-hoc signatures
 * carry no identity, so there is no identity to verify.
 */
import { app, dialog, net, shell } from 'electron';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The published release feed. Must match `publish:` in `electron-builder.yml` —
 * the two are read by different code paths (this one, and the `app-update.yml`
 * electron-builder bakes into the bundle) and would drift apart silently.
 *
 * The slug is a prediction until OSS-P1.6 creates the public repo.
 */
const GITHUB_OWNER = 'robertsinke';
const GITHUB_REPO = 'whatsagent';

/** Let the app finish starting before spending bandwidth on an update check. */
const FIRST_CHECK_DELAY_MS = 15_000;
/** A desktop app that stays open for weeks should still notice a release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Point the updater at a locally served directory instead of GitHub. This is how
 * the update path is rehearsed end to end without publishing a release — see the
 * "Updates" section of README.md. Absent, the GitHub feed above is used.
 */
const FEED_URL_OVERRIDE = process.env.WHATSAGENT_UPDATE_FEED_URL;
/** Set to `0` to never check. Useful for offline use and for packaging tests. */
const CHECKS_ENABLED = process.env.WHATSAGENT_UPDATE_CHECK !== '0';
/**
 * Install without asking. Intended for unattended installs, and the only way the
 * swap is exercisable in a headless verification run.
 */
const NONINTERACTIVE = process.env.WHATSAGENT_UPDATE_NONINTERACTIVE === '1';

/** Guards against two overlapping update runs from the timer and a manual check. */
let updateInProgress = false;

/**
 * The installed `.app` this process is running from.
 *
 * Derived from the executable rather than hardcoded to `/Applications`, because
 * the install script falls back to `~/Applications` when `/Applications` is not
 * writable — which is most of the point of that fallback.
 */
function bundleRoot() {
	// …/whatsagent-desktop.app/Contents/MacOS/whatsagent-desktop → …/whatsagent-desktop.app
	const root = resolve(app.getPath('exe'), '..', '..', '..');
	if (!root.endsWith('.app')) {
		throw new Error(`Refusing to update: ${root} does not look like an app bundle.`);
	}
	return root;
}

/** Base URL that `latest-mac.yml`'s relative file names resolve against. */
function assetBaseUrl(version) {
	if (FEED_URL_OVERRIDE) return FEED_URL_OVERRIDE.replace(/\/$/, '');
	// electron-builder's GitHub publisher tags releases `v${version}`.
	return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}`;
}

async function configureUpdater() {
	// electron-updater ships CommonJS; a named import is not reliably lexable.
	const { default: electronUpdater } = await import('electron-updater');
	const { autoUpdater } = electronUpdater;

	// Never let electron-updater download anything itself: `downloadUpdate()` is
	// precisely the call that hands off to Squirrel.Mac. `checkForUpdates()` only
	// fetches and parses the feed, and touches the native updater not at all.
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.logger = console;

	if (FEED_URL_OVERRIDE) {
		autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL_OVERRIDE });
	} else {
		autoUpdater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO });
	}
	return autoUpdater;
}

/**
 * Pick the zip for this architecture.
 *
 * The build is arm64-only today, so this is defensive rather than load-bearing —
 * but a feed that has gained an x64 asset must not hand an x64 bundle to an
 * arm64 machine, and that failure would present as a mysterious launch crash.
 */
function selectAsset(files) {
	const zips = files.filter((file) => file.url.endsWith('.zip'));
	if (zips.length === 0) throw new Error('Update feed lists no .zip asset.');
	const forArch = zips.filter((file) => file.url.includes(process.arch));
	return forArch[0] ?? (zips.length === 1 ? zips[0] : undefined);
}

/** Download to `destination`, streaming, and fail if the SHA-512 does not match. */
async function downloadVerified(url, destination, expectedSha512) {
	const response = await net.fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${url} returned HTTP ${response.status}.`);
	}

	const hash = createHash('sha512');
	await pipeline(
		Readable.fromWeb(response.body),
		new Transform({
			transform(chunk, _encoding, done) {
				hash.update(chunk);
				done(null, chunk);
			}
		}),
		createWriteStream(destination)
	);

	const actual = hash.digest('base64');
	if (actual !== expectedSha512) {
		// The file is a lie; do not leave it on disk where a later run might use it.
		await rm(destination, { force: true });
		throw new Error(
			`Checksum mismatch for ${url}.\n  expected ${expectedSha512}\n  actual   ${actual}`
		);
	}
}

/**
 * Unpack with `ditto`, deliberately, not `unzip`.
 *
 * electron-builder writes the zip with `ditto`, and `Electron Framework.framework`
 * is a tree of symlinks. `unzip` can materialise those as real directories, which
 * both doubles the size and breaks the code signature — and the breakage only
 * surfaces at launch.
 */
async function unpack(zipPath, intoDir) {
	await execFileAsync('ditto', ['-x', '-k', zipPath, intoDir]);
	const entries = await readdir(intoDir);
	const bundle = entries.find((entry) => entry.endsWith('.app'));
	if (!bundle) throw new Error(`Update archive contained no .app bundle (saw: ${entries.join(', ')}).`);
	return join(intoDir, bundle);
}

/**
 * The swap itself, as a detached shell script.
 *
 * It cannot run in this process: this process lives inside the bundle being
 * replaced. It cannot live inside the bundle either, for the same reason — it is
 * written to the data directory.
 *
 * Two details are load-bearing:
 *
 *   - It waits on **pid exit**, not on `app.quit()` returning. `before-quit` in
 *     main.js calls `preventDefault()` and closes the socket and database
 *     asynchronously, so the process outlives the quit call by a noticeable
 *     margin. Relaunching early also trips the single-instance lock, which lives
 *     in the data directory and would reject the new copy outright.
 *   - It moves the old bundle aside before deleting it, so an interrupted swap
 *     leaves a working app on disk rather than a hole where one used to be.
 */
const SWAP_SCRIPT = `#!/bin/sh
# Written by whatsagent's updater. Safe to delete.
set -u
pid="$1"; staged="$2"; target="$3"; log="$4"

exec >>"$log" 2>&1
echo "--- swap $(date): pid=$pid staged=$staged target=$target"

waited=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 0.2
  waited=$((waited + 1))
  if [ "$waited" -gt 300 ]; then
    echo "timed out after 60s waiting for pid $pid to exit; aborting"
    exit 1
  fi
done

previous="$target.previous.$$"
if ! mv "$target" "$previous"; then
  echo "could not move $target aside (permissions?); aborting without changes"
  exit 1
fi

if mv "$staged" "$target"; then
  rm -rf "$previous"
  echo "swap complete"
else
  echo "could not move staged bundle into place; rolling back"
  mv "$previous" "$target"
  exit 1
fi

rm -rf "$(dirname "$staged")"
open "$target"
`;

async function performUpdate(autoUpdater, updateInfo) {
	const target = bundleRoot();
	const asset = selectAsset(updateInfo.files);
	if (!asset) {
		throw new Error(`Update feed has no .zip asset for ${process.arch}.`);
	}

	// Staged next to the target so the final `mv` is a rename within one volume
	// rather than a 400 MB copy that can half-finish.
	const stagingParent = await mkdtemp(join(dirname(target), '.whatsagent-update-'));
	const downloadDir = join(app.getPath('userData'), 'updates');
	await mkdir(downloadDir, { recursive: true });
	const zipPath = join(downloadDir, `update-${updateInfo.version}.zip`);

	try {
		const url = `${assetBaseUrl(updateInfo.version)}/${asset.url}`;
		console.log(`whatsagent update: downloading ${url}`);
		await downloadVerified(url, zipPath, asset.sha512);
		console.log('whatsagent update: checksum ok, unpacking');

		const staged = await unpack(zipPath, stagingParent);

		// Integrity, not authenticity — see this file's header. A truncated or
		// rewritten bundle fails here rather than at the user's next launch.
		await execFileAsync('codesign', ['--verify', '--strict', '--deep', staged]);
		console.log(`whatsagent update: staged bundle verified at ${staged}`);

		const scriptPath = join(app.getPath('userData'), 'apply-update.sh');
		const logPath = join(app.getPath('userData'), 'update.log');
		await writeFile(scriptPath, SWAP_SCRIPT, 'utf8');
		await chmod(scriptPath, 0o755);

		const child = spawn('/bin/sh', [scriptPath, String(process.pid), staged, target, logPath], {
			detached: true,
			stdio: 'ignore',
			// Anywhere but inside the bundle about to be moved.
			cwd: app.getPath('userData')
		});
		child.unref();

		console.log(`whatsagent update: applying ${updateInfo.version}, quitting`);
		await rm(zipPath, { force: true });
		app.quit();
	} catch (error) {
		await rm(stagingParent, { recursive: true, force: true });
		await rm(zipPath, { force: true });
		throw error;
	} finally {
		void autoUpdater;
	}
}

async function promptAndUpdate(autoUpdater, updateInfo, parentWindow) {
	if (!NONINTERACTIVE) {
		const { response } = await dialog.showMessageBox(parentWindow ?? undefined, {
			type: 'info',
			buttons: ['Install and Restart', 'Release Notes', 'Later'],
			defaultId: 0,
			cancelId: 2,
			message: `whatsagent ${updateInfo.version} is available.`,
			detail:
				`You are running ${app.getVersion()}. The update is downloaded from GitHub and ` +
				`checked against the SHA-512 published with the release before it is installed.\n\n` +
				`whatsagent will close and reopen. Nothing is sent while it restarts.`
		});
		if (response === 1) {
			await shell.openExternal(
				`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${updateInfo.version}`
			);
			return;
		}
		if (response !== 0) return;
	}

	try {
		await performUpdate(autoUpdater, updateInfo);
	} catch (error) {
		console.error('whatsagent update: failed', error);
		if (!NONINTERACTIVE) {
			dialog.showErrorBox(
				'Update failed',
				`${error instanceof Error ? error.message : String(error)}\n\n` +
					`whatsagent is unchanged and still works. You can install the new version by ` +
					`re-running the install command from the README.`
			);
		}
	}
}

/**
 * Check once, and prompt if there is something newer.
 *
 * Every failure here is non-fatal by construction: a machine that is offline, or
 * behind a proxy, or running against a repo that does not exist yet, must still
 * get a working app. Update checking is the least important thing this process
 * does.
 */
export async function checkForUpdates(parentWindow) {
	if (updateInProgress) return;
	if (!app.isPackaged) {
		console.log('whatsagent update: skipped (not a packaged build)');
		return;
	}
	if (process.platform !== 'darwin') return;

	updateInProgress = true;
	try {
		const autoUpdater = await configureUpdater();
		const result = await autoUpdater.checkForUpdates();
		if (!result?.isUpdateAvailable) {
			console.log(`whatsagent update: ${app.getVersion()} is current`);
			return;
		}
		console.log(`whatsagent update: ${result.updateInfo.version} available`);
		await promptAndUpdate(autoUpdater, result.updateInfo, parentWindow);
	} catch (error) {
		console.warn('whatsagent update: check failed (continuing)', error);
	} finally {
		updateInProgress = false;
	}
}

/** Wire the startup check and the recurring one. Returns a stop function. */
export function startUpdateChecks(getWindow) {
	if (!CHECKS_ENABLED) {
		console.log('whatsagent update: checks disabled by WHATSAGENT_UPDATE_CHECK=0');
		return () => {};
	}

	const first = setTimeout(() => void checkForUpdates(getWindow()), FIRST_CHECK_DELAY_MS);
	const repeat = setInterval(() => void checkForUpdates(getWindow()), CHECK_INTERVAL_MS);
	// Neither timer should hold the event loop open on its own.
	first.unref?.();
	repeat.unref?.();

	return () => {
		clearTimeout(first);
		clearInterval(repeat);
	};
}
