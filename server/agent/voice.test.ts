import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChat, upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertMessage } from '../store/messages.js';
import type { Memory, VoiceObservation } from './memory/memory.js';
import { NullMemory } from './memory/null-memory.js';
import { bootstrapOwnerVoice, retainDraftLearning, sampleOwnerVoice } from './voice.js';

let db: AppDatabase | undefined;
let dataDir: string | undefined;

function setup(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-voice-'));
	db = openDatabase({ dataDir });
	upsertChat(db, { jid: 'alice@s.whatsapp.net', kind: '1:1' });
	upsertChat(db, { jid: 'team@g.us', kind: 'group' });
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('voice bootstrap', () => {
	it('samples only owner messages and groups them by chat and language', async () => {
		const database = setup();
		const seed = [
			{ id: 'nl-1', chat: 'alice@s.whatsapp.net', fromMe: true, ts: 1, text: 'Ja, dat is goed.' },
			{ id: 'en-1', chat: 'alice@s.whatsapp.net', fromMe: true, ts: 2, text: 'Yes, that is good.' },
			{ id: 'in-1', chat: 'alice@s.whatsapp.net', fromMe: false, ts: 3, text: 'Do not learn me' },
			{ id: 'group-1', chat: 'team@g.us', fromMe: true, ts: 4, text: 'Do not learn group style' }
		];
		for (const message of seed) {
			upsertMessage(database, {
				id: message.id,
				chat_jid: message.chat,
				from_me: message.fromMe,
				ts: message.ts,
				text: message.text
			});
		}

		expect(sampleOwnerVoice(database)).toMatchObject([
			{ chatJid: 'alice@s.whatsapp.net', language: 'nl', messages: ['Ja, dat is goed.'] },
			{ chatJid: 'alice@s.whatsapp.net', language: 'en', messages: ['Yes, that is good.'] }
		]);

		const retained: VoiceObservation[] = [];
		const memory: Memory = {
			retainVoiceObservation: async (observation) => { retained.push(observation); },
			retainEditDelta: async () => undefined,
			recallStyleFor: async () => null,
			reflect: async () => undefined
		};
		await expect(bootstrapOwnerVoice(database, memory)).resolves.toEqual({
			observations: 2,
			chats: 1,
			thinChats: ['alice@s.whatsapp.net']
		});
		expect(retained).toHaveLength(2);
	});

	it('provides a static local style floor when Docker is not used', async () => {
		const database = setup();
		upsertMessage(database, {
			id: 'owner-1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 1,
			text: 'Ja, is goed.'
		});
		const memory = new NullMemory({ captureVoice: true });
		await bootstrapOwnerVoice(database, memory);

		await expect(memory.recallStyleFor(getChat(database, 'alice@s.whatsapp.net')!))
			.resolves.toContain('Typical message length is 3 words');
	});
});

describe('draft learning', () => {
	it('retains edits and skips but not verbatim approvals', async () => {
		const retainEditDelta = vi.fn(async () => undefined);
		const memory = {
			retainVoiceObservation: async () => undefined,
			retainEditDelta,
			recallStyleFor: async () => null,
			reflect: async () => undefined
		} satisfies Memory;

		await retainDraftLearning(memory, {
			chatJid: 'alice@s.whatsapp.net', draft: 'Hello!', final: 'Hello!', skipped: false
		});
		await retainDraftLearning(memory, {
			chatJid: 'alice@s.whatsapp.net', draft: 'Hello!', final: 'Hi', skipped: false
		});
		await retainDraftLearning(memory, {
			chatJid: 'alice@s.whatsapp.net', draft: 'No reply', final: null, skipped: true
		});

		expect(retainEditDelta).toHaveBeenCalledTimes(2);
		expect(retainEditDelta).toHaveBeenNthCalledWith(1, expect.objectContaining({ final: 'Hi' }));
		expect(retainEditDelta).toHaveBeenNthCalledWith(2, expect.objectContaining({ skipped: true }));
	});
});
