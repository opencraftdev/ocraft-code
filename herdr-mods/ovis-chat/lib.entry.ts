/**
 * The chat logic the ovis-chat herdr-app mod shares with the web client, bundled into lib.js by
 * scripts/build-herdr-mods.ts. The mod runs in QuickJS (no DOM, no React): only pure helpers go here.
 */
export { splitTurn, turnSegments, workSummary, workFailed, formatWorkDuration, workStartsOpen, isLiveWorkTurn, isWaitingWorkTurn, visibleWorkParts } from "../../src/lib/workBlocks.ts";
export { toolVerb, isToolNarration } from "../../src/lib/toolVerbs.ts";
export { modelLabel } from "../../src/lib/modelName.ts";
export { composerMessage, composerPayload, composerDelivery, composerStatusWord, composerSendShown, contextLeftPercent, formatTokens, submitNote } from "../../src/lib/compose.ts";
