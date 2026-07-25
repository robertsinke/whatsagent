import type { Chat } from '../../store/chats.js';
import { summarizeVoiceObservation } from '../voice.js';
import type { EditDelta, Memory, VoiceObservation } from './memory.js';

/** Static first-sync voice floor that requires neither Hindsight nor Docker. */
export class NullMemory implements Memory {
	readonly #captureVoice: boolean;
	readonly #styleByChat = new Map<string, string[]>();

	constructor(options: { captureVoice?: boolean } = {}) {
		this.#captureVoice = options.captureVoice ?? false;
	}

	async retainVoiceObservation(observation: VoiceObservation): Promise<void> {
		if (!this.#captureVoice) return;
		const summary = summarizeVoiceObservation(observation);
		if (!summary) return;
		const styles = this.#styleByChat.get(observation.chatJid) ?? [];
		styles.push(summary);
		this.#styleByChat.set(observation.chatJid, styles);
	}

	async retainEditDelta(_delta: EditDelta): Promise<void> {}

	async recallStyleFor(chat: Chat): Promise<string | null> {
		return this.#styleByChat.get(chat.jid)?.join('\n') ?? null;
	}

	async reflect(): Promise<void> {}
}
