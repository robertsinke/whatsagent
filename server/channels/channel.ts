export type ChannelConnectionState = 'connecting' | 'connected' | 'disconnected';

export type ChannelEvent =
	| { type: 'connection'; state: ChannelConnectionState }
	| { type: 'pairing-needed'; qr: string }
	| { type: 'sync-progress'; progress: number | null; isLatest: boolean }
	| { type: 'error'; error: Error; fatal: boolean };

export type ChannelEventListener = (event: ChannelEvent) => void;

export interface Channel {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: ChannelEventListener): () => void;
}
