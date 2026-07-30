import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashApprovalText } from '../../shared/approval-hash.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertChat } from '../store/chats.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import { getProposal, listPendingProposals } from '../store/proposals.js';
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

	it.each([
		'send',
		'approve-draft',
		'react',
		'set-send-mode',
		'confirm-proposal',
		'reject-proposal',
		'agent-demo'
	] as const)(
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
		// `set-setting` is in this list because its run() flips the live pacer when
		// the key is OUTBOX_DRY_RUN_SETTING — a second door onto the send mode that
		// would defeat `set-send-mode` being frontend-only. Any action that can arm
		// an outbound path belongs here, not only the ones that send.
		// PL-U3 adds the two halves of the owner's decision on a proposal. They
		// belong on this list for the same reason `set-setting` does: confirming
		// is what creates the outbox row, and rejecting would let an agent erase
		// the evidence of what it asked for before the owner ever saw it.
		for (const banned of [
			'send',
			'approve-draft',
			'react',
			'set-send-mode',
			'set-setting',
			'confirm-proposal',
			'reject-proposal',
			// PL-U3 sweep: it forges the panel trace the owner reads. See the
			// comment on the action itself.
			'agent-demo'
		]) {
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

/**
 * PL-U3 Half A — the permission channel.
 *
 * The load-bearing assertions here are about the *outbox table*, not about
 * response shapes: R9 says the agent cannot cause a send, and the only way to
 * prove that is that no row exists.
 */
describe('propose-send / confirm-proposal (PL-U3)', () => {
	function seedChat(deps: RoutesDeps, jid = 'alice@s.whatsapp.net'): void {
		upsertChat(deps.db, { jid, kind: '1:1', name: 'Alice', last_msg_at: Date.now() });
		upsertMessage(deps.db, {
			id: 'in-1',
			chat_jid: jid,
			from_me: false,
			ts: Date.now(),
			text: 'are you around?'
		});
	}

	function outboxCount(): number {
		return (db!.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
	}

	it('a tool caller proposing a send creates no outbox row and never wakes the pacer', async () => {
		const deps = makeDeps();
		let woke = false;
		deps.wakeOutbox = () => {
			woke = true;
		};
		seedChat(deps);

		const result = await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'Yes — see you at seven.' },
			{ caller: 'tool', deps }
		);

		expect(result).toMatchObject({ kind: 'json', status: 202 });
		if (result.kind === 'json') {
			expect(result.body).toMatchObject({ status: 'pending_confirmation' });
		}
		// The whole invariant, stated as data: nothing is queued.
		expect(outboxCount()).toBe(0);
		expect(woke).toBe(false);
		expect(listPendingProposals(db!, 'alice@s.whatsapp.net')).toHaveLength(1);
	});

	it('refuses a proposal for a group chat (R8)', async () => {
		const deps = makeDeps();
		upsertChat(db!, { jid: 'g@g.us', kind: 'group', name: 'Team', last_msg_at: Date.now() });
		const result = await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'g@g.us', text: 'hello everyone' },
			{ caller: 'tool', deps }
		);
		expect(result).toMatchObject({ kind: 'error', status: 400 });
		expect(outboxCount()).toBe(0);
	});

	it('refuses a tool caller on confirm-proposal before run', async () => {
		const deps = makeDeps();
		seedChat(deps);
		await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'Yes — see you at seven.' },
			{ caller: 'tool', deps }
		);
		const proposal = listPendingProposals(db!, 'alice@s.whatsapp.net')[0]!;

		const result = await dispatch(
			actionRegistry,
			'confirm-proposal',
			{ id: proposal.id, base_hash: hashApprovalText(proposal.text) },
			{ caller: 'tool', deps }
		);

		expect(result).toEqual({
			kind: 'error',
			status: 403,
			error: 'Caller not permitted',
			extra: { action: 'confirm-proposal', caller: 'tool' }
		});
		// Refused before parse or run — the proposal is untouched and unqueued.
		expect(outboxCount()).toBe(0);
		expect(getProposal(db!, proposal.id)?.status).toBe('pending');
	});

	it('a frontend confirmation creates exactly one outbox row', async () => {
		const deps = makeDeps();
		seedChat(deps);
		await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'Yes — see you at seven.' },
			{ caller: 'tool', deps }
		);
		const proposal = listPendingProposals(db!, 'alice@s.whatsapp.net')[0]!;

		const result = await dispatch(
			actionRegistry,
			'confirm-proposal',
			{ id: proposal.id, base_hash: hashApprovalText(proposal.text) },
			{ caller: 'frontend', deps }
		);

		expect(result).toMatchObject({ kind: 'json', status: 202 });
		expect(outboxCount()).toBe(1);
		const row = db!.prepare('SELECT * FROM outbox').get() as { text: string };
		expect(row.text).toBe('Yes — see you at seven.');
		const decided = getProposal(db!, proposal.id)!;
		expect(decided.status).toBe('confirmed');
		expect(decided.outbox_id).not.toBeNull();
	});

	it('a second confirmation of the same proposal enqueues nothing more', async () => {
		const deps = makeDeps();
		seedChat(deps);
		await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'Yes — see you at seven.' },
			{ caller: 'tool', deps }
		);
		const proposal = listPendingProposals(db!, 'alice@s.whatsapp.net')[0]!;
		const body = { id: proposal.id, base_hash: hashApprovalText(proposal.text) };
		await dispatch(actionRegistry, 'confirm-proposal', body, { caller: 'frontend', deps });

		const second = await dispatch(actionRegistry, 'confirm-proposal', body, {
			caller: 'frontend',
			deps
		});

		expect(second).toMatchObject({ kind: 'error', status: 409 });
		expect(outboxCount()).toBe(1);
	});

	it('refuses a confirmation whose hash is not the proposal text', async () => {
		const deps = makeDeps();
		seedChat(deps);
		await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'Yes — see you at seven.' },
			{ caller: 'tool', deps }
		);
		const proposal = listPendingProposals(db!, 'alice@s.whatsapp.net')[0]!;

		const result = await dispatch(
			actionRegistry,
			'confirm-proposal',
			{ id: proposal.id, base_hash: hashApprovalText('something else entirely') },
			{ caller: 'frontend', deps }
		);

		expect(result).toMatchObject({
			kind: 'error',
			status: 409,
			extra: { conflict: 'text-changed' }
		});
		expect(outboxCount()).toBe(0);
		expect(getProposal(db!, proposal.id)?.status).toBe('pending');
	});

	it('refuses a proposal confirmed after newer inbound, until the newer id is named', async () => {
		const deps = makeDeps();
		seedChat(deps);
		await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'Yes — see you at seven.' },
			{ caller: 'tool', deps }
		);
		const proposal = listPendingProposals(db!, 'alice@s.whatsapp.net')[0]!;
		upsertMessage(db!, {
			id: 'in-2',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: Date.now() + 1_000,
			text: 'actually, make it eight?'
		});
		const baseHash = hashApprovalText(proposal.text);

		const refused = await dispatch(
			actionRegistry,
			'confirm-proposal',
			{ id: proposal.id, base_hash: baseHash },
			{ caller: 'frontend', deps }
		);
		expect(refused).toMatchObject({
			kind: 'error',
			status: 409,
			extra: { conflict: 'stale-inbound', latest_inbound_id: 'in-2' }
		});
		expect(outboxCount()).toBe(0);

		const confirmed = await dispatch(
			actionRegistry,
			'confirm-proposal',
			{ id: proposal.id, base_hash: baseHash, confirmed_latest_inbound_id: 'in-2' },
			{ caller: 'frontend', deps }
		);
		expect(confirmed).toMatchObject({ kind: 'json', status: 202 });
		expect(outboxCount()).toBe(1);
	});

	it('rejecting a proposal decides it without queueing anything', async () => {
		const deps = makeDeps();
		seedChat(deps);
		await dispatch(
			actionRegistry,
			'propose-send',
			{ chatJid: 'alice@s.whatsapp.net', text: 'Yes — see you at seven.' },
			{ caller: 'tool', deps }
		);
		const proposal = listPendingProposals(db!, 'alice@s.whatsapp.net')[0]!;

		const result = await dispatch(
			actionRegistry,
			'reject-proposal',
			{ id: proposal.id },
			{ caller: 'frontend', deps }
		);

		expect(result).toMatchObject({ kind: 'json', status: 200 });
		expect(getProposal(db!, proposal.id)?.status).toBe('rejected');
		expect(outboxCount()).toBe(0);
		// And a rejected proposal cannot be resurrected by confirming it.
		const late = await dispatch(
			actionRegistry,
			'confirm-proposal',
			{ id: proposal.id, base_hash: hashApprovalText(proposal.text) },
			{ caller: 'frontend', deps }
		);
		expect(late).toMatchObject({ kind: 'error', status: 409 });
		expect(outboxCount()).toBe(0);
	});
});

