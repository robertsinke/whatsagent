import { describe, expect, it, vi } from 'vitest';
import type { WAMessage } from 'baileys';
import { createWhatsAppSendTransport, type WhatsAppSendSocket } from './send.js';

function socket(): WhatsAppSendSocket {
	return {
		sendPresenceUpdate: vi.fn(async () => undefined),
		sendMessage: vi.fn(async () => undefined),
		readMessages: vi.fn(async () => undefined)
	};
}

describe('createWhatsAppSendTransport', () => {
	it('passes the stored target as Baileys quoted send metadata', async () => {
		const activeSocket = socket();
		const transport = createWhatsAppSendTransport(() => activeSocket);
		const quoted = {
			key: { id: 'target', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
			message: { conversation: 'Question' }
		} satisfies WAMessage;

		await transport.sendText('alice@s.whatsapp.net', 'Answer', 'stable-id', quoted);

		expect(activeSocket.sendMessage).toHaveBeenCalledWith(
			'alice@s.whatsapp.net',
			{ text: 'Answer' },
			{ messageId: 'stable-id', quoted }
		);
	});

	it('does not add quoted metadata to an ordinary send', async () => {
		const activeSocket = socket();
		const transport = createWhatsAppSendTransport(() => activeSocket);

		await transport.sendText('alice@s.whatsapp.net', 'Hello', 'stable-id');

		expect(activeSocket.sendMessage).toHaveBeenCalledWith(
			'alice@s.whatsapp.net',
			{ text: 'Hello' },
			{ messageId: 'stable-id' }
		);
	});
});
