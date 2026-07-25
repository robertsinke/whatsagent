import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Local single-user SPA — no SSR. Backend (Node) serves the built bundle.
		adapter: adapter({
			fallback: 'index.html'
		})
	},
	compilerOptions: {
		// Force runes mode for project source (not node_modules). Matches catalog.
		runes: ({ filename }) =>
			filename.split(/[/\\]/).includes('node_modules') ? undefined : true
	}
};

export default config;