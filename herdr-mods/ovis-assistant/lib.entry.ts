/**
 * The Assistant logic the ovis-assistant herdr-app mod shares with the web client, bundled into lib.js
 * by scripts/build-herdr-mods.ts: which pane is the Assistant, the sessions it can delegate to, and
 * the composer's session tags. The chat itself is ovis-chat's (copied in at build).
 */
export { isAssistantPane } from "../../src/lib/assistantMode.ts";
export { assistantSessions, sessionActive } from "../../src/lib/assistantSessions.ts";
export { sessionTag, sessionPicker, filterSessions, expandSessionTags, machineNamesOf } from "../../src/lib/sessionTags.ts";
export { displayPaneTitle } from "../../src/lib/paneName.ts";
export { contextLeftPercent } from "../../src/lib/compose.ts";
