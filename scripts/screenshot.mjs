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
 * This gives a real viewport, real clicks (needed for any multi-step flow),
 * real keyboard events (needed for `:focus-visible`, which programmatic
 * `el.focus()` does not match in headless Chrome), and `Runtime.evaluate` for
 * computed-value assertions in the same pass — which matters because a
 * screenshot proves something rendered, not that it is right.
 *
 *   node scripts/screenshot.mjs <url> <out.png> \
 *     [--eval-before <js>] [--click <selector>]... [--key <KeySpec>]... [--eval <js>]
 *
 * KeySpec examples: Tab, Shift+Tab, Enter, Escape, ArrowRight, Space, a
 * (modifiers: Alt, Ctrl, Meta/Cmd, Shift — joined with `+`). Repeat `--key`
 * for a sequence. Order after navigation: eval-before → clicks → keys → eval.
 *
 * Env: SHOT_WAIT (ms after navigation, default 2500), SHOT_PORT (default 9333),
 *      SHOT_WIDTH / SHOT_HEIGHT (default 1280×900),
 *      SHOT_CLICK_WAIT (ms after each click, default 3000),
 *      SHOT_KEY_WAIT (ms after each key, default 200).
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
const keys = [];
let evalBeforeExpr;
let evalExpr;
/**
 * Settle time after the clicks and keys, before `--eval` and the capture. For
 * states that arrive over the WebSocket on the server's schedule rather than in
 * response to an input — a pushed `draft-updated`, a sync batch — there is
 * nothing to click, so waiting is the only way to photograph them.
 */
let waitMs = 0;
for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === '--click') clicks.push(argv[++i]);
	else if (argv[i] === '--wait') waitMs = Number(argv[++i]);
	else if (argv[i] === '--key') keys.push(argv[++i]);
	else if (argv[i] === '--eval-before') evalBeforeExpr = argv[++i];
	else if (argv[i] === '--eval') evalExpr = argv[++i];
	else positional.push(argv[i]);
}
const [url, out] = positional;
if (!url || !out) {
	console.error(
		'usage: node scripts/screenshot.mjs <url> <out.png> [--eval-before <js>] [--click <sel>]... [--key <KeySpec>]... [--wait <ms>] [--eval <js>]'
	);
	process.exit(2);
}

const PORT = Number(process.env.SHOT_PORT ?? 9333);
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1280);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 900);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'whatsagent-shot-'));

/** Map a KeySpec ("Tab", "Shift+Tab", "ArrowRight", "a") to CDP key fields. */
function parseKeySpec(spec) {
	if (!spec) throw new Error('empty --key value');
	const parts = spec.split('+');
	let modifiers = 0;
	for (const part of parts.slice(0, -1)) {
		const m = part.toLowerCase();
		if (m === 'alt') modifiers |= 1;
		else if (m === 'ctrl' || m === 'control') modifiers |= 2;
		else if (m === 'meta' || m === 'cmd' || m === 'command') modifiers |= 4;
		else if (m === 'shift') modifiers |= 8;
		else throw new Error(`unknown key modifier in ${JSON.stringify(spec)}: ${part}`);
	}
	const raw = parts[parts.length - 1];
	const named = {
		tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
		// text: '\r' is required for Enter to activate a focused <button>
		// (CDP keyDown without text does not fire the default click).
		enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
		return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
		escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
		esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
		space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
		backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
		delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
		arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
		arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
		arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
		arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
		home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
		end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
		pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
		pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }
	};
	const lower = raw.toLowerCase();
	if (named[lower]) {
		return { modifiers, ...named[lower] };
	}
	if (raw.length === 1) {
		const ch = raw;
		const upper = ch.toUpperCase();
		const isLetter = upper >= 'A' && upper <= 'Z';
		const isDigit = ch >= '0' && ch <= '9';
		if (!isLetter && !isDigit) {
			// Punctuation / symbol: still dispatch as a character key.
			return {
				modifiers,
				key: ch,
				code: `Key${upper}`,
				windowsVirtualKeyCode: upper.charCodeAt(0),
				text: ch
			};
		}
		return {
			modifiers,
			key: modifiers & 8 ? upper : ch.toLowerCase(),
			code: isLetter ? `Key${upper}` : `Digit${ch}`,
			windowsVirtualKeyCode: upper.charCodeAt(0),
			text: modifiers & 8 ? upper : ch.toLowerCase()
		};
	}
	throw new Error(`unsupported --key spec: ${JSON.stringify(spec)}`);
}

async function dispatchKey(send, spec) {
	const parsed = parseKeySpec(spec);
	const base = {
		modifiers: parsed.modifiers,
		windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
		nativeVirtualKeyCode: parsed.windowsVirtualKeyCode,
		code: parsed.code,
		key: parsed.key
	};
	// Use keyDown (not rawKeyDown): Tab still moves focus and matches
	// :focus-visible, and Enter/Space fire the button's default activation
	// (rawKeyDown alone does not). Character keys also get a `char` event so
	// text inserts into inputs.
	await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
	if (parsed.text) {
		await send('Input.dispatchKeyEvent', {
			type: 'char',
			...base,
			text: parsed.text,
			unmodifiedText: parsed.text
		});
	}
	await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
	console.log(`key ${spec}`);
}

const chrome = spawn(
	CHROME,
	[
		'--headless=new',
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${profile}`,
		'--no-first-run',
		'--no-default-browser-check',
		// Hidden by default: a scrollbar in a capture is usually noise that shifts
		// layout between shots. But it makes this tool structurally unable to
		// photograph scrollbar work — the visual-evidence gate then cannot see the
		// very thing it is gating. `SHOT_SCROLLBARS=1` opts back in.
		...(process.env.SHOT_SCROLLBARS === '1' ? [] : ['--hide-scrollbars']),
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

	if (evalBeforeExpr) {
		const res = await send('Runtime.evaluate', {
			expression: evalBeforeExpr,
			returnByValue: true
		});
		console.log('eval-before:', JSON.stringify(res.result?.result?.value));
		await sleep(Number(process.env.SHOT_KEY_WAIT ?? 200));
	}

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
		// A click that triggers an SPA state change (selecting a chat) starts an
		// async load, and 1200ms was not enough for it: a following `--eval` ran
		// against a half-hydrated DOM, and twice hung the whole run to its 180s
		// timeout. Configurable, and defaulted high enough for the chat pane.
		await sleep(Number(process.env.SHOT_CLICK_WAIT ?? 3000));
	}

	for (const spec of keys) {
		await dispatchKey(send, spec);
		await sleep(Number(process.env.SHOT_KEY_WAIT ?? 200));
	}

	if (waitMs > 0) {
		console.log(`waiting ${waitMs}ms for server-pushed state`);
		await sleep(waitMs);
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
