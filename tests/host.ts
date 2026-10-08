// Minimal host shims: tests never load credentials, send provider traffic, or modify real pi settings.
import { registerHooks } from "node:module";

const agent = `export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;`;
const tui = `
export const matchesKey = (data, key) => ({escape:'\\x1b',tab:'\\t','shift+tab':'\\x1b[Z',down:'\\x1b[B',up:'\\x1b[A'}[key] === data);
export const parseColor = (v) => v;
export const visibleWidth = (s) => Array.from(s).length;
export const truncateToWidth = (s, w) => Array.from(s).slice(0, Math.max(0, w)).join('');
`;
const shims = new Map([
	["@earendil-works/pi-coding-agent", agent],
	["@earendil-works/pi-tui", tui],
]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		const source = shims.get(specifier);
		return source === undefined ? nextResolve(specifier, context) : {
			url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true,
		};
	},
});
