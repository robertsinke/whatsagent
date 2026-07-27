/**
 * Electron main process.
 *
 * The Node backend does not become a sidecar: it *is* the main process. This
 * file starts `server/index.ts`'s existing HTTP server in-process and points a
 * BrowserWindow at it, so `npm run dev` stays byte-identical for contributors
 * and there is exactly one wiring of the runtime to maintain.
 *
 * Two things here are load-bearing for account safety, not preferences:
 *
 *   1. The single-instance lock, taken before anything else. Two copies of this
 *      app means two Baileys sockets on one WhatsApp account, which is the
 *      primary ban risk.
 *   2. The data directory is *always* passed explicitly, and never defaults to
 *      the platform dir that `npm start` uses. An app bundle is not a git
 *      checkout, so `assertNotLiveDbFromWorktree()` takes its "installed copy"
 *      exit and would open the owner's live credentials without complaint.
 */
import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The desktop build's own data directory, deliberately a *different string*
 * from the `whatsagent` directory `npm start` uses.
 *
 * macOS filesystems are case-insensitive by default (verified on this machine:
 * `~/Library/Application Support/WHATSAGENT` resolves to the live directory), so
 * a product name differing only in case would silently share the owner's real
 * credentials with the dev server. A distinct name makes a plain double-click
 * safe by construction rather than by remembering to pass a flag.
 *
 * Sharing a directory between the desktop app and `npm start` is exactly the
 * two-sockets-one-account hazard, so they should not converge on one without a
 * deliberate migration — see OSS-P3.4.
 */
const DESKTOP_DIR_NAME = 'whatsagent-desktop';

/**
 * Find the application root by searching upward for the artifacts that must be
 * there, rather than counting `..` hops.
 *
 * This module tree has had three layouts — `server/` in source,
 * `dist/server/server/` compiled, and now `app.asar/` packaged — and both
 * previous hop-counting call sites broke *silently* on the second one, one of
 * them being the guard against opening the live database. Landmark search is
 * depth-independent, and listing what it searched turns the next repackaging
 * into a loud failure instead of a blank window.
 */
function resolveAppRoot() {
	const searched = [];
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		searched.push(dir);
		const spa = join(dir, 'build', 'index.html');
		const server = join(dir, 'dist', 'server', 'server', 'index.js');
		if (existsSync(spa) && existsSync(server)) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		'Could not locate the app root (an ancestor holding both build/index.html ' +
			'and dist/server/server/index.js).\n' +
			'Run `npm run build` before packaging or starting Electron.\n' +
			`Searched:\n  ${searched.join('\n  ')}\n`
	);
}

const appRoot = resolveAppRoot();

// Imported by path rather than by a `../dist/...` specifier so a broken layout
// surfaces as resolveAppRoot()'s message naming what it searched, instead of an
// ERR_MODULE_NOT_FOUND. This module is deliberately free of side effects and of
// index.ts's argv self-start guard, so it is safe to load before app.whenReady().
const { resolveDataDirOverride } = await import(
	pathToFileURL(join(appRoot, 'dist', 'server', 'server', 'data-dir.js')).href
);

// An explicit override (env or --data-dir) still wins, so a throwaway run is
// possible without rebuilding. Absent one, this is a directory of our own.
const dataDir = resolveDataDirOverride() ?? join(app.getPath('appData'), DESKTOP_DIR_NAME);

// Point Electron's own state (cache, local storage, the singleton lock file) at
// the same directory. Two instances on different data dirs then genuinely do
// not share anything, and the whole app state is one directory to delete.
app.setPath('userData', dataDir);

// Taken immediately after userData is set and long before app.whenReady(): a
// second launch must be rejected before it can reach openDatabase(), not after.
// Because the lock lives in userData, it is scoped to the *data directory* —
// which is the thing that must not be shared. Two instances on one directory
// means two Baileys sockets on one WhatsApp account, the primary ban risk;
// two instances on different directories are two devices and are fine.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
	console.warn(`whatsagent is already running on ${dataDir}; exiting this instance.`);
	app.exit(0);
}

/** The running App from server/index.ts, or undefined before start / after quit. */
let server;
let window;

function createWindow(url) {
	window = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 900,
		minHeight: 600,
		title: 'whatsagent',
		backgroundColor: '#e8ebf0',
		// Standard title bar, deliberately. `hiddenInset` puts the traffic lights
		// on top of the SPA's own header, where they overlap the "WhatsAgent"
		// wordmark — the app header starts its content at x=0 because in a browser
		// tab nothing else is there. Reserving that space is a renderer change and
		// belongs with the first-run UI work (OSS-P3.4), not with packaging.
		show: false,
		webPreferences: {
			// The renderer is the same SPA the browser loads over HTTP. It has no
			// preload bridge and no Node access — everything goes through the
			// loopback REST/WS API, which keeps the Origin checks meaningful.
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true
		}
	});

	window.once('ready-to-show', () => window?.show());
	// Anything that is not our loopback origin belongs in the user's browser,
	// not in a chrome-less window inside the app.
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: 'deny' };
	});
	window.on('closed', () => {
		window = undefined;
	});

	void window.loadURL(url);
}

app.whenReady().then(async () => {
	// Imported here rather than at module scope so the single-instance loser
	// exits before this graph (Baileys, better-sqlite3) is ever loaded.
	const { startServer } = await import(
		pathToFileURL(join(appRoot, 'dist', 'server', 'server', 'index.js')).href
	);

	server = await startServer({
		dataDir,
		// Passed explicitly rather than trusting defaultStaticDir()'s search. The
		// search would very likely find it inside the asar too, but "very likely"
		// is what produced the last two path bugs.
		staticDir: join(appRoot, 'build'),
		// Ephemeral: the packaged app must never fight a contributor's `npm run
		// dev` for 8787. The allowed-origin set is built from the port actually
		// bound, so the renderer's Origin still matches.
		port: 0,
		host: '127.0.0.1'
	});

	console.log(`whatsagent desktop: PATH=${process.env.PATH ?? '(unset)'}`);
	createWindow(server.url);

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0 && server) createWindow(server.url);
	});
});

app.on('second-instance', () => {
	if (!window) return;
	if (window.isMinimized()) window.restore();
	window.focus();
});

// macOS convention keeps an app alive with no windows, but this one owns a
// WhatsApp socket and a paced outbox — leaving those running behind a closed
// window is a surprise the owner did not ask for.
app.on('window-all-closed', () => app.quit());

let closing = false;
app.on('before-quit', (event) => {
	if (closing || !server) return;
	// Close the socket and the database before the process dies, so the WAL is
	// checkpointed and the outbox stops mid-flight rather than mid-write.
	closing = true;
	event.preventDefault();
	const current = server;
	server = undefined;
	current
		.close()
		.catch((error) => console.error('whatsagent desktop: shutdown failed', error))
		.finally(() => app.quit());
});
