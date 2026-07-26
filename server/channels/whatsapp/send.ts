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
	readMessages(keys: WAMessageKey[]): Promise<unknown>;
};

export type WhatsAppSendTransport = {
	setPresence(jid: string, type: 'composing' | 'unavailable'): Promise<void>;
	sendText(jid: string, text: string, messageId: string, quoted?: WAMessage): Promise<void>;
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
		async markRead(jid, messageId) {
			await socket().readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]);
		}
	};
}
