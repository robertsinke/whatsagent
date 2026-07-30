import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type App } from '../index.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertChat } from '../store/chats.js';
import { upsertDraft } from '../store/drafts.js';
import { getDraft } from '../store/drafts.js';
import { EventBus } from '../api/events.js';
import { actionRegistry, listActionsForCaller } from '../actions/index.js';
import { mcpTokenPath } from './token.js';
import { isMcpEnabled, mcpOptionOverride, MCP_PATH } from './surface.js';

const REFUSED = [
	'send',
	'approve-draft',
	'react',
	'set-send-mode',
	'set-setting',
	// PL-U3 / PANEL-S5: an agent may *propose* a send; confirming is still the
	// owner's click. Rejecting was opened to tools in PANEL-S5 (withdraw cannot
	// cause a send) and therefore must NOT appear here.
	'confirm-proposal'
] as const;

let dataDir: string | undefined;
let app: App | undefined;
let db: AppDatabase | undefined;

async function startApp(mcp: boolean | { enabled?: boolean; token?: string } = true): Promise<App> {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-'));
	db = openDatabase({ dataDir });
	app = createApp({
		db,
		dataDir,
		events: new EventBus(),
		port: 0,
		host: '127.0.0.1',
		staticDir: null,
		mcp
	});
	await app.start();
	return app;
}

afterEach(async () => {
	await app?.close();
	app = undefined;
	db?.close();
	db = undefined;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
	delete process.env.WHATSAGENT_MCP;
});

async function connectClient(token: string): Promise<Client> {
	const client = new Client({ name: 'whatsagent-mcp-test', version: '0.0.0' });
	const transport = new StreamableHTTPClientTransport(new URL(`${app!.url}${MCP_PATH}`), {
		requestInit: {
			headers: { Authorization: `Bearer ${token}` }
		}
	});
	await client.connect(transport);
	return client;
}

describe('isMcpEnabled', () => {
	it('is off by default', () => {
		expect(isMcpEnabled({}, {})).toBe(false);
		expect(isMcpEnabled(undefined, {})).toBe(false);
	});

	it('enables via options or WHATSAGENT_MCP=1', () => {
		expect(isMcpEnabled({ mcp: true }, {})).toBe(true);
		expect(isMcpEnabled({ mcp: { enabled: true } }, {})).toBe(true);
		expect(isMcpEnabled({}, { WHATSAGENT_MCP: '1' })).toBe(true);
		expect(isMcpEnabled({ mcp: false }, { WHATSAGENT_MCP: '1' })).toBe(false);
	});
});

/**
 * PANEL-S1 — `isMcpEnabled` folds "said no" and "said nothing" into the same
 * `false`, which is right for its question and wrong for the settings
 * fallback: a `panel_enabled` row may switch the surface on when nobody asked,
 * and must never re-open one a caller explicitly shut.
 */
describe('mcpOptionOverride', () => {
	it('distinguishes an explicit answer from no answer at all', () => {
		expect(mcpOptionOverride({})).toBeUndefined();
		expect(mcpOptionOverride(undefined)).toBeUndefined();
		// An object with only a token is still no answer about enablement.
		expect(mcpOptionOverride({ mcp: {} })).toBeUndefined();
		expect(mcpOptionOverride({ mcp: true })).toBe(true);
		expect(mcpOptionOverride({ mcp: false })).toBe(false);
		expect(mcpOptionOverride({ mcp: { enabled: true } })).toBe(true);
		expect(mcpOptionOverride({ mcp: { enabled: false } })).toBe(false);
	});
});

describe('MCP surface — disabled', () => {
	it('404s like an unknown route and does not mint a token file', async () => {
		await startApp(false);
		expect(app!.mcp).toBeNull();
		expect(existsSync(mcpTokenPath(dataDir!))).toBe(false);

		const withOrigin = await fetch(`${app!.url}${MCP_PATH}`, {
			method: 'POST',
			headers: {
				Origin: `http://127.0.0.1:${app!.port}`,
				'Content-Type': 'application/json'
			},
			body: '{}'
		});
		expect(withOrigin.status).toBe(404);

		const unknown = await fetch(`${app!.url}/no-such-route`, {
			method: 'POST',
			headers: {
				Origin: `http://127.0.0.1:${app!.port}`,
				'Content-Type': 'application/json'
			},
			body: '{}'
		});
		expect(unknown.status).toBe(404);
	});
});

