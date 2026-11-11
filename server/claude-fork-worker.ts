/** File-only SDK operation, isolated so each source keeps its own CLAUDE_CONFIG_DIR. */
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
const [sessionId, directory, messageId] = process.argv.slice(2);
if (!sessionId || !directory || !messageId) process.exit(2);
try { const fork = await forkSession(sessionId, { dir: directory, upToMessageId: messageId }); process.stdout.write(JSON.stringify(fork)); }
catch { process.stderr.write("The source conversation could not be forked."); process.exit(1); }
