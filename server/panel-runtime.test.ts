import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentPart } from '../shared/agent-events.js';
import type { ServerEvent } from './api/events.js';
import { EventBus } from './api/events.js';
import { MCP_PATH } from './mcp/surface.js';
import { mcpTokenPath } from './mcp/token.js';
import { openDatabase, type AppDatabase } from './store/db.js';
import { getSetting } from './store/settings.js';
import { createApp, type App, type CreateAppOptions } from './index.js';

/**
 * PANEL-S2 — the Settings toggle takes effect on the next request, not the next
 * launch.
 *
 * WHY A MOCKED `createPanelHarness`. A settings-born panel has no injectable
 * harness by design — the whole point is that the owner's rows produce it — so
 * a real one would spawn `opencode` on the first turn. The mock replaces only
 * the binary-spawning factory; `PanelSessionManager`, `createMcpSurface`,
 * `ensureMcpToken` and the reconcile in `createApp` are all the real thing,
 * which is what these assertions are about.
 */
const spawned: { harness: string; token: string; model?: string }[] = [];

vi.mock('./agent/panel/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./agent/panel/index.js')>();
	return {
		...actual,
		createPanelHarness(options: { harness: string; token: string; model?: string }) {
			spawned.push({
				harness: options.harness,
				token: options.token,
				...(options.model === undefined ? {} : { model: options.model })
			});
			return {
				id: options.harness,
				run(turn: { sessionId: string; messageId: string }, signal: AbortSignal) {
					return (async function* (): AsyncGenerator<AgentPart> {
						yield {
							kind: 'text',
							sessionId: turn.sessionId,
							messageId: turn.messageId,
							partId: `${turn.messageId}-t`,
							text: 'thinking'
						};
						// Hang until aborted — a turn that is still running is the only
						// way to prove a disable cancels one.
						await new Promise<void>((resolve) => {
							if (signal.aborted) return resolve();
							signal.addEventListener('abort', () => resolve(), { once: true });
						});
					})();
				}
			};
		}
	};
});

let dataDir: string | undefined;
let db: AppDatabase | undefined;
let app: App | undefined;
let events: EventBus | undefined;
let seen: ServerEvent[] = [];

async function startApp(options: Partial<CreateAppOptions> = {}): Promise<App> {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-panel-s2-'));
	db = openDatabase({ dataDir });
	events = new EventBus();
	seen = [];
	events.subscribe((event) => seen.push(event));
	app = createApp({ db, dataDir, events, port: 0, host: '127.0.0.1', staticDir: null, ...options });
	await app.start();
	return app;
}

/** The owner's own write path: PUT /api/settings → `set-setting` → reconcile. */
async function putSetting(key: string, value: string): Promise<Response> {
	return fetch(`${app!.url}/api/settings`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', Origin: app!.url },
		body: JSON.stringify({ key, value })
	});
}

async function enablePanel(harness = 'opencode'): Promise<void> {
	expect((await putSetting('panel_harness', harness)).status).toBe(200);
	expect((await putSetting('panel_enabled', 'true')).status).toBe(200);
}

async function agentStatus(): Promise<{ available: boolean; running: boolean; harness: string | null }> {
	const res = await fetch(`${app!.url}/api/agent/status`);
	return (await res.json()) as { available: boolean; running: boolean; harness: string | null };
}

/**
 * Raw probe: 404 is "no such route" (surface off), 401 is "surface on, bearer
 * missing". The Origin header is what the SPA sends, and without it a mutating
 * request is refused with 403 before the route is ever matched — which would
 * make a disabled surface indistinguishable from an enabled one.
 */
async function mcpProbeStatus(): Promise<number> {
	const res = await fetch(`${app!.url}${MCP_PATH}`, {
		method: 'POST',
		headers: {
			Origin: app!.url,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
	});
	await res.arrayBuffer();
	return res.status;
}

async function startTurn(text = 'do it'): Promise<Response> {
	return fetch(`${app!.url}/api/agent/turn`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: app!.url },
		body: JSON.stringify({ text })
	});
}

function turnEvents(phase: 'started' | 'finished') {
	return seen.filter((e) => e.type === 'agent-turn' && e.phase === phase);
}

