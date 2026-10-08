/** Explicit entry point for in-process subagents that have no PI_SUBAGENT_CHILD environment marker. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import keepalive from "./index.ts";

export default function childKeepalive(pi: ExtensionAPI) {
	keepalive(pi, { subagent: true });
}
