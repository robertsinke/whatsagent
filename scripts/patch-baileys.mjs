import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baileysEntryUrl = import.meta.resolve('baileys');
const validateConnectionUrl = new URL('./Utils/validate-connection.js', baileysEntryUrl);

const oldUserAgentStart = `const getUserAgent = (config) => {
    return {`;
const fixedUserAgentStart = `const isDesktop = (config) => config.browser[1] === 'Desktop';
const getUserAgentPlatform = (config) => {
    if (config.browser[1].toLocaleLowerCase().includes('android')) {
        return proto.ClientPayload.UserAgent.Platform.ANDROID;
    }
    if (config.syncFullHistory && isDesktop(config) && config.browser[0] === 'Mac OS') {
        return proto.ClientPayload.UserAgent.Platform.MACOS;
    }
    return proto.ClientPayload.UserAgent.Platform.WEB;
};
const getUserAgent = (config) => {
    return {`;

const replacements = [
	[oldUserAgentStart, fixedUserAgentStart],
	[
		'        platform: proto.ClientPayload.UserAgent.Platform.WEB,',
		'        platform: getUserAgentPlatform(config),'
	],
	[
		'    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN32',
		'    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID'
	]
];

function isPatched(source) {
	return (
		source.includes(fixedUserAgentStart) &&
		source.includes('        platform: getUserAgentPlatform(config),') &&
		source.includes('    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID')
	);
}

export function patchBaileysSource(source) {
	if (isPatched(source)) return source;

	let patched = source;
	for (const [before, after] of replacements) {
		if (!patched.includes(before)) {
			throw new Error(
				`Unsupported Baileys validate-connection.js layout; missing: ${before.split('\n')[0]}`
			);
		}
		patched = patched.replace(before, after);
	}

	if (!isPatched(patched)) throw new Error('Baileys connection patch did not apply completely');
	return patched;
}

const source = await readFile(validateConnectionUrl, 'utf8');
if (process.argv.includes('--check')) {
	if (!isPatched(source)) {
		throw new Error('Baileys desktop pairing compatibility patch is not installed');
	}
} else {
	const patched = patchBaileysSource(source);
	if (patched !== source) {
		await writeFile(validateConnectionUrl, patched);
		console.log(`Patched ${fileURLToPath(validateConnectionUrl)} for current desktop pairing`);
	}
}
