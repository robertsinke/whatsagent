import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { AppDatabase } from '../store/db.js';
import {
	getChat,
	listChats,
	markChatRead,
	setChatAgentState,
	type Chat
} from '../store/chats.js';
import { deleteDraft, getDraft, upsertDraft } from '../store/drafts.js';
import { getLastMessage, listMessagesPage } from '../store/messages.js';
import {
	cancelOutbox,
	enqueueOutbox,
	getOutbox,
	listOutbox
} from '../store/outbox.js';
import { getSetting, listSettings, setSetting } from '../store/settings.js';
import type { ConnectionStatus, EventBus } from './events.js';
import {
	buildAllowedOrigins,
	isMutatingMethod,
	validateOriginAndHost,
	type AllowedOrigins
} from './security.js';

export type RoutesDeps = {
	db: AppDatabase;
	events: EventBus;
	getConnectionStatus: () => ConnectionStatus;
	/** Absolute path to adapter-static output (optional; API-only if omitted). */
	staticDir?: string;
	port: number;
	allowedOrigins?: AllowedOrigins;
	/** Prefer over static `allowedOrigins` when the listen port is ephemeral (0). */
	getAllowedOrigins?: () => AllowedOrigins;
};

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.map': 'application/json'
};

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload)
	});
	res.end(payload);
}

function error(res: ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
	json(res, status, { error: message, ...extra });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	}
	if (chunks.length === 0) return undefined;
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw.trim()) return undefined;
	return JSON.parse(raw) as unknown;
}

/**
 * Deterministic needs-reply (mirrors U8 classifier floor, without draft pipeline):
 * 1:1 + last message inbound + not muted/archived + not skipped since last inbound.
 */
export function chatNeedsReply(db: AppDatabase, chat: Chat): boolean {
	if (chat.kind !== '1:1') return false;
	if (chat.muted || chat.archived) return false;
	// 'skipped' = owner opted out; 'quiet' = agent returned no_reply_needed (D3).
	if (chat.agent_state === 'skipped' || chat.agent_state === 'quiet') return false;
	const last = getLastMessage(db, chat.jid);
	if (!last || last.from_me) return false;
	return true;
}

function parsePositiveInt(value: string | null, fallback: number): number {
	if (value === null || value === '') return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function serveStatic(
	res: ServerResponse,
	staticDir: string,
	urlPath: string
): boolean {
	const decoded = decodeURIComponent(urlPath.split('?')[0] || '/');
	const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\//, '');
	const candidate = normalize(join(staticDir, relative));
	if (!candidate.startsWith(staticDir + sep) && candidate !== staticDir) {
		error(res, 403, 'Forbidden');
		return true;
	}

	let filePath = candidate;
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		const fallback = join(staticDir, 'index.html');
		if (!existsSync(fallback)) return false;
		filePath = fallback;
	}

	const st = statSync(filePath);
	if (!st.isFile()) return false;

	const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
	res.writeHead(200, {
		'Content-Type': type,
		'Content-Length': st.size
	});
	createReadStream(filePath).pipe(res);
	return true;
}

export function createRequestHandler(deps: RoutesDeps) {
	const origins = (): AllowedOrigins =>
		deps.getAllowedOrigins?.() ??
		deps.allowedOrigins ??
		buildAllowedOrigins(deps.port);

	return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const method = (req.method ?? 'GET').toUpperCase();
		const host = req.headers.host ?? `127.0.0.1:${deps.port}`;
		const url = new URL(req.url ?? '/', `http://${host}`);
		const allowedOrigins = origins();

		if (method === 'OPTIONS') {
			res.writeHead(204, {
				'Access-Control-Allow-Origin': [...allowedOrigins][0] ?? '',
				'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
				'Access-Control-Max-Age': '86400'
			});
			res.end();
			return;
		}

		if (isMutatingMethod(method)) {
			const check = validateOriginAndHost(req, allowedOrigins);
			if (!check.ok) {
				error(res, 403, 'Forbidden', { reason: check.reason });
				return;
			}
		}

		try {
			if (url.pathname.startsWith('/api/')) {
				await handleApi(deps, req, res, method, url);
				return;
			}

			if (deps.staticDir && (method === 'GET' || method === 'HEAD')) {
				if (serveStatic(res, deps.staticDir, url.pathname)) return;
			}

			error(res, 404, 'Not found');
		} catch (err) {
			if (err instanceof SyntaxError) {
				error(res, 400, 'Invalid JSON body');
				return;
			}
			console.error('[api]', err);
			error(res, 500, 'Internal server error');
		}
	};
}

