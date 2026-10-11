import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp, type App } from '../index.js';
import { actionRegistry, listActionsForCaller } from '../actions/index.js';
import { EventBus } from '../api/events.js';
import { upsertChat } from '../store/chats.js';
import { codeSchemaVersion, openDatabase, type AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import { listOutbox } from '../store/outbox.js';
import { setSetting } from '../store/settings.js';
import { MCP_ENABLED_SETTING } from '../store/settings.js';
import { resolveImportGraph } from './import-graph.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const ENTRY = join(REPO_ROOT, 'server', 'mcp', 'stdio.ts');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/** Generous: the first spawn pays tsx's transpile cost plus an MCP handshake. */
const SPAWN_TIMEOUT_MS = 40_000;

const ALICE = 'alice@s.whatsapp.net';

let dataDir: string | undefined;
let db: AppDatabase | undefined;
let app: App | undefined;
let clients: Client[] = [];

/**
 * A paired-looking data dir: migrated schema, `mcp_enabled` on, one 1:1 chat
 * with a ready draft.
 */
function seedDataDir(options: { mcpEnabled?: boolean } = {}): string {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-stdio-'));
	db = openDatabase({ dataDir });
	setSetting(db, MCP_ENABLED_SETTING, options.mcpEnabled === false ? 'false' : 'true');
	upsertChat(db, { jid: ALICE, kind: '1:1', name: 'Alice', last_msg_at: 1 });
	upsertDraft(db, {
		chat_jid: ALICE,
		text: 'original',
		original_text: 'original',
		status: 'ready',
		basis_msg_id: 'm1',
		generated_at: Date.now()
	});
	return dataDir;
}

/**
 * Spawn the entry point under `tsx` and complete the MCP handshake.
 *
 * Deliberately the TypeScript source rather than `dist/server/...`: `npm test`
 * runs before `npm run build` in this repo's gate, so a test that requires a
 * compiled artefact would be green or red depending on what a previous command
 * left on disk. The asar/compiled path is exercised by
 * `scripts/smoke-packaged-app.mjs`, which is where it actually matters.
 */
async function connect(dir: string): Promise<Client> {
	const client = new Client({ name: 'stdio-test', version: '0.0.1' });
	await client.connect(
		new StdioClientTransport({
			command: TSX,
			args: [ENTRY, '--data-dir', dir],
			stderr: 'pipe'
		})
	);
	clients.push(client);
	return client;
}

/** Run the entry to completion and capture its stderr and exit code. */
function runToExit(dir: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(TSX, [ENTRY, '--data-dir', dir], {
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('error', rejectRun);
		child.on('exit', (code) => {
			resolveRun({ code, stderr });
		});
		// Nothing on stdin: a healthy server would sit waiting, so any exit
		// inside the test timeout is the refusal we are asserting on.
		setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS - 5_000).unref();
	});
}

function textOf(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
	return content.map((c) => c.text ?? '').join('');
}

