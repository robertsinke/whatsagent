import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

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
		strictPort: false
	},
	preview: {
		host: 'localhost',
		port: 4173,
		strictPort: false
	},
	test: {
		include: ['server/**/*.test.ts'],
		environment: 'node'
	}
});
