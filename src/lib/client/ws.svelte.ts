import type { ServerEvent } from './types.js';
import { reconnectDelayMs } from './view.js';

export type RealtimeOptions = {
	onEvent: (event: ServerEvent) => void;
	/**
	 * Called after every successful (re)connect. The client refetches state here
	 * so the UI never silently shows chats/drafts that moved on while we were
	 * asleep or offline.
	 */
	onResync: () => void;
};

export type Realtime = {
	readonly connected: boolean;
	start(): void;
	stop(): void;
};

/**
 * WebSocket transport with exponential backoff. Survives laptop sleep/wake and
 * network drops; each reconnect triggers a full resync rather than trusting the
 * events we may have missed.
 */
export function createRealtime(options: RealtimeOptions): Realtime {
	let socket: WebSocket | null = null;
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = true;
	let connected = $state(false);

	function url(): string {
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${location.host}/api/ws`;
	}

	function scheduleReconnect(): void {
		if (stopped || timer) return;
		attempt += 1;
		timer = setTimeout(() => {
			timer = undefined;
			connect();
		}, reconnectDelayMs(attempt));
	}

	function connect(): void {
		if (stopped) return;
		socket = new WebSocket(url());

		socket.addEventListener('open', () => {
			attempt = 0;
			connected = true;
			options.onResync();
		});

		socket.addEventListener('message', (event) => {
			try {
				options.onEvent(JSON.parse(String(event.data)) as ServerEvent);
			} catch {
				// A malformed frame must not kill the socket.
			}
		});

		socket.addEventListener('close', () => {
			connected = false;
			socket = null;
			scheduleReconnect();
		});

		socket.addEventListener('error', () => socket?.close());
	}

	function onWake(): void {
		// Sleep/wake often leaves a half-open socket that never fires `close`.
		if (!stopped && !connected && !timer) connect();
	}

	return {
		get connected() {
			return connected;
		},
		start() {
			if (!stopped) return;
			stopped = false;
			attempt = 0;
			connect();
			window.addEventListener('online', onWake);
			document.addEventListener('visibilitychange', onWake);
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			socket?.close();
			socket = null;
			connected = false;
			window.removeEventListener('online', onWake);
			document.removeEventListener('visibilitychange', onWake);
		}
	};
}