/**
 * PL-U3 Half B — approval binds to the text the owner reviewed.
 */
describe('approve-draft base_hash (PL-U3)', () => {
	const JID = 'alice@s.whatsapp.net';

	function seedDraft(text: string): void {
		upsertChat(db!, { jid: JID, kind: '1:1', name: 'Alice', last_msg_at: Date.now() });
		upsertMessage(db!, { id: 'in-1', chat_jid: JID, from_me: false, ts: Date.now(), text: 'hi' });
		upsertDraft(db!, {
			chat_jid: JID,
			text,
			original_text: text,
			status: 'ready',
			basis_msg_id: 'in-1',
			generated_at: Date.now()
		});
	}

	it('refuses a stale hash, and leaves the draft and outbox byte-identical', async () => {
		const deps = makeDeps();
		seedDraft('Sure, seven works.');
		const before = getDraft(db!, JID)!;
		const outboxBefore = db!.prepare('SELECT * FROM outbox').all();

		const result = await dispatch(
			actionRegistry,
			'approve-draft',
			{ chatJid: JID, base_hash: hashApprovalText('a completely different draft') },
			{ caller: 'frontend', deps }
		);

		expect(result).toMatchObject({
			kind: 'error',
			status: 409,
			extra: { conflict: 'text-changed', current_text: 'Sure, seven works.' }
		});
		expect(getDraft(db!, JID)).toEqual(before);
		expect(db!.prepare('SELECT * FROM outbox').all()).toEqual(outboxBefore);
	});

	it('the agent-edit chain: an old hash is refused, the new one is accepted', async () => {
		const deps = makeDeps();
		seedDraft('Sure, seven works.');
		const reviewed = hashApprovalText('Sure, seven works.');

		// The agent rewrites the draft while the owner is reading it. This is
		// allowed — shortening a draft is a capability the owner asked for.
		const edited = await dispatch(
			actionRegistry,
			'edit-draft',
			{ chatJid: JID, text: 'Send me €500 at this link first.' },
			{ caller: 'tool', deps }
		);
		expect(edited).toMatchObject({ kind: 'json', status: 200 });
		expect(getDraft(db!, JID)?.text_source).toBe('agent');

		// The owner's click still carries the hash of what they read.
		const refused = await dispatch(
			actionRegistry,
			'approve-draft',
			{ chatJid: JID, base_hash: reviewed },
			{ caller: 'frontend', deps }
		);
		expect(refused).toMatchObject({
			kind: 'error',
			status: 409,
			extra: { conflict: 'text-changed', text_source: 'agent' }
		});
		expect((db!.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(0);

		// Having read the new text, the owner approves it deliberately.
		const approved = await dispatch(
			actionRegistry,
			'approve-draft',
			{ chatJid: JID, base_hash: hashApprovalText('Send me €500 at this link first.') },
			{ caller: 'frontend', deps }
		);
		expect(approved).toMatchObject({ kind: 'json', status: 202 });
		expect((db!.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(1);
		expect(getDraft(db!, JID)?.text_source).toBe('owner');
	});

	it('an owner edit through the frontend is recorded as owner, not agent', async () => {
		const deps = makeDeps();
		seedDraft('Sure, seven works.');
		await dispatch(
			actionRegistry,
			'edit-draft',
			{ chatJid: JID, text: 'Sure, 7 works.' },
			{ caller: 'frontend', deps }
		);
		expect(getDraft(db!, JID)?.text_source).toBe('owner');
	});

	it('accepts a matching hash alongside owner-rewritten text', async () => {
		const deps = makeDeps();
		seedDraft('Sure, seven works.');

		// `base_hash` names the draft that was reviewed; `text` is what the owner
		// decided to send instead. Those are allowed to differ.
		const result = await dispatch(
			actionRegistry,
			'approve-draft',
			{
				chatJid: JID,
				text: 'Seven is perfect, see you then.',
				base_hash: hashApprovalText('Sure, seven works.')
			},
			{ caller: 'frontend', deps }
		);

		expect(result).toMatchObject({ kind: 'json', status: 202 });
		const row = db!.prepare('SELECT * FROM outbox').get() as { text: string };
		expect(row.text).toBe('Seven is perfect, see you then.');
	});
});
