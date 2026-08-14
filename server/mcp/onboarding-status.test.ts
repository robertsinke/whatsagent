import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../index.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { setSetting } from '../store/settings.js';

describe('GET /api/agent/status MCP onboarding (MCPX-5)', () => {
	let dataDir: string;
	let db: AppDatabase;
	let app: App | undefined;

	afterEach(async () => {
		await app?.close();
		db?.close();
		if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	});

	async function start(configure?: (database: AppDatabase) => void) {
		// The owner's real data dir contains a space ("Application Support").
		dataDir = mkdtempSync(join(tmpdir(), 'Application Support-mcp-'));
		db = openDatabase({ dataDir });
		configure?.(db);
		app = createApp({ db, dataDir, port: 0, staticDir: null });
		await app.start();
		return fetch(`${app.url}/api/agent/status`);
	}

	it('reports enabled, entryPath, and dataDir, and never the token', async () => {
		const res = await start((database) => {
			setSetting(database, 'mcp_enabled', 'true');
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mcp: {
				enabled: boolean;
				command: string;
				entryPath: string;
				dataDir: string;
				entryReady: boolean;
			};
		};
		expect(body.mcp.enabled).toBe(true);
		expect(body.mcp.dataDir).toBe(dataDir);
		expect(body.mcp.entryPath).toContain('stdio.js');
		expect(body.mcp.command).toContain('WhatsAgent');
		expect(typeof body.mcp.entryReady).toBe('boolean');

		const dumped = JSON.stringify(body);
		expect(dumped).not.toMatch(/Bearer/);
		expect(dumped).not.toMatch(/[0-9a-fA-F]{32,}/);
		expect(app).toBeDefined();
		const minted = app!.mcp?.token;
		expect(minted).toBeTruthy();
		expect(dumped).not.toContain(minted);
		expect(body).not.toHaveProperty('token');
		expect(body.mcp).not.toHaveProperty('token');
	});

	it('still reports launch paths when the surface is off', async () => {
		const res = await start();
		const body = (await res.json()) as { mcp: { enabled: boolean; dataDir: string } };
		expect(body.mcp.enabled).toBe(false);
		expect(body.mcp.dataDir).toBe(dataDir);
	});
});
