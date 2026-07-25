import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
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
	}
});