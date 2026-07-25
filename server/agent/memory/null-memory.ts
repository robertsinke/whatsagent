import type { Chat } from '../../store/chats.js';
import type { EditDelta, Memory, VoiceObservation } from './memory.js';

/** No-op fallback that keeps drafting available without Hindsight or Docker. */
export class NullMemory implements Memory {
	async retainVoiceObservation(_observation: VoiceObservation): Promise<void> {}

	async retainEditDelta(_delta: EditDelta): Promise<void> {}

	async recallStyleFor(_chat: Chat): Promise<string | null> {
		return null;
	}

	async reflect(): Promise<void> {}
}
