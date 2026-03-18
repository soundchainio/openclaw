/**
 * FURL Responder — AI-powered DM replies via Claude CLI
 *
 * Uses `claude --print` on the Mac Mini (part of Claude Code subscription).
 * Zero additional cost — flat monthly fee already paid.
 * FURL IS the one replying (runs locally on Mac Mini).
 *
 * System prompt lives at ~/.openclaw/furl-system-prompt.txt on Mac Mini.
 * User message passed as positional arg via shell.
 *
 * Flow: DM detected → claude --print → reply text → sendMessage back
 */

import { spawn } from "node:child_process";

const TIMEOUT_MS = 60_000;

// Mac Mini node/claude paths (launchd doesn't inherit shell PATH)
const NODE_DIR = "/Users/frankchavez/local/node/bin";
const CLAUDE_BIN = `${NODE_DIR}/claude`;
const SYSTEM_PROMPT_FILE = "/Users/frankchavez/.openclaw/furl-system-prompt.txt";

// OAuth token from OpenClaw config — authenticates Claude CLI without interactive login
const CLAUDE_OAUTH_TOKEN =
  "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";

/**
 * Generate a reply using Claude CLI on the Mac Mini.
 * Uses spawn with shell to read system prompt from file.
 * Uses the existing Claude Code subscription (flat fee, zero extra cost).
 */
export async function generateReply(senderName: string, message: string): Promise<string> {
  // Escape single quotes in user message for shell safety
  const safeMessage = message.replace(/'/g, "'\\''");
  const userMsg = `[DM from ${senderName} on SoundChain Pulse]: ${safeMessage}`;

  // Build shell command: read system prompt from file, pass user message as positional arg
  const cmd = `${CLAUDE_BIN} --print --dangerously-skip-permissions --model claude-haiku-4-5-20251001 --system-prompt "$(cat ${SYSTEM_PROMPT_FILE})" '${userMsg}'`;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn("bash", ["-c", cmd], {
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/Users/frankchavez",
        PATH: `${NODE_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Timeout guard
    const timer = setTimeout(() => {
      console.error(`[FURL responder] timeout after ${TIMEOUT_MS}ms`);
      proc.kill("SIGTERM");
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        console.error(`[FURL responder] exit code ${code}, stderr: ${stderr.slice(0, 300)}`);
        resolve(
          `hey ${senderName}! FURL here — caught your message but my brain's rebooting. hit me again in a sec`,
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[FURL responder] spawn error: ${err.message}`);
      resolve(
        `hey ${senderName}! FURL here — caught your message but my brain's rebooting. hit me again in a sec`,
      );
    });
  });
}
