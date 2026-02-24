/**
 * SoundChain Messaging Client
 *
 * GraphQL client for SoundChain DM operations.
 * Used by the channel plugin for outbound messaging
 * and inbound message polling.
 *
 * CRITICAL: `toId` must be a PROFILE ID, not a chat ID.
 * Using chat.id instead of chat.profile.id causes blank page crash
 * (documented Bug #17 in CLAUDE.md).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  message: string;
  createdAt: string;
  from?: { id: string; displayName?: string };
  to?: { id: string; displayName?: string };
}

export interface Chat {
  id: string;
  profile?: {
    id: string;
    displayName?: string;
    handle?: string;
  };
  lastMessage?: ChatMessage;
  unreadMessageCount?: number;
}

// ---------------------------------------------------------------------------
// GraphQL transport
// ---------------------------------------------------------------------------

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

async function graphql(
  apiUrl: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as GraphQLResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`SoundChain GraphQL: ${json.errors[0].message}`);
  }

  return json.data ?? {};
}

// ---------------------------------------------------------------------------
// Queries & Mutations
// ---------------------------------------------------------------------------

const CHATS_QUERY = `
  query Chats {
    chats {
      id
      profile {
        id
        displayName
        handle
      }
      lastMessage {
        id
        message
        createdAt
        from { id }
      }
      unreadMessageCount
    }
  }
`;

const SEND_MESSAGE_MUTATION = `
  mutation SendMessage($toId: ID!, $message: String!) {
    sendMessage(toId: $toId, message: $message) {
      id
      message
      createdAt
    }
  }
`;

const UNREAD_COUNT_QUERY = `
  query UnreadMessageCount {
    unreadMessageCount
  }
`;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface MessagingClient {
  getChats(): Promise<Chat[]>;
  sendMessage(toProfileId: string, message: string): Promise<ChatMessage>;
  getUnreadCount(): Promise<number>;
}

export function createMessagingClient(apiUrl: string, token: string): MessagingClient {
  return {
    async getChats(): Promise<Chat[]> {
      const data = await graphql(apiUrl, token, CHATS_QUERY);
      return (data.chats as Chat[] | undefined) ?? [];
    },

    async sendMessage(toProfileId: string, message: string): Promise<ChatMessage> {
      const data = await graphql(apiUrl, token, SEND_MESSAGE_MUTATION, {
        toId: toProfileId,
        message,
      });
      const result = data.sendMessage as ChatMessage | undefined;
      if (!result) throw new Error("sendMessage returned null");
      return result;
    },

    async getUnreadCount(): Promise<number> {
      const data = await graphql(apiUrl, token, UNREAD_COUNT_QUERY);
      return (data.unreadMessageCount as number | undefined) ?? 0;
    },
  };
}