/** Let the manager's async drive loop run — `start()` returns before it spawns. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
	await app?.close();
	app = undefined;
	db = undefined;
	events = undefined;
	spawned.length = 0;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
	delete process.env.WHATSAGENT_MCP;
	vi.restoreAllMocks();
});

describe('PANEL-S2 — enabling the panel from Settings', () => {
	it('arms /mcp and the panel runtime on the same process, with no restart', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		expect((await agentStatus()).available).toBe(false);
		expect(await mcpProbeStatus()).toBe(404);
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(false);

		await enablePanel('opencode');

		// The same app object, never recreated — this is what "no restart" means.
		expect((await agentStatus()).available).toBe(true);
		expect(await mcpProbeStatus()).toBe(401);
		expect(app!.mcp).not.toBeNull();

		// A surface armed live must be identical to one armed at boot: same mint,
		// same 0600 file, same bearer + Host validation. It is the same code, and
		// this is the assertion that keeps it that way.
		const path = mcpTokenPath(dataDir!);
		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);

		const client = new Client({ name: 'panel-s2-test', version: '0.0.0' });
		const transport = new StreamableHTTPClientTransport(new URL(`${app!.url}${MCP_PATH}`), {
			requestInit: { headers: { Authorization: `Bearer ${app!.mcp!.token}` } }
		});
		await client.connect(transport);
		try {
			const listed = await client.listTools();
			expect(listed.tools.length).toBeGreaterThan(0);
			// The tool surface is still derived, and still excludes the actions the
			// registry refuses a tool caller.
			expect(listed.tools.map((t) => t.name)).not.toContain('set-setting');
		} finally {
			await client.close();
		}
	});

	it('arms nothing and writes no token when the enabled row names no harness', async () => {
		delete process.env.WHATSAGENT_MCP;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await startApp();
		expect((await putSetting('panel_enabled', 'true')).status).toBe(200);

		expect((await agentStatus()).available).toBe(false);
		expect(await mcpProbeStatus()).toBe(404);
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(false);
		// The warning still explains which row is wrong; it no longer tells the
		// owner to restart, because restarting would land in the same state.
		const warned = warn.mock.calls.flat().join(' ');
		expect(warned).toMatch(/panel_harness/);
		expect(warned).not.toMatch(/restart/i);
	});

	it('arms nothing when the harness id is one this build does not have', async () => {
		delete process.env.WHATSAGENT_MCP;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await startApp();
		// `set-setting` validates the closed domain, so the only way to a bad row
		// is one written by an older build or by hand.
		db!.prepare("INSERT INTO settings (key, value) VALUES ('panel_harness', 'codex')").run();
		expect((await putSetting('panel_enabled', 'true')).status).toBe(200);

		expect((await agentStatus()).available).toBe(false);
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(false);
		expect(warn.mock.calls.flat().join(' ')).toMatch(/"codex"/);
	});
});

describe('PANEL-S2 — disabling the panel from Settings', () => {
	it('cancels the in-flight turn, closes /mcp, and removes the token', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		await enablePanel('opencode');

		const started = await startTurn();
		expect(started.status).toBe(202);
		await settle();
		expect(turnEvents('started')).toHaveLength(1);
		expect(turnEvents('finished')).toHaveLength(0);
		expect((await agentStatus()).running).toBe(true);

		expect((await putSetting('panel_enabled', 'false')).status).toBe(200);
		await settle();

		// A running turn must not outlive the toggle: the harness process is
		// aborted, and the turn reports itself finished rather than hanging.
		expect(turnEvents('finished')).toHaveLength(1);
		// Disable must actually disable — the route is gone, not merely the field.
		expect(await mcpProbeStatus()).toBe(404);
		expect((await agentStatus()).available).toBe(false);
		expect((await startTurn()).status).toBe(503);
		expect(app!.mcp).toBeNull();
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(false);
	});

	/**
	 * MCPX-2 — THE HAZARD, as a test.
	 *
	 * Before the split, `mcpEnabled` followed `panel_enabled`, so this exact
	 * sequence ran `removeMcpTokenFile(dataDir)` and deleted the credential the
	 * owner's external Claude Code session was configured with. No error, no
	 * event, nothing in the UI — the next external call simply 404'd. The panel
	 * still goes away here; the surface must not.
	 */
	it('turning the panel off leaves an independently-enabled /mcp armed, token and all', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		expect((await putSetting('mcp_enabled', 'true')).status).toBe(200);
		await enablePanel('opencode');
		const token = app!.mcp!.token;
		const tokenPath = mcpTokenPath(dataDir!);
		expect(existsSync(tokenPath)).toBe(true);

		expect((await putSetting('panel_enabled', 'false')).status).toBe(200);
		await settle();

		// The panel is gone — that is what the owner asked for.
		expect((await agentStatus()).available).toBe(false);
		// The surface is not. 401 means the route is still mounted and merely
		// wants a bearer; 404 would mean it had been torn down.
		expect(await mcpProbeStatus()).toBe(401);
		expect(app!.mcp).not.toBeNull();
		// The credential survived, unrotated: an external session already holding
		// this token keeps working, which is the whole point.
		expect(app!.mcp!.token).toBe(token);
		expect(existsSync(tokenPath)).toBe(true);
	});

	it('turning mcp_enabled off closes the surface without a restart', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		expect((await putSetting('mcp_enabled', 'true')).status).toBe(200);
		// Proves RUNTIME_SETTINGS in `set-setting` includes the row: without it the
		// write would persist and the surface would stay exactly as it was.
		expect(await mcpProbeStatus()).toBe(401);
		expect(getSetting(db!, 'mcp_enabled')).toBe('true');

		expect((await putSetting('mcp_enabled', 'false')).status).toBe(200);
		await settle();
		expect(await mcpProbeStatus()).toBe(404);
		expect(app!.mcp).toBeNull();
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(false);
	});

	it('re-enabling mints a fresh token, and the old one no longer authenticates', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		await enablePanel('opencode');
		const first = app!.mcp!.token;

		expect((await putSetting('panel_enabled', 'false')).status).toBe(200);
		expect((await putSetting('panel_enabled', 'true')).status).toBe(200);
		const second = app!.mcp!.token;
		expect(second).not.toBe(first);

		const stale = await fetch(`${app!.url}${MCP_PATH}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${first}`,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
		});
		await stale.arrayBuffer();
		expect(stale.status).toBe(401);
	});
});

