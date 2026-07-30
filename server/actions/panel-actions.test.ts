import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../api/events.js';
import type { PanelSessionRuntime, RoutesDeps } from '../api/routes.js';
import { upsertChat } from '../store/chats.js';
import { getChat } from '../store/chats.js';
import { upsertDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import { listOutbox } from '../store/outbox.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { actionRegistry, dispatch, listActionsForCaller } from './index.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function makeDeps(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-panel-actions-'));
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

const DIRECT = 'alice@s.whatsapp.net';
const GROUP = 'team@g.us';

function seed(database: AppDatabase): void {
	upsertChat(database, { jid: DIRECT, kind: '1:1', name: 'Alice', last_msg_at: 300, unread: 2 });
	upsertChat(database, { jid: GROUP, kind: 'group', name: 'Team', last_msg_at: 200, unread: 0 });
	for (let i = 1; i <= 8; i += 1) {
		upsertMessage(database, {
			id: `m${i}`,
			chat_jid: DIRECT,
			from_me: false,
			ts: 100 + i,
			type: 'text',
			text: `message ${i}`
		});
	}
	upsertMessage(database, {
		id: 'g1',
		chat_jid: GROUP,
		from_me: false,
		sender: 'bob@s.whatsapp.net',
		ts: 150,
		type: 'text',
		text: 'group message'
	});
}

/** A session manager stand-in — the actions must not know about the real one. */
function fakePanel(
	overrides: Partial<PanelSessionRuntime> & { throwInFlight?: boolean } = {}
): PanelSessionRuntime & { started: string[]; cancelled: number } {
	const started: string[] = [];
	let cancelled = 0;
	return {
		started,
		get cancelled() {
			return cancelled;
		},
		start: (text: string) => {
			started.push(text);
			return { sessionId: 'panel-1', messageId: 'msg-1', harness: 'opencode' };
		},
		cancel: () => {
			cancelled += 1;
			return true;
		},
		status: () => ({ running: false, sessionId: null, messageId: null, harness: null }),
		...overrides
	} as PanelSessionRuntime & { started: string[]; cancelled: number };
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

describe('the read surface exists at all', () => {
	it('advertises the three read actions to a tool caller', () => {
		// Before U7 every tool-permitted action was a mutation or had a side effect,
		// so an agent could act but not look.
		const names = listActionsForCaller(actionRegistry, 'tool').map((a) => a.name);
		expect(names).toContain('list-chats');
		expect(names).toContain('get-messages');
		expect(names).toContain('get-draft');
	});
});

describe('list-chats', () => {
	it('returns chat views, paged, with explicit paging state', async () => {
		const deps = makeDeps();
		seed(db!);
		const result = await dispatch(actionRegistry, 'list-chats', { limit: 1 }, {
			caller: 'tool',
			deps
		});
		expect(result).toMatchObject({ kind: 'json', status: 200 });
		const body = (result as { body: Record<string, unknown> }).body;
		expect(body.total).toBe(2);
		expect(body.has_more).toBe(true);
		expect((body.items as unknown[])).toHaveLength(1);
		// The shape the SPA consumes, so the agent sees what the owner's screen does.
		expect((body.items as Record<string, unknown>[])[0]).toHaveProperty('needs_reply');
		expect((body.items as Record<string, unknown>[])[0]).toHaveProperty('display_jid');
		expect((body.items as Record<string, unknown>[])[0]).toHaveProperty('preview');
	});

	it('pages with offset', async () => {
		const deps = makeDeps();
		seed(db!);
		const result = await dispatch(actionRegistry, 'list-chats', { limit: 1, offset: 1 }, {
			caller: 'tool',
			deps
		});
		const body = (result as { body: Record<string, unknown> }).body;
		expect(body.has_more).toBe(false);
		expect(body.offset).toBe(1);
	});

	it('caps the limit rather than honouring an enormous one', async () => {
		const deps = makeDeps();
		seed(db!);
		const result = await dispatch(actionRegistry, 'list-chats', { limit: 100_000 }, {
			caller: 'tool',
			deps
		});
		// An uncapped read is a context bomb AND a way to push the whole contact
		// list into a cloud model in one call.
		expect((result as { body: { limit: number } }).body.limit).toBe(100);
	});

	it('rejects a nonsense limit or offset', async () => {
		const deps = makeDeps();
		seed(db!);
		for (const raw of [{ limit: 0 }, { limit: -3 }, { limit: 1.5 }, { offset: -1 }]) {
			expect(
				await dispatch(actionRegistry, 'list-chats', raw, { caller: 'tool', deps })
			).toMatchObject({ kind: 'error', status: 400 });
		}
	});

	it('filters, and includes groups deliberately', async () => {
		const deps = makeDeps();
		seed(db!);
		const groups = await dispatch(actionRegistry, 'list-chats', { filter: 'groups' }, {
			caller: 'tool',
			deps
		});
		expect((groups as { body: { items: { jid: string }[] } }).body.items.map((c) => c.jid)).toEqual([
			GROUP
		]);
		// R8 excludes the agent from group classification and drafting, not from
		// reading — the shell shows groups and the owner can ask about one.
		const all = await dispatch(actionRegistry, 'list-chats', {}, { caller: 'tool', deps });
		expect(
			(all as { body: { items: { jid: string }[] } }).body.items.some((c) => c.jid === GROUP)
		).toBe(true);
	});

	it('rejects an unknown filter', async () => {
		const deps = makeDeps();
		expect(
			await dispatch(actionRegistry, 'list-chats', { filter: 'archived' }, { caller: 'tool', deps })
		).toMatchObject({ kind: 'error', status: 400 });
	});

	it('is read-only: no cursor advance, no unread change, no outbox row', async () => {
		const deps = makeDeps();
		seed(db!);
		const before = getChat(db!, DIRECT)!;
		await dispatch(actionRegistry, 'list-chats', {}, { caller: 'tool', deps });
		const after = getChat(db!, DIRECT)!;
		// A "read" tool that quietly marked things read would corrupt the
		// needs-reply verdict the whole draft pipeline is built on.
		expect(after.unread).toBe(before.unread);
		expect(after.last_read_msg_id).toBe(before.last_read_msg_id);
		expect(listOutbox(db!, 10)).toHaveLength(0);
	});
});

describe('get-messages', () => {
	it('returns message views in chronological order with a backward cursor', async () => {
		const deps = makeDeps();
		seed(db!);
		const result = await dispatch(
			actionRegistry,
			'get-messages',
			{ chatJid: DIRECT, limit: 3 },
			{ caller: 'tool', deps }
		);
		const body = (result as { body: Record<string, unknown> }).body;
		const items = body.items as { id: string; ts: number }[];
		expect(items).toHaveLength(3);
		// The store returns newest-first for the SPA, which normalizes. A model
		// reads the array as prose, so a conversation handed over backwards is one
		// it will misread — hence oldest-first here.
		expect(items.map((m) => m.id)).toEqual(['m6', 'm7', 'm8']);
		// Oldest-first means the backward cursor is the front of the page.
		expect(body.next_before_ts).toBe(items[0]!.ts);
		expect(body.next_before_id).toBe(items[0]!.id);
		expect(body.has_more).toBe(true);
	});

	it('the cursor actually pages backward', async () => {
		const deps = makeDeps();
		seed(db!);
		const first = (await dispatch(
			actionRegistry,
			'get-messages',
			{ chatJid: DIRECT, limit: 3 },
			{ caller: 'tool', deps }
		)) as { body: { items: { id: string }[]; next_before_ts: number; next_before_id: string } };
		const second = (await dispatch(
			actionRegistry,
			'get-messages',
			{
				chatJid: DIRECT,
				limit: 3,
				beforeTs: first.body.next_before_ts,
				beforeId: first.body.next_before_id
			},
			{ caller: 'tool', deps }
		)) as { body: { items: { id: string }[] } };
		const firstIds = new Set(first.body.items.map((m) => m.id));
		expect(second.body.items.every((m) => !firstIds.has(m.id))).toBe(true);
		expect(second.body.items.map((m) => m.id)).toEqual(['m3', 'm4', 'm5']);
	});

	it('caps below the store clamp and below the UI default', async () => {
		const deps = makeDeps();
		seed(db!);
		const result = await dispatch(
			actionRegistry,
			'get-messages',
			{ chatJid: DIRECT, limit: 500 },
			{ caller: 'tool', deps }
		);
		// Tighter than the store's own [1,200] and than the SPA's 50: a tool result
		// is conversation text leaving the machine, not rows in a scroller.
		expect((result as { body: { limit: number } }).body.limit).toBe(50);
	});

	it('404s an unknown chat', async () => {
		const deps = makeDeps();
		expect(
			await dispatch(actionRegistry, 'get-messages', { chatJid: 'nope@s.whatsapp.net' }, {
				caller: 'tool',
				deps
			})
		).toMatchObject({ kind: 'error', status: 404 });
	});

	it('rejects a missing chatJid', async () => {
		const deps = makeDeps();
		expect(
			await dispatch(actionRegistry, 'get-messages', {}, { caller: 'tool', deps })
		).toMatchObject({ kind: 'error', status: 400 });
	});

	it('does not expose focusMsgId', async () => {
		// No capability the backward cursor lacks, one more paging mode to reason
		// about — so it is not in the schema.
		const action = actionRegistry.get('get-messages')!;
		const properties = action.jsonSchema.properties as Record<string, unknown>;
		expect(properties).not.toHaveProperty('focusMsgId');
		expect(action.jsonSchema.additionalProperties).toBe(false);
	});

	it('is read-only: describes media but downloads nothing', async () => {
		const deps = makeDeps();
		seed(db!);
		upsertMessage(db!, {
			id: 'img',
			chat_jid: DIRECT,
			from_me: false,
			ts: 200,
			type: 'image',
			text: null
		});
		const result = await dispatch(
			actionRegistry,
			'get-messages',
			{ chatJid: DIRECT, limit: 50 },
			{ caller: 'tool', deps }
		);
		const image = (result as { body: { items: { id: string; media: unknown }[] } }).body.items.find(
			(m) => m.id === 'img'
		);
		expect(image!.media).toMatchObject({ state: 'placeholder', cached: false });
		expect(getChat(db!, DIRECT)!.unread).toBe(2);
	});
});

describe('get-draft', () => {
	it('returns the draft with its text_source', async () => {
		const deps = makeDeps();
		seed(db!);
		upsertDraft(db!, {
			chat_jid: DIRECT,
			text: 'hello there',
			status: 'ready',
			generated_at: 400,
			basis_msg_id: 'm8',
			provider: 'fake'
		});
		const result = await dispatch(actionRegistry, 'get-draft', { chatJid: DIRECT }, {
			caller: 'tool',
			deps
		});
		expect(result).toMatchObject({ kind: 'json', status: 200 });
		// `text_source` is how PL-U3's pinned-hash story stays honest about who
		// last wrote the text.
		expect((result as { body: { draft: { text_source: string } } }).body.draft).toMatchObject({
			text: 'hello there',
			text_source: 'system'
		});
	});

	it('answers no draft with 200 and null, not a 404', async () => {
		const deps = makeDeps();
		seed(db!);
		const result = await dispatch(actionRegistry, 'get-draft', { chatJid: DIRECT }, {
			caller: 'tool',
			deps
		});
		// A 404 arrives in the panel as a red error line, which is the wrong answer
		// to a completely normal question.
		expect(result).toMatchObject({ kind: 'json', status: 200 });
		expect((result as { body: { draft: unknown } }).body.draft).toBeNull();
	});

	it('does not generate a draft as a side effect', async () => {
		let generateCalls = 0;
		const deps = makeDeps({
			generateDraft: () => {
				generateCalls += 1;
				return true;
			}
		});
		seed(db!);
		await dispatch(actionRegistry, 'get-draft', { chatJid: DIRECT }, { caller: 'tool', deps });
		// Folding generation in would make a read tool spend money and emit
		// `draft-updated`.
		expect(generateCalls).toBe(0);
	});

	it('404s an unknown chat', async () => {
		const deps = makeDeps();
		expect(
			await dispatch(actionRegistry, 'get-draft', { chatJid: 'nope@s.whatsapp.net' }, {
				caller: 'tool',
				deps
			})
		).toMatchObject({ kind: 'error', status: 404 });
	});
});

describe('agent-turn is frontend only', () => {
	it('refuses a tool caller before parse or run', async () => {
		const panel = fakePanel();
		const deps = makeDeps({ panelSession: panel });
		const result = await dispatch(actionRegistry, 'agent-turn', { text: 'go' }, {
			caller: 'tool',
			deps
		});
		// Unbounded recursion in the same breath as unbounded spend: each nested
		// turn spawns another model process and nothing counts the depth.
		expect(result).toMatchObject({ kind: 'error', status: 403 });
		expect(panel.started).toEqual([]);
	});

	it('is absent from the tool list, along with its cancel', async () => {
		const names = listActionsForCaller(actionRegistry, 'tool').map((a) => a.name);
		expect(names).not.toContain('agent-turn');
		expect(names).not.toContain('cancel-agent-turn');
	});

	it('starts a turn for the frontend and returns 202 with correlation ids', async () => {
		const panel = fakePanel();
		const deps = makeDeps({ panelSession: panel });
		const result = await dispatch(actionRegistry, 'agent-turn', { text: '  summarise  ' }, {
			caller: 'frontend',
			deps
		});
		expect(result).toMatchObject({ kind: 'json', status: 202 });
		expect((result as { body: Record<string, unknown> }).body).toMatchObject({
			status: 'running',
			session_id: 'panel-1',
			message_id: 'msg-1',
			harness: 'opencode'
		});
		expect(panel.started).toEqual(['summarise']);
	});

	it('503s honestly when no panel runtime is configured', async () => {
		const deps = makeDeps();
		const result = await dispatch(actionRegistry, 'agent-turn', { text: 'go' }, {
			caller: 'frontend',
			deps
		});
		// Never a silent no-op: the panel is unusable with /mcp off and says so.
		expect(result).toMatchObject({ kind: 'error', status: 503 });
		expect((result as { extra?: Record<string, unknown> }).extra).toMatchObject({
			reason: 'panel_unavailable'
		});
	});

	it('409s a second turn rather than queueing it', async () => {
		const { PanelTurnInFlightError } = await import('../agent/panel/session.js');
		const deps = makeDeps({
			panelSession: fakePanel({
				start: () => {
					throw new PanelTurnInFlightError({
						sessionId: 'panel-1',
						messageId: 'msg-running',
						harness: 'opencode'
					});
				}
			})
		});
		const result = await dispatch(actionRegistry, 'agent-turn', { text: 'go' }, {
			caller: 'frontend',
			deps
		});
		expect(result).toMatchObject({ kind: 'error', status: 409 });
		expect((result as { extra?: Record<string, unknown> }).extra).toMatchObject({
			message_id: 'msg-running'
		});
	});

	it('rejects empty and oversized text', async () => {
		const deps = makeDeps({ panelSession: fakePanel() });
		for (const raw of [{}, { text: '   ' }, { text: 'x'.repeat(4_001) }]) {
			expect(
				await dispatch(actionRegistry, 'agent-turn', raw, { caller: 'frontend', deps })
			).toMatchObject({ kind: 'error', status: 400 });
		}
	});
});

describe('cancel-agent-turn is frontend only', () => {
	it('refuses a tool caller', async () => {
		const panel = fakePanel();
		const deps = makeDeps({ panelSession: panel });
		// An agent able to cancel is an agent able to stop the owner watching it
		// work — the trace is the only place the owner sees what it did.
		expect(
			await dispatch(actionRegistry, 'cancel-agent-turn', {}, { caller: 'tool', deps })
		).toMatchObject({ kind: 'error', status: 403 });
		expect(panel.cancelled).toBe(0);
	});

	it('cancels for the frontend', async () => {
		const panel = fakePanel();
		const deps = makeDeps({ panelSession: panel });
		const result = await dispatch(actionRegistry, 'cancel-agent-turn', {}, {
			caller: 'frontend',
			deps
		});
		expect(result).toMatchObject({ kind: 'json', status: 200 });
		expect((result as { body: { cancelled: boolean } }).body.cancelled).toBe(true);
		expect(panel.cancelled).toBe(1);
	});

	it('is a 200 with cancelled false when nothing is running', async () => {
		const deps = makeDeps({ panelSession: fakePanel({ cancel: () => false }) });
		const result = await dispatch(actionRegistry, 'cancel-agent-turn', {}, {
			caller: 'frontend',
			deps
		});
		// Clicking stop twice, or as the turn ends on its own, is normal and must
		// not paint a failure.
		expect(result).toMatchObject({ kind: 'json', status: 200 });
		expect((result as { body: { cancelled: boolean } }).body.cancelled).toBe(false);
	});
});

describe('the caller policies U7 must not have weakened', () => {
	it('still refuses every outbound and owner-only action for a tool caller', () => {
		// Three of these were deliberate owner decisions; if U7 had needed to relax
		// one to make a turn work, the answer was a new action, not this.
		const toolNames = new Set(listActionsForCaller(actionRegistry, 'tool').map((a) => a.name));
		for (const refused of [
			'send',
			'react',
			'approve-draft',
			'confirm-proposal',
			'reject-proposal',
			'set-send-mode',
			'set-setting',
			'save-voice',
			'regenerate-pairing',
			'promote-voice-suggestion',
			'discard-voice-suggestion',
			'agent-demo',
			'agent-turn',
			'cancel-agent-turn'
		]) {
			expect(toolNames.has(refused), `${refused} must not be tool-callable`).toBe(false);
		}
	});

	it('a refused send creates no outbox row', async () => {
		const deps = makeDeps();
		seed(db!);
		const result = await dispatch(
			actionRegistry,
			'send',
			{ chatJid: DIRECT, text: 'hello' },
			{ caller: 'tool', deps }
		);
		expect(result).toMatchObject({ kind: 'error', status: 403 });
		// The observable that matters is the table, not the message.
		expect(listOutbox(db!, 10)).toHaveLength(0);
	});
});
