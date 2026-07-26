import type { WAMessage, WAMessageKey } from 'baileys';

export class WhatsAppDisconnectedError extends Error {
	constructor() {
		super('WhatsApp is disconnected');
		this.name = 'WhatsAppDisconnectedError';
	}
}

export type WhatsAppSendSocket = {
	sendPresenceUpdate(type: 'composing' | 'unavailable', jid: string): Promise<unknown>;
	sendMessage(
		jid: string,
		content: { text: string },
		options: { messageId: string; quoted?: WAMessage }
	): Promise<unknown>;
	sendMessage(
		jid: string,
		content: { react: { text: string; key: WAMessageKey } }
	): Promise<unknown>;
	readMessages(keys: WAMessageKey[]): Promise<unknown>;
};

export type WhatsAppSendTransport = {
	setPresence(jid: string, type: 'composing' | 'unavailable'): Promise<void>;
	sendText(jid: string, text: string, messageId: string, quoted?: WAMessage): Promise<void>;
	/**
	 * D2 (Wave 3 U2): send (or remove) a reaction on a target message. An empty
	 * `emoji` string removes a prior reaction. This is a Baileys `sendMessage`
	 * call — a send under R9 — so the pacer is its only production caller.
	 */
	sendReaction(jid: string, targetKey: WAMessageKey, emoji: string): Promise<void>;
	markRead(jid: string, messageId: string): Promise<void>;
};

/**
 * The only adapter in the repository that invokes Baileys sending methods.
 * Its sole production consumer is OutboxPacer.
 */
export function createWhatsAppSendTransport(
	getSocket: () => WhatsAppSendSocket | undefined
): WhatsAppSendTransport {
	function socket(): WhatsAppSendSocket {
		const current = getSocket();
		if (!current) throw new WhatsAppDisconnectedError();
		return current;
	}

	return {
		async setPresence(jid, type) {
			await socket().sendPresenceUpdate(type, jid);
		},
		async sendText(jid, text, messageId, quoted) {
			await socket().sendMessage(jid, { text }, { messageId, ...(quoted ? { quoted } : {}) });
		},
		async sendReaction(jid, targetKey, emoji) {
			await socket().sendMessage(jid, { react: { text: emoji, key: targetKey } });
		},
		async markRead(jid, messageId) {
			await socket().readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]);
		}
	};
}
