#!/usr/bin/env node
/**
 * Production smoke test for the compiled server (no tsx at runtime).
 *
 * Runs against the BUILT server at dist/server/server/index.js, not source.
 * Opens a throwaway temp database (never the live WhatsApp DB), starts the app
 * with no channel (no WhatsApp socket), then asserts:
 *   - the HTTP API responds (GET /api/health)
 *   - the built SPA is served at /
 *   - migrations applied on the fresh DB (schema_version row count == MIGRATIONS.length)
 *
 * Usage: node scripts/smoke-compiled-server.mjs [path-to-compiled-app.js]
 *
 * This is a build-verification harness, not a unit test: it exercises the real
 * compiled entry to prove the production install works without a TS transpiler.
 */
import { createApp } from '../dist/server/server/index.js';
import { MIGRATIONS } from '../dist/server/server/store/migrations.generated.js';
import { openDatabase } from '../dist/server/server/store/db.js';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-smoke-'));
const db = openDatabase({ dataDir });

// staticDir is deliberately NOT passed: `npm start` does not pass one either, so
// hardcoding it here would test a path production never takes. The first version
// of this script did exactly that and hid a real bug — the compiled build's
// default resolved to a directory that does not exist, so `npm start` served no
// SPA at all while this smoke test reported PASS.
const app = createApp({
	db,
	port: 0,
	host: '127.0.0.1'
});

let exitCode = 0;
try {
	await app.start();
	const base = app.url;
	console.log(`smoke: server up at ${base}`);

	// 1. API responds.
	const apiRes = await fetch(`${base}/api/connection`);
	const apiBody = await apiRes.text();
	console.log(`smoke: GET /api/connection -> ${apiRes.status} ${apiBody.slice(0, 120)}`);
	if (apiRes.status !== 200) throw new Error(`API check failed: ${apiRes.status}`);

	// 2. Built SPA is served at /.
	const spaRes = await fetch(`${base}/`);
	const spaHtml = await spaRes.text();
	console.log(`smoke: GET / -> ${spaRes.status} (len=${spaHtml.length})`);
	if (spaRes.status !== 200) throw new Error(`SPA serve failed: ${spaRes.status}`);
	if (!spaHtml.includes('<html') && !spaHtml.includes('<!DOCTYPE')) {
		throw new Error('SPA root did not return HTML');
	}

	// 3. Migrations applied on the fresh DB.
	const rows = db.prepare('SELECT COUNT(*) AS c FROM schema_version').get();
	const count = rows.c;
	console.log(`smoke: schema_version rows = ${count} (expected ${MIGRATIONS.length})`);
	if (count !== MIGRATIONS.length) {
		throw new Error(`Migration count mismatch: ${count} !== ${MIGRATIONS.length}`);
	}

	console.log('smoke: PASS — compiled server serves API + SPA, migrations applied on fresh DB');
} catch (err) {
	console.error('smoke: FAIL —', err);
	exitCode = 1;
} finally {
	await app.close();
	rmSync(dataDir, { recursive: true, force: true });
	process.exit(exitCode);
}