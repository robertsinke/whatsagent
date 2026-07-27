/**
 * Capture visual evidence from a headless Chrome over CDP.
 *
 * Why a dedicated script rather than an editor/agent screenshot helper: the one
 * used here previously failed two ways, and the second was silent — it returned
 * a *valid* 406-byte PNG of a 1×1 viewport, because its browser panel was never
 * mounted so `innerWidth === 1`. Nothing errored; you got a grey square and no
 * signal, and any "did somebody look at this?" review step accepted it. A blank
 * that passes is worse than a failure that bounces.
 *
 * This gives a real viewport, real clicks (needed for any multi-step flow), and
 * `Runtime.evaluate` for computed-value assertions in the same pass — which
 * matters because a screenshot proves something rendered, not that it is right.
 *
 *   node scripts/screenshot.mjs <url> <out.png> [--click <selector>]... [--eval <js>]
 *
 * Env: SHOT_WAIT (ms after navigation, default 2500), SHOT_PORT (default 9333),
 *      SHOT_WIDTH / SHOT_HEIGHT (default 1280×900).
 *
 * Point it at `npm run preview:ui` (throwaway DB, no WhatsApp socket) — never at
 * a real backend.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'package.json'));
const WebSocket = require('ws');

const argv = process.argv.slice(2);
const positional = [];
const clicks = [];
let evalExpr;
for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === '--click') clicks.push(argv[++i]);
	else if (argv[i] === '--eval') evalExpr = argv[++i];
	else positional.push(argv[i]);
}
const [url, out] = positional;
if (!url || !out) {
	console.error('usage: node scripts/screenshot.mjs <url> <out.png> [--click <sel>]... [--eval <js>]');
	process.exit(2);
}

const PORT = Number(process.env.SHOT_PORT ?? 9333);
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1280);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 900);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'whatsagent-shot-'));

const chrome = spawn(
	CHROME,
	[
		'--headless=new',
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${profile}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--hide-scrollbars',
		`--window-size=${WIDTH},${HEIGHT}`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtoolsUp() {
	for (let i = 0; i < 60; i += 1) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if ((await res.json()).webSocketDebuggerUrl) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error(`Chrome devtools endpoint never came up on ${PORT}`);
}

let exitCode = 0;
try {
	await devtoolsUp();
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const page = targets.find((t) => t.type === 'page');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r) => ws.once('open', r));

	let id = 0;
	const pending = new Map();
	ws.on('message', (raw) => {
		const msg = JSON.parse(raw.toString());
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		}
	});
	const send = (method, params = {}) => {
		const msgId = ++id;
		ws.send(JSON.stringify({ id: msgId, method, params }));
		return new Promise((resolve) => pending.set(msgId, resolve));
	};

	await send('Page.enable');
	await send('Runtime.enable');
	// Without this the screenshot is whatever Chrome's default window happens to
	// be. deviceScaleFactor 2 matches a retina capture, so text is legible.
	await send('Emulation.setDeviceMetricsOverride', {
		width: WIDTH,
		height: HEIGHT,
		deviceScaleFactor: 2,
		mobile: false
	});
	await send('Page.navigate', { url });
	await sleep(Number(process.env.SHOT_WAIT ?? 2500));

	for (const selector of clicks) {
		// NOTE: `el.click()` does NOT open a bits-ui Select — those listen for
		// pointerdown, so a synthetic click is a silent no-op that reads as a
		// broken control. Dispatch real mouse events via Input.dispatchMouseEvent
		// when you need a picker open.
		const res = await send('Runtime.evaluate', {
			expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'MISSING ' + ${JSON.stringify(selector)}; el.click(); return 'clicked ' + ${JSON.stringify(selector)}; })()`,
			returnByValue: true
		});
		console.log(res.result?.result?.value);
		await sleep(1200);
	}

	if (evalExpr) {
		const res = await send('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
		console.log('eval:', JSON.stringify(res.result?.result?.value));
	}

	// Guard against the exact failure this script exists to replace: assert a
	// real viewport before trusting the capture.
	const vp = await send('Runtime.evaluate', {
		expression: 'JSON.stringify({w: innerWidth, h: innerHeight})',
		returnByValue: true
	});
	const { w } = JSON.parse(vp.result?.result?.value ?? '{"w":0}');
	if (w < 200) throw new Error(`Viewport is ${w}px wide — the capture would be a blank.`);

	const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
	writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
	console.log(`wrote ${out} (viewport ${w}px)`);
	ws.close();
} catch (err) {
	console.error('screenshot failed:', err);
	exitCode = 1;
} finally {
	chrome.kill();
	// Chrome is still unlinking its own profile as we exit, so this races and can
	// throw ENOTEMPTY *after* a perfectly good PNG was written. Never let cleanup
	// turn a successful capture into a failure — the dir is under the OS temp
	// root either way.
	try {
		rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		/* the OS will reap it */
	}
	process.exit(exitCode);
}
