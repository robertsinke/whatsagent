/**
 * Fire the gated PL-A1 demo sequence against a running preview server.
 *
 *   WHATSAGENT_DEV_EVENTS=1 npm run preview:ui
 *   npx tsx scripts/dev-emit-agent-events.ts
 *
 * Requires the preview (or any createApp instance) to have been started with
 * WHATSAGENT_DEV_EVENTS=1 — otherwise the route 404s.
 */
const port = Number(process.env.PORT ?? 8799);
const origin = `http://127.0.0.1:${port}`;

const res = await fetch(`${origin}/api/dev/agent-demo`, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		Origin: origin,
		Host: `127.0.0.1:${port}`
	},
	body: JSON.stringify({
		openChatJid: process.env.DEV_OPEN_CHAT_JID,
		stepMs: process.env.DEV_STEP_MS ? Number(process.env.DEV_STEP_MS) : undefined
	})
});

const body = await res.text();
console.log(res.status, body);
if (!res.ok) process.exit(1);