afterEach(async () => {
	for (const client of clients) await client.close().catch(() => {});
	clients = [];
	if (app) await app.close();
	app = undefined;
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('mcp stdio entry point', () => {
	it(
		'serves the full registry tool list headless, with no app running',
		async () => {
			const dir = seedDataDir();
			const client = await connect(dir);

			const listed = (await client.listTools()).tools.map((t) => t.name).sort();
			const expected = listActionsForCaller(actionRegistry, 'tool')
				.map((a) => a.name)
				.sort();
			expect(listed).toEqual(expected);
			expect(client.getInstructions() ?? '').toContain('WhatsAgent is CLOSED');
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'writes through to the database headless — a real server, not a handshake',
		async () => {
			const dir = seedDataDir();
			const client = await connect(dir);

			await client.callTool({
				name: 'edit-draft',
				arguments: { chatJid: ALICE, text: 'edited while the app was closed' }
			});

			expect(getDraft(db!, ALICE)?.text).toBe('edited while the app was closed');
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'R9 headless — send is refused and the outbox stays empty',
		async () => {
			const dir = seedDataDir();
			const client = await connect(dir);

			const result = await client.callTool({
				name: 'send',
				arguments: { chatJid: ALICE, text: 'this must never go on the wire' }
			});

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('403');
			// The load-bearing assertion: not the response shape, the absence of a row.
			expect(listOutbox(db!)).toHaveLength(0);
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'R9 attached — send is refused through the running app and the outbox stays empty',
		async () => {
			const dir = seedDataDir();
			app = createApp({
				db: db!,
				dataDir: dir,
				events: new EventBus(),
				port: 0,
				host: '127.0.0.1',
				staticDir: null,
				mcp: true
			});
			await app.start();

			const client = await connect(dir);
			expect(client.getInstructions() ?? '').toContain('WhatsAgent is open right now');

			const result = await client.callTool({
				name: 'send',
				arguments: { chatJid: ALICE, text: 'this must never go on the wire' }
			});

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('403');
			expect(listOutbox(db!)).toHaveLength(0);
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'prefers the running app — the write lands in the app process, which emits',
		async () => {
			const dir = seedDataDir();
			const events = new EventBus();
			const seen: string[] = [];
			events.subscribe((event) => seen.push(event.type));
			app = createApp({
				db: db!,
				dataDir: dir,
				events,
				port: 0,
				host: '127.0.0.1',
				staticDir: null,
				mcp: true
			});
			await app.start();

			const client = await connect(dir);
			await client.callTool({
				name: 'edit-draft',
				arguments: { chatJid: ALICE, text: 'via the live app' }
			});

			// A headless write would touch the same rows but could not reach this
			// process's bus — the emission is the proof of which process wrote.
			expect(seen).toContain('draft-updated');
			expect(getDraft(db!, ALICE)?.text).toBe('via the live app');
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'switches headless → attached when the app starts mid-session',
		async () => {
			const dir = seedDataDir();
			const client = await connect(dir);
			expect((await client.listTools()).tools.length).toBeGreaterThan(0);

			const events = new EventBus();
			const seen: string[] = [];
			events.subscribe((event) => seen.push(event.type));
			app = createApp({
				db: db!,
				dataDir: dir,
				events,
				port: 0,
				host: '127.0.0.1',
				staticDir: null,
				mcp: true
			});
			await app.start();

			await client.callTool({
				name: 'edit-draft',
				arguments: { chatJid: ALICE, text: 'after the app came up' }
			});

			expect(seen).toContain('draft-updated');
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'answers socket-dependent tools instead of hiding them',
		async () => {
			const dir = seedDataDir();
			const client = await connect(dir);

			// The tool is present in the list (asserted above) AND answers with the
			// cause named — a tool that vanished between sessions would be harder
			// for a client to reason about than one that refuses clearly.
			const media = await client.callTool({
				name: 'deepen-history',
				arguments: { chatJid: ALICE }
			});
			expect(media.isError).toBe(true);
			expect(textOf(media)).toContain('requires the WhatsAgent app to be open');

			// `open-chat` succeeds, and says plainly that nothing was focused —
			// claiming otherwise is a lie the agent would repeat to the owner.
			const opened = await client.callTool({ name: 'open-chat', arguments: { chatJid: ALICE } });
			expect(opened.isError).toBeFalsy();
			expect(JSON.parse(textOf(opened))).toMatchObject({ jid: ALICE, focused: false });
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'refuses a database behind this build, and writes nothing to it',
		async () => {
			const dir = seedDataDir();
			const behind = codeSchemaVersion();
			db!.prepare('DELETE FROM schema_version WHERE version = ?').run(behind);
			const tablesBefore = tableNames(db!);
			// Close before spawning, and re-open after. An open handle serves its
			// own WAL snapshot, so asserting through it could report "unchanged"
			// about a database the child had in fact migrated — which would make
			// the strongest assertion in this suite the one most able to lie.
			db!.close();

			const { code, stderr } = await runToExit(dir);

			expect(code).toBe(1);
			expect(stderr).toContain('Launch WhatsAgent once so it can migrate');
			db = openDatabase({ dataDir: dir, migrate: false });
			expect(recordedVersion(db)).toBe(behind - 1);
			expect(tableNames(db)).toEqual(tablesBefore);
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'refuses a database newer than this build',
		async () => {
			const dir = seedDataDir();
			db!.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
				codeSchemaVersion() + 1,
				Date.now()
			);

			const { code, stderr } = await runToExit(dir);

			expect(code).toBe(1);
			expect(stderr).toContain('newer than this entry point');
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'refuses when mcp_enabled is off',
		async () => {
			const dir = seedDataDir({ mcpEnabled: false });

			const { code, stderr } = await runToExit(dir);

			expect(code).toBe(1);
			expect(stderr).toContain('External agents (MCP)');
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'stops a live headless session when mcp_enabled is switched off',
		async () => {
			const dir = seedDataDir();
			const client = await connect(dir);

			await client.callTool({
				name: 'edit-draft',
				arguments: { chatJid: ALICE, text: 'while external agents were on' }
			});
			expect(getDraft(db!, ALICE)?.text).toBe('while external agents were on');

			setSetting(db!, MCP_ENABLED_SETTING, 'false');

			await expect(
				client.callTool({
					name: 'edit-draft',
					arguments: { chatJid: ALICE, text: 'must not land after the switch' }
				})
			).rejects.toThrow(/External agents \(MCP\)/);
			expect(getDraft(db!, ALICE)?.text).toBe('while external agents were on');
		},
		SPAWN_TIMEOUT_MS
	);

	it(
		'refuses a data dir with no database, creating nothing',
		async () => {
			const empty = mkdtempSync(join(tmpdir(), 'whatsagent-stdio-empty-'));
			try {
				const { code, stderr } = await runToExit(empty);
				expect(code).toBe(1);
				expect(stderr).toContain('no WhatsAgent data at');
				expect(readdirNames(empty)).toEqual([]);
			} finally {
				rmSync(empty, { recursive: true, force: true });
			}
		},
		SPAWN_TIMEOUT_MS
	);

	it('never carries the bearer token in a startup failure', async () => {
		const dir = seedDataDir({ mcpEnabled: false });
		const { stderr } = await runToExit(dir);
		expect(stderr).not.toMatch(/Bearer/i);
		expect(stderr).not.toMatch(/[0-9a-f]{32,}/i);
	}, SPAWN_TIMEOUT_MS);
});

/**
 * The no-Baileys invariant, enforced by the import graph rather than by a
 * comment in `stdio.ts`.
 *
 * The entry point passes an explicit `dataDir` to `openDatabase`, which disarms
 * `assertNotLiveDbFromWorktree` — and that guard exists to stop a second Baileys
 * socket landing on the owner's personal account. What replaces it is this:
 * nothing reachable from `stdio.ts` can construct a channel.
 *
 * The walker follows RUNTIME edges only. `import type` / `export type`
 * statements are erased by TypeScript and cannot pull a module in at runtime,
 * and skipping them is load-bearing rather than a convenience: `surface.ts` has
 * `import type { RoutesDeps } from '../api/routes.js'`, and `routes.ts` does
 * reach `server/channels/whatsapp/`. Following that edge would report Baileys
 * for a specifier that does not survive compilation.
 */
describe('mcp stdio import graph', () => {
	it('cannot reach baileys or the WhatsApp channel', () => {
		const graph = resolveImportGraph(ENTRY);

		expect([...graph.packages]).not.toContain('baileys');
		expect([...graph.files].filter((f) => f.includes('/channels/whatsapp/'))).toEqual([]);
		expect([...graph.files].filter((f) => f.endsWith('/server/index.ts'))).toEqual([]);
	});

	it('the walker is not vacuous — it finds baileys where baileys really is', () => {
		const graph = resolveImportGraph(join(REPO_ROOT, 'server', 'channels', 'whatsapp', 'ingest.ts'));
		// `ingest.ts` reaches baileys only transitively, so a green result here
		// proves the walker resolves edges rather than merely reading one file.
		expect([...graph.packages]).toContain('baileys');
	});
});

function recordedVersion(database: AppDatabase): number {
	const row = database.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
		v: number | null;
	};
	return row.v ?? 0;
}

function tableNames(database: AppDatabase): string[] {
	return (
		database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[]
	).map((r) => r.name);
}

function readdirNames(dir: string): string[] {
	return readdirSync(dir);
}