describe('MCP surface — auth', () => {
	it('401s on missing and wrong bearer tokens', async () => {
		await startApp({ enabled: true, token: 't'.repeat(64) });
		const url = `${app!.url}${MCP_PATH}`;

		const missing = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
		});
		expect(missing.status).toBe(401);

		const wrong = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer wrong',
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
		});
		expect(wrong.status).toBe(401);
		expect(await missing.json()).toEqual(await wrong.json());
	});

	it('rejects a non-loopback Host even with a valid token', async () => {
		const token = 'h'.repeat(64);
		await startApp({ enabled: true, token });

		const { request } = await import('node:http');
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(
				{
					host: '127.0.0.1',
					port: app!.port,
					path: MCP_PATH,
					method: 'POST',
					headers: {
						Host: `evil.example:${app!.port}`,
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
						Accept: 'application/json, text/event-stream',
						'Content-Length': 2
					}
				},
				(r) => {
					r.resume();
					resolve(r.statusCode ?? 0);
				}
			);
			req.on('error', reject);
			req.end('{}');
		});
		expect(status).toBe(403);
	});

	it('writes the token file at 0600 when enabled', async () => {
		await startApp(true);
		expect(app!.mcp).not.toBeNull();
		const path = app!.mcp!.tokenPath;
		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});

describe('MCP surface — registry tools', () => {
	it('tools/list is exactly listActionsForCaller(tool) and omits refused actions', async () => {
		const token = 'r'.repeat(64);
		await startApp({ enabled: true, token });
		const client = await connectClient(token);
		try {
			const listed = await client.listTools();
			const names = listed.tools.map((t) => t.name).sort();
			const expected = listActionsForCaller(actionRegistry, 'tool')
				.map((a) => a.name)
				.sort();
			expect(names).toEqual(expected);
			// PL-U3: a correctly-declared tool-only action appears here with no
			// edit to this surface. `propose-send` is the proof — it was added to
			// the registry alone. PANEL-S5 opened reject/promote/discard the same way.
			expect(names).toContain('propose-send');
			expect(names).toContain('reject-proposal');
			expect(names).toContain('promote-voice-suggestion');
			expect(names).toContain('discard-voice-suggestion');
			for (const refused of REFUSED) {
				expect(names).not.toContain(refused);
			}
			for (const tool of listed.tools) {
				const action = actionRegistry.get(tool.name)!;
				expect(tool.inputSchema).toMatchObject({
					type: 'object',
					...(action.jsonSchema.properties
						? { properties: action.jsonSchema.properties }
						: {})
				});
			}
		} finally {
			await client.close();
		}
	});

	it('refuses a tool-forbidden action at the dispatcher via tools/call', async () => {
		const token = 'd'.repeat(64);
		await startApp({ enabled: true, token });
		const client = await connectClient(token);
		try {
			const result = await client.callTool({ name: 'send', arguments: { chatJid: 'x', text: 'no' } });
			expect(result.isError).toBe(true);
			const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
			const body = JSON.parse(text) as {
				error: string;
				status: number;
				action: string;
				caller: string;
			};
			expect(body.status).toBe(403);
			expect(body.error).toBe('Caller not permitted');
			expect(body.action).toBe('send');
			expect(body.caller).toBe('tool');
		} finally {
			await client.close();
		}
	});

	it('dispatches a permitted write action (edit-draft) with observable effect', async () => {
		const token = 'w'.repeat(64);
		await startApp({ enabled: true, token });
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: 1
		});
		upsertDraft(db!, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'original',
			original_text: 'original',
			status: 'ready',
			basis_msg_id: 'm1',
			generated_at: Date.now()
		});

		const client = await connectClient(token);
		try {
			const result = await client.callTool({
				name: 'edit-draft',
				arguments: { chatJid: 'alice@s.whatsapp.net', text: 'edited via mcp' }
			});
			expect(result.isError).toBeFalsy();
			expect(getDraft(db!, 'alice@s.whatsapp.net')?.text).toBe('edited via mcp');
		} finally {
			await client.close();
		}
	});
});
