import type { AppDatabase } from '../store/db.js';
import type { EditDelta, Memory, VoiceObservation } from './memory/memory.js';

export type VoiceSampleGroup = VoiceObservation & {
	messages: string[];
};

export type VoiceBootstrapResult = {
	observations: number;
	chats: number;
	thinChats: string[];
};

const DUTCH_WORDS = new Set([
	'als', 'dat', 'de', 'dit', 'een', 'goed', 'het', 'ik', 'ja', 'je', 'jij', 'maar',
	'met', 'nee', 'niet', 'om', 'ook', 'uur', 'van', 'voor', 'we', 'wel', 'zijn', 'zullen'
]);
const ENGLISH_WORDS = new Set([
	'and', 'are', 'but', 'for', 'good', 'i', 'is', 'it', 'no', 'not', 'of', 'that',
	'the', 'this', 'to', 'we', 'with', 'yes', 'you'
]);

export function detectLanguage(text: string): string {
	const words = text.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
	let dutch = 0;
	let english = 0;
	for (const word of words) {
		if (DUTCH_WORDS.has(word)) dutch += 1;
		if (ENGLISH_WORDS.has(word)) english += 1;
	}
	if (dutch > english) return 'nl';
	if (english > dutch) return 'en';
	return 'und';
}

/** Samples only owner-authored text from 1:1 chats, grouped by chat and language. */
export function sampleOwnerVoice(
	db: AppDatabase,
	options: { maxMessagesPerGroup?: number } = {}
): VoiceSampleGroup[] {
	const rows = db.prepare(
		`SELECT m.chat_jid, m.text
		 FROM messages m
		 JOIN chats c ON c.jid = m.chat_jid
		 WHERE m.from_me = 1 AND m.type = 'text' AND m.text IS NOT NULL
		   AND TRIM(m.text) != '' AND c.kind = '1:1'
		 ORDER BY m.ts ASC, m.id ASC`
	).all() as Array<{ chat_jid: string; text: string }>;
	const groups = new Map<string, VoiceSampleGroup>();
	const limit = Math.max(1, options.maxMessagesPerGroup ?? 50);

	for (const row of rows) {
		const text = row.text.trim();
		const language = detectLanguage(text);
		const key = `${row.chat_jid}\u0000${language}`;
		const group = groups.get(key) ?? {
			chatJid: row.chat_jid,
			language,
			text: '',
			messages: []
		};
		group.messages.push(text);
		if (group.messages.length > limit) group.messages.shift();
		group.text = group.messages.join('\n');
		groups.set(key, group);
	}

	return [...groups.values()];
}

export async function bootstrapOwnerVoice(
	db: AppDatabase,
	memory: Memory,
	options: { maxMessagesPerGroup?: number; thinThreshold?: number } = {}
): Promise<VoiceBootstrapResult> {
	const groups = sampleOwnerVoice(db, options);
	for (const group of groups) {
		await memory.retainVoiceObservation({
			chatJid: group.chatJid,
			language: group.language,
			text: group.text
		});
	}

	const perChat = new Map<string, number>();
	for (const group of groups) {
		perChat.set(group.chatJid, (perChat.get(group.chatJid) ?? 0) + group.messages.length);
	}
	const thinThreshold = options.thinThreshold ?? 5;
	const thinChats = [...perChat]
		.filter(([, count]) => count < thinThreshold)
		.map(([chatJid]) => chatJid);
	return { observations: groups.length, chats: perChat.size, thinChats };
}

export function summarizeVoiceObservation(observation: VoiceObservation): string {
	const messages = observation.text.split('\n').map((text) => text.trim()).filter(Boolean);
	if (messages.length === 0) return '';
	const wordCounts = messages.map((message) => message.match(/\p{L}+/gu)?.length ?? 0).sort((a, b) => a - b);
	const medianWords = wordCounts[Math.floor(wordCounts.length / 2)] ?? 0;
	const exclamations = messages.filter((message) => message.includes('!')).length;
	const examples = messages.slice(-3).map((message) => `"${message}"`).join('; ');
	return [
		`Owner writes in ${observation.language ?? 'an undetermined language'}.`,
		`Typical message length is ${medianWords} words.`,
		exclamations === 0 ? 'Rarely uses exclamation marks.' : 'Sometimes uses exclamation marks.',
		`Recent examples: ${examples}`
	].join(' ');
}

/** Captures only meaningful owner feedback; memory failure never blocks approval/skip. */
export async function retainDraftLearning(
	memory: Memory,
	delta: EditDelta,
	log: Pick<Console, 'warn'> = console
): Promise<void> {
	if (!delta.skipped && delta.final === delta.draft) return;
	try {
		await memory.retainEditDelta(delta);
	} catch (error) {
		log.warn('[memory] failed to retain draft feedback', error);
	}
}