describe('PANEL-S2 — reconfiguring while enabled', () => {
	it('rebuilds so the next turn uses the new harness', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		await enablePanel('opencode');
		const first = await startTurn();
		expect(((await first.json()) as { harness: string }).harness).toBe('opencode');
		await settle();
		expect(spawned.map((s) => s.harness)).toEqual(['opencode']);

		expect((await putSetting('panel_harness', 'claude')).status).toBe(200);
		await settle();

		const second = await startTurn();
		expect(second.status).toBe(202);
		expect(((await second.json()) as { harness: string }).harness).toBe('claude');
		await settle();
		// A rebuilt panel builds its harness afresh — it is never the old one with
		// a new label, and it is handed the token that is valid right now.
		expect(spawned.map((s) => s.harness)).toEqual(['opencode', 'claude']);
		expect(spawned[1]!.token).toBe(app!.mcp!.token);
	});

	it('carries the model row into the harness the next turn spawns', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		await enablePanel('opencode');
		expect((await putSetting('panel_model', 'second-model')).status).toBe(200);

		expect((await startTurn()).status).toBe(202);
		await settle();
		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.model).toBe('second-model');
	});

	it('leaves an unchanged row alone — no rebuild, no cancelled turn', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp();
		await enablePanel('opencode');
		const token = app!.mcp!.token;
		expect((await startTurn()).status).toBe(202);
		await settle();

		// Same value written again (the UI's Save button is not idempotency-aware).
		expect((await putSetting('panel_enabled', 'true')).status).toBe(200);
		await settle();

		expect(turnEvents('finished')).toHaveLength(0);
		expect((await agentStatus()).running).toBe(true);
		expect(app!.mcp!.token).toBe(token);
	});
});

describe('PANEL-S2 — the developer paths still win', () => {
	it('never re-opens a surface an explicit mcp:false shut', async () => {
		delete process.env.WHATSAGENT_MCP;
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await startApp({ mcp: false });
		await enablePanel('opencode');

		expect(await mcpProbeStatus()).toBe(404);
		expect((await agentStatus()).available).toBe(false);
		expect(app!.mcp).toBeNull();
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(false);
		// The row is still persisted — the override suppresses the runtime, not
		// the owner's preference.
		expect(getSetting(db!, 'panel_enabled')).toBe('true');
	});

	it('keeps a WHATSAGENT_MCP=1 surface open when the owner switches the panel off', async () => {
		process.env.WHATSAGENT_MCP = '1';
		await startApp();
		await enablePanel('opencode');
		expect((await agentStatus()).available).toBe(true);

		expect((await putSetting('panel_enabled', 'false')).status).toBe(200);
		// The panel follows the row; the surface follows the env var that opened
		// it. Tearing down `/mcp` here would break a dev run the row never armed.
		expect((await agentStatus()).available).toBe(false);
		expect(await mcpProbeStatus()).toBe(401);
		expect(app!.mcp).not.toBeNull();
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(true);
	});

	it('does not disturb an explicit panel option, or cancel its running turn', async () => {
		delete process.env.WHATSAGENT_MCP;
		await startApp({ mcp: true, panel: { harness: 'claude' } });
		expect((await agentStatus()).available).toBe(true);
		expect((await startTurn()).status).toBe(202);
		await settle();

		expect((await putSetting('panel_enabled', 'false')).status).toBe(200);
		await settle();

		// A developer flag is not a saved preference: rows it never wrote must not
		// reconfigure it, and must not kill a turn it is in the middle of.
		expect(turnEvents('finished')).toHaveLength(0);
		expect((await agentStatus())).toMatchObject({ available: true, running: true });
		expect(await mcpProbeStatus()).toBe(401);
	});
});
