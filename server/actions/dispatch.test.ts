import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertChat } from '../store/chats.js';
import { upsertDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import { EventBus } from '../api/events.js';
import type { RoutesDeps } from '../api/routes.js';
import {
	actionRegistry,
	dispatch,
	listActionsForCaller
} from './index.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function makeDeps(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-actions-'));
	db = openDatabase({ dataDir });
	return {
		db,
		events: new EventBus(),
		getConnectionStatus: () => ({ state: 'connected', qr: null }),
		port: 0,
		dataDir,
		...overrides
	};
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

describe('action registry dispatch', () => {
	it('resolves a known action and runs it', async () => {
		const deps = makeDeps();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: Date.now()
		});
		const result = await dispatch(
			actionRegistry,
			'mark-read',
			{ chatJid: 'alice@s.whatsapp.net' },
			{ caller: 'frontend', deps }
		);
		expect(result).toMatchObject({ kind: 'json', status: 200 });
		if (result.kind === 'json') {
			expect(result.body).toMatchObject({ jid: 'alice@s.whatsapp.net' });
		}
	});

	it('rejects an unknown action name', async () => {
		const deps = makeDeps();
		const result = await dispatch(actionRegistry, 'not-a-real-action', {}, {
			caller: 'frontend',
			deps
		});
		expect(result).toEqual({
			kind: 'error',
			status: 404,
			error: 'Unknown action',
			extra: { name: 'not-a-real-action' }
		});
	});

	it.each(['send', 'approve-draft', 'react', 'set-send-mode'] as const)(
		'refuses tool caller for outbound action %s (dispatcher policy)',
		async (name) => {
			const deps = makeDeps();
			const action = actionRegistry.get(name);
			expect(action).toBeDefined();
			expect(action!.callers).toEqual(['frontend']);
			expect(action!.callers.includes('tool')).toBe(false);

			const result = await dispatch(actionRegistry, name, {}, { caller: 'tool', deps });
			expect(result).toEqual({
				kind: 'error',
				status: 403,
				error: 'Caller not permitted',
				extra: { action: name, caller: 'tool' }
			});
		}
	);

	it('does not invoke run when the caller is refused', async () => {
		const deps = makeDeps();
		let woke = false;
		deps.wakeOutbox = () => {
			woke = true;
		};
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: Date.now()
		});
		const result = await dispatch(
			actionRegistry,
			'send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'should not enqueue' },
			{ caller: 'tool', deps }
		);
		expect(result.kind).toBe('error');
		expect(woke).toBe(false);
	});

	it('parse failure for send produces the same error shape as the old handler', async () => {
		const deps = makeDeps();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: Date.now()
		});
		const result = await dispatch(
			actionRegistry,
			'send',
			{ chatJid: 'alice@s.whatsapp.net' },
			{ caller: 'frontend', deps }
		);
		expect(result).toEqual({
			kind: 'error',
			status: 400,
			error: 'Expected { text }'
		});
	});

	it('parse failure for set-send-mode produces Expected { live: boolean }', async () => {
		const deps = makeDeps();
		const result = await dispatch(
			actionRegistry,
			'set-send-mode',
			{ live: 'yes' },
			{ caller: 'frontend', deps }
		);
		expect(result).toEqual({
			kind: 'error',
			status: 400,
			error: 'Expected { live: boolean }'
		});
	});

	it('parse failure for react produces Expected { emoji }', async () => {
		const deps = makeDeps();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: Date.now()
		});
		upsertMessage(db!, {
			id: 'msg-1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: Date.now(),
			text: 'hi'
		});
		const result = await dispatch(
			actionRegistry,
			'react',
			{ messageId: 'msg-1' },
			{ caller: 'frontend', deps }
		);
		expect(result).toEqual({
			kind: 'error',
			status: 400,
			error: 'Expected { emoji }'
		});
	});

	it('parse failure for set-setting produces Expected { key, value }', async () => {
		const deps = makeDeps();
		const result = await dispatch(
			actionRegistry,
			'set-setting',
			{ key: 'provider' },
			{ caller: 'frontend', deps }
		);
		expect(result).toEqual({
			kind: 'error',
			status: 400,
			error: 'Expected { key, value }'
		});
	});

	it('tool may call mark-read and cancel-outbox (non-outbound)', async () => {
		const deps = makeDeps();
		const toolNames = listActionsForCaller(actionRegistry, 'tool').map((a) => a.name);
		expect(toolNames).toEqual(
			expect.arrayContaining(['mark-read', 'cancel-outbox', 'generate-draft', 'skip-draft'])
		);
		for (const banned of ['send', 'approve-draft', 'react', 'set-send-mode']) {
			expect(toolNames).not.toContain(banned);
		}

		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: Date.now()
		});
		const result = await dispatch(
			actionRegistry,
			'mark-read',
			{ chatJid: 'alice@s.whatsapp.net' },
			{ caller: 'tool', deps }
		);
		expect(result.kind).toBe('json');
		expect(result).toMatchObject({ status: 200 });
	});

	it('approve-draft tool refusal happens before draft work', async () => {
		const deps = makeDeps();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: Date.now()
		});
		upsertMessage(db!, {
			id: 'in-1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: Date.now(),
			text: 'ping'
		});
		upsertDraft(db!, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'pong',
			original_text: 'pong',
			status: 'ready',
			basis_msg_id: 'in-1',
			generated_at: Date.now()
		});
		const result = await dispatch(
			actionRegistry,
			'approve-draft',
			{ chatJid: 'alice@s.whatsapp.net' },
			{ caller: 'tool', deps }
		);
		expect(result).toMatchObject({
			kind: 'error',
			status: 403,
			error: 'Caller not permitted'
		});
	});
});