async function handleApi(
	deps: RoutesDeps,
	req: IncomingMessage,
	res: ServerResponse,
	method: string,
	url: URL
): Promise<void> {
	const { db, events } = deps;
	const path = url.pathname;

	if (path === '/api/connection' && method === 'GET') {
		json(res, 200, deps.getConnectionStatus());
		return;
	}

	if (path === '/api/settings' && method === 'GET') {
		json(res, 200, listSettings(db));
		return;
	}

	if (path === '/api/settings' && method === 'PUT') {
		const body = (await readJsonBody(req)) as { key?: string; value?: string } | undefined;
		if (!body?.key || typeof body.value !== 'string') {
			error(res, 400, 'Expected { key, value }');
			return;
		}
		setSetting(db, body.key, body.value);
		json(res, 200, { key: body.key, value: getSetting(db, body.key) });
		return;
	}

	if (path === '/api/outbox' && method === 'GET') {
		const limit = parsePositiveInt(url.searchParams.get('limit'), 100);
		json(res, 200, { items: listOutbox(db, limit) });
		return;
	}

	const outboxMatch = /^\/api\/outbox\/(\d+)$/.exec(path);
	if (outboxMatch && method === 'DELETE') {
		const id = Number(outboxMatch[1]);
		const existing = getOutbox(db, id);
		if (!existing) {
			error(res, 404, 'Outbox item not found');
			return;
		}
		if (!cancelOutbox(db, id)) {
			error(res, 409, 'Outbox item is not cancellable');
			return;
		}
		const updated = getOutbox(db, id)!;
		events.emit({ type: 'outbox-updated', outbox: updated });
		json(res, 200, updated);
		return;
	}

	if (path === '/api/chats' && method === 'GET') {
		const filter = url.searchParams.get('filter') ?? 'all';
		let chats = listChats(db);
		if (filter === 'needs-reply') {
			chats = chats.filter((c) => chatNeedsReply(db, c));
		} else if (filter === 'groups') {
			chats = chats.filter((c) => c.kind === 'group');
		}
		json(res, 200, { items: chats });
		return;
	}

	const chatMatch = /^\/api\/chats\/([^/]+)(?:\/(.*))?$/.exec(path);
	if (!chatMatch) {
		error(res, 404, 'Not found');
		return;
	}

	const jid = decodeURIComponent(chatMatch[1]!);
	const rest = chatMatch[2] ?? '';

	const chat = getChat(db, jid);
	if (!chat && rest !== '') {
		// Sub-resources require the chat to exist.
		error(res, 404, 'Chat not found', { jid });
		return;
	}

	if (rest === '' && method === 'GET') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		json(res, 200, chat);
		return;
	}

	if (rest === 'messages' && method === 'GET') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const limit = parsePositiveInt(url.searchParams.get('limit'), 50);
		const beforeTsRaw = url.searchParams.get('beforeTs');
		const beforeId = url.searchParams.get('beforeId') ?? undefined;
		const beforeTs =
			beforeTsRaw !== null && beforeTsRaw !== ''
				? Number.parseInt(beforeTsRaw, 10)
				: undefined;
		const items = listMessagesPage(db, jid, {
			limit,
			beforeTs: beforeTs !== undefined && Number.isFinite(beforeTs) ? beforeTs : undefined,
			beforeId
		});
		json(res, 200, { items });
		return;
	}

	if (rest === 'messages' && method === 'POST') {
		// Composer send → outbox only. Never calls WhatsApp send (R9 / U9).
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const body = (await readJsonBody(req)) as { text?: string } | undefined;
		const text = body?.text?.trim();
		if (!text) {
			error(res, 400, 'Expected { text }');
			return;
		}
		const now = Date.now();
		const id = enqueueOutbox(db, {
			chat_jid: jid,
			text,
			queued_at: now,
			send_after: now,
			status: 'pending'
		});
		const row = getOutbox(db, id)!;
		events.emit({ type: 'outbox-updated', outbox: row });
		json(res, 202, row);
		return;
	}

	if (rest === 'read' && method === 'POST') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		markChatRead(db, jid);
		const updated = getChat(db, jid)!;
		events.emit({ type: 'chat-updated', chat: updated });
		json(res, 200, updated);
		return;
	}

	if (rest === 'draft' && method === 'GET') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const draft = getDraft(db, jid);
		if (!draft) {
			error(res, 404, 'Draft not found');
			return;
		}
		json(res, 200, draft);
		return;
	}

	if (rest === 'draft' && method === 'PATCH') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const existing = getDraft(db, jid);
		if (!existing) {
			error(res, 404, 'Draft not found');
			return;
		}
		const body = (await readJsonBody(req)) as { text?: string } | undefined;
		if (typeof body?.text !== 'string') {
			error(res, 400, 'Expected { text }');
			return;
		}
		upsertDraft(db, { ...existing, text: body.text });
		const draft = getDraft(db, jid)!;
		events.emit({ type: 'draft-updated', draft });
		json(res, 200, draft);
		return;
	}

	if (rest === 'draft/approve' && method === 'POST') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const existing = getDraft(db, jid);
		if (!existing) {
			error(res, 404, 'Draft not found');
			return;
		}
		const last = getLastMessage(db, jid);
		if (
			existing.basis_msg_id &&
			last &&
			!last.from_me &&
			last.id !== existing.basis_msg_id
		) {
			error(res, 409, 'Draft is stale; newer inbound arrived', {
				basis_msg_id: existing.basis_msg_id,
				latest_inbound_id: last.id
			});
			return;
		}
		const body = (await readJsonBody(req)) as { text?: string } | undefined;
		const text = (body?.text ?? existing.text).trim();
		if (!text) {
			error(res, 400, 'Empty draft text');
			return;
		}
		const now = Date.now();
		const id = enqueueOutbox(db, {
			chat_jid: jid,
			text,
			queued_at: now,
			send_after: now,
			status: 'pending'
		});
		upsertDraft(db, { ...existing, text, status: 'approved' });
		const row = getOutbox(db, id)!;
		const draft = getDraft(db, jid)!;
		events.emit({ type: 'outbox-updated', outbox: row });
		events.emit({ type: 'draft-updated', draft });
		json(res, 202, { outbox: row, draft });
		return;
	}

	if (rest === 'draft/skip' && method === 'POST') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		deleteDraft(db, jid);
		setChatAgentState(db, jid, 'skipped');
		const updated = getChat(db, jid)!;
		events.emit({ type: 'draft-removed', chat_jid: jid });
		events.emit({ type: 'chat-updated', chat: updated });
		json(res, 200, { ok: true, chat: updated });
		return;
	}

	error(res, 404, 'Not found');
}
