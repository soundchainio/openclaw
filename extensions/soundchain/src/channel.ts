/**
 * SoundChain Channel Plugin — OpenClaw Messaging Channel
 *
 * Turns SoundChain into an OpenClaw messaging channel. This means:
 * - OpenClaw agents can send DMs to SoundChain users via `sendText`
 * - Inbound messages are detected via 10s polling and logged
 * - Future: full inbound pipeline → OpenClaw agent responses
 *
 * Config (in openclaw config file under `channels.soundchain`):
 *   apiUrl:       GraphQL endpoint (default: https://api.soundchain.io/graphql)
 *   apiToken:     JWT for the bot account (required)
 *   accountName:  Display name (default: "SoundChain")
 *
 * Architecture:
 *   Pulse (PWA) ←→ SoundChain GraphQL ←→ OpenClaw Channel Plugin
 *                                              ↕
 *                                    OpenClaw Gateway (WebSocket)
 *                                              ↕
 *                                    WhatsApp / Telegram / Nostr
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { createMessagingClient, type MessagingClient } from "./messaging.js";

// ---------------------------------------------------------------------------
// Account types
// ---------------------------------------------------------------------------

const DEFAULT_ACCOUNT_ID = "default";
const POLL_INTERVAL_MS = 10_000;
const MAX_SEEN_IDS = 5_000;

export interface ResolvedSoundChainAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  apiUrl: string;
  apiToken: string;
}

// ---------------------------------------------------------------------------
// Module-level state (mirrors Nostr channel pattern)
// ---------------------------------------------------------------------------

/** Active messaging clients per account — used by outbound.sendText */
const activeClients = new Map<string, MessagingClient>();

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function extractChannelConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  return (channels.soundchain ?? {}) as Record<string, unknown>;
}

function resolveAccount(
  cfg: Record<string, unknown>,
  accountId?: string,
): ResolvedSoundChainAccount {
  const sc = extractChannelConfig(cfg);
  const apiUrl =
    typeof sc.apiUrl === "string" && sc.apiUrl ? sc.apiUrl : "https://api.soundchain.io/graphql";
  const apiToken = typeof sc.apiToken === "string" ? sc.apiToken : "";
  const accountName =
    typeof sc.accountName === "string" && sc.accountName ? sc.accountName : "SoundChain";

  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    name: accountName,
    enabled: !!apiToken,
    configured: !!apiToken,
    apiUrl,
    apiToken,
  };
}

// ---------------------------------------------------------------------------
// Channel plugin
// ---------------------------------------------------------------------------

export const soundchainChannelPlugin: ChannelPlugin<ResolvedSoundChainAccount> = {
  id: "soundchain",

  meta: {
    id: "soundchain",
    label: "SoundChain",
    selectionLabel: "SoundChain",
    docsPath: "/channels/soundchain",
    docsLabel: "soundchain",
    blurb: "DMs via SoundChain — decentralized music social network",
    order: 200,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },

  reload: { configPrefixes: ["channels.soundchain"] },

  // ---------------------------------------------------------------------------
  // Config adapter — account resolution from OpenClaw config
  // ---------------------------------------------------------------------------

  config: {
    listAccountIds: (cfg) => {
      const sc = extractChannelConfig(cfg);
      return sc.apiToken ? [DEFAULT_ACCOUNT_ID] : [];
    },

    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId ?? undefined),

    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    isConfigured: (account) => account.configured,

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },

  // ---------------------------------------------------------------------------
  // Messaging adapter — target normalization
  // ---------------------------------------------------------------------------

  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        // SoundChain profile IDs are MongoDB ObjectIds (24 hex chars)
        return /^[0-9a-fA-F]{24}$/.test(trimmed);
      },
      hint: "<SoundChain profile ID (24-char hex)>",
    },
  },

  // ---------------------------------------------------------------------------
  // Outbound adapter — send DMs via SoundChain GraphQL
  // ---------------------------------------------------------------------------

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 2000,

    sendText: async ({ to, text, accountId }) => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const client = activeClients.get(aid);

      if (!client) {
        throw new Error(`SoundChain messaging client not running for account ${aid}`);
      }

      const result = await client.sendMessage(to, text ?? "");

      return {
        channel: "soundchain" as const,
        to,
        messageId: result.id ?? `sc-${Date.now()}`,
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Gateway adapter — lifecycle + inbound message polling
  // ---------------------------------------------------------------------------

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      if (!account.configured) {
        throw new Error("SoundChain API token not configured — set channels.soundchain.apiToken");
      }

      ctx.log?.info(`[${account.accountId}] Starting SoundChain channel (${account.name})`);

      // Create and store the messaging client
      const client = createMessagingClient(account.apiUrl, account.apiToken);
      activeClients.set(account.accountId, client);

      // Track seen message IDs to avoid reprocessing
      const seenIds = new Set<string>();

      // Seed with current messages so we don't replay history
      try {
        const chats = await client.getChats();
        for (const chat of chats) {
          if (chat.lastMessage?.id) {
            seenIds.add(chat.lastMessage.id);
          }
        }
        ctx.log?.debug?.(`[${account.accountId}] Seeded ${seenIds.size} existing message IDs`);
      } catch (err) {
        ctx.log?.warn?.(`[${account.accountId}] Initial chat seed failed: ${err}`);
      }

      // Poll for new inbound messages
      const interval = setInterval(async () => {
        try {
          const chats = await client.getChats();

          for (const chat of chats) {
            const msg = chat.lastMessage;
            if (!msg?.id || seenIds.has(msg.id)) continue;

            seenIds.add(msg.id);

            // Cap seen IDs to prevent unbounded growth
            if (seenIds.size > MAX_SEEN_IDS) {
              const entries = Array.from(seenIds);
              for (let i = 0; i < entries.length - MAX_SEEN_IDS; i++) {
                seenIds.delete(entries[i]);
              }
            }

            const sender = chat.profile?.displayName ?? chat.profile?.handle ?? "unknown";
            const preview = msg.message?.slice(0, 80) ?? "";

            ctx.log?.info(
              `[${account.accountId}] New DM from ${sender}: ${preview}${(msg.message?.length ?? 0) > 80 ? "..." : ""}`,
            );

            // Future: forward to OpenClaw message pipeline via
            // runtime.channel.reply.handleInboundMessage({
            //   channel: "soundchain",
            //   accountId: account.accountId,
            //   senderId: chat.profile?.id,
            //   chatType: "direct",
            //   chatId: chat.profile?.id,
            //   text: msg.message,
            //   reply: async (text) => { await client.sendMessage(chat.profile!.id, text); },
            // });
          }
        } catch {
          // Polling errors are non-fatal — gateway will retry on next interval
        }
      }, POLL_INTERVAL_MS);

      ctx.log?.info(
        `[${account.accountId}] SoundChain channel started — polling every ${POLL_INTERVAL_MS / 1000}s`,
      );

      // Return cleanup function (called by gateway on stop)
      return {
        stop: () => {
          clearInterval(interval);
          activeClients.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] SoundChain channel stopped`);
        },
      };
    },
  },
};
