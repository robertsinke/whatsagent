import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

const BACKEND_ORIGIN = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
	plugins: [
		tailwindcss(),
		// Do not pass options into sveltekit() — that makes Vite ignore svelte.config.js,
		// which drops kit.adapter (adapter-static) and leaves no `build/` output.
		// compilerOptions.runes lives in svelte.config.js instead.
		sveltekit()
	],
	server: {
		// Local single-user app — bind to localhost only (R9-adjacent CSRF surface).
		host: 'localhost',
		port: 5173,
		strictPort: false,
		// `vite dev` serves the SPA on 5173 while the API lives on 8787. The backend
		// rejects any Origin that isn't its own (localhost CSRF defense), so the dev
		// proxy must present the backend's origin — in production they are one origin
		// and this proxy does not exist.
		proxy: {
			'/api': {
				target: BACKEND_ORIGIN,
				ws: true,
				changeOrigin: true,
				configure: (proxy) => {
					proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', BACKEND_ORIGIN));
					proxy.on('proxyReqWs', (proxyReq) => proxyReq.setHeader('origin', BACKEND_ORIGIN));
				}
			}
		}
	},
	preview: {
		host: 'localhost',
		port: 4173,
		strictPort: false
	},
	test: {
		// Client-side tests cover the pure view-model layer (`src/lib/client/view.ts`);
		// Svelte components stay untested here on purpose — see the U6 report.
		include: ['server/**/*.test.ts', 'src/lib/**/*.test.ts'],
		environment: 'node'
	}
});
