// Agent Eye — Chrome Co-Worker Bridge
// Connects to OpenClaw Chrome Extension Relay to drive the user's live Chrome tabs.
// Zero booleans. All state uses typed string enums with explicit equality checks.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const BRIDGE_STATUS = {
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  EXTENSION_MISSING: "EXTENSION_MISSING",
  RELAY_UNREACHABLE: "RELAY_UNREACHABLE",
} as const;
export type BridgeStatus = (typeof BRIDGE_STATUS)[keyof typeof BRIDGE_STATUS];

export const BRIDGE_SOURCE = {
  CHROME_EXTENSION: "CHROME_EXTENSION",
  RAW_CDP: "RAW_CDP",
  FALLBACK: "FALLBACK",
} as const;
export type BridgeSource = (typeof BRIDGE_SOURCE)[keyof typeof BRIDGE_SOURCE];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChromeTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type BridgeConnection = {
  status: BridgeStatus;
  source: BridgeSource;
  cdpUrl: string;
  targetId: string | undefined;
  targets: ChromeTarget[];
};

// ---------------------------------------------------------------------------
// Constants — Chrome Extension Relay ports to probe
// ---------------------------------------------------------------------------

const EXTENSION_RELAY_PORT = 18792;
const RAW_CDP_PORT = 9222;
const PROBE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// HTTP fetch helper with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Probe a CDP endpoint for targets
// ---------------------------------------------------------------------------

async function probeTargets(baseUrl: string): Promise<ChromeTarget[]> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/json/list`, PROBE_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = (await res.json()) as ChromeTarget[];
    if (!Array.isArray(data)) return [];
    return data.filter(
      (t) => typeof t.id === "string" && (t.type === "page" || t.type === undefined),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Check if extension relay is alive
// ---------------------------------------------------------------------------

async function probeExtensionRelay(port: number): Promise<{
  alive: boolean;
  extensionConnected: boolean;
}> {
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${port}/extension/status`,
      PROBE_TIMEOUT_MS,
    );
    if (!res.ok) return { alive: true, extensionConnected: false };
    const data = (await res.json()) as { connected?: boolean };
    return { alive: true, extensionConnected: data.connected === true };
  } catch {
    return { alive: false, extensionConnected: false };
  }
}

// ---------------------------------------------------------------------------
// Select best target — prefer the tab matching a URL pattern, else first page
// ---------------------------------------------------------------------------

function selectTarget(targets: ChromeTarget[], preferUrl?: string): string | undefined {
  if (targets.length === 0) return undefined;

  // If we have a URL preference, try to find a tab already on that domain
  if (preferUrl) {
    try {
      const preferHost = new URL(preferUrl).hostname;
      const match = targets.find((t) => {
        try {
          return new URL(t.url).hostname === preferHost;
        } catch {
          return false;
        }
      });
      if (match) return match.id;
    } catch {
      // ignore URL parse errors
    }
  }

  // Otherwise return the first page target
  return targets[0]?.id;
}

// ---------------------------------------------------------------------------
// Public API — discover and connect to the best available Chrome bridge
// ---------------------------------------------------------------------------

export async function discoverChromeBridge(preferUrl?: string): Promise<BridgeConnection> {
  // Priority 1: OpenClaw Chrome Extension Relay (co-worker — drives live tabs)
  const relay = await probeExtensionRelay(EXTENSION_RELAY_PORT);

  if (relay.alive && relay.extensionConnected) {
    const cdpUrl = `http://127.0.0.1:${EXTENSION_RELAY_PORT}`;
    const targets = await probeTargets(cdpUrl);
    const targetId = selectTarget(targets, preferUrl);

    return {
      status: BRIDGE_STATUS.CONNECTED,
      source: BRIDGE_SOURCE.CHROME_EXTENSION,
      cdpUrl,
      targetId,
      targets,
    };
  }

  if (relay.alive && !relay.extensionConnected) {
    // Relay is running but Chrome extension isn't attached to any tab
    return {
      status: BRIDGE_STATUS.EXTENSION_MISSING,
      source: BRIDGE_SOURCE.CHROME_EXTENSION,
      cdpUrl: `http://127.0.0.1:${EXTENSION_RELAY_PORT}`,
      targetId: undefined,
      targets: [],
    };
  }

  // Priority 2: Raw CDP on standard port (headless Chrome, Chromium, etc.)
  const rawTargets = await probeTargets(`http://127.0.0.1:${RAW_CDP_PORT}`);

  if (rawTargets.length > 0) {
    const cdpUrl = `http://127.0.0.1:${RAW_CDP_PORT}`;
    const targetId = selectTarget(rawTargets, preferUrl);

    return {
      status: BRIDGE_STATUS.CONNECTED,
      source: BRIDGE_SOURCE.RAW_CDP,
      cdpUrl,
      targetId,
      targets: rawTargets,
    };
  }

  // Nothing found
  return {
    status: BRIDGE_STATUS.RELAY_UNREACHABLE,
    source: BRIDGE_SOURCE.FALLBACK,
    cdpUrl: `http://127.0.0.1:${RAW_CDP_PORT}`,
    targetId: undefined,
    targets: [],
  };
}

// ---------------------------------------------------------------------------
// Human-readable status for /eye bridge command
// ---------------------------------------------------------------------------

export function formatBridgeStatus(conn: BridgeConnection): string {
  const lines: string[] = [];

  lines.push(`Bridge Status: ${conn.status}`);
  lines.push(`Source: ${conn.source}`);
  lines.push(`CDP URL: ${conn.cdpUrl}`);

  if (conn.targetId) {
    lines.push(`Active Target: ${conn.targetId}`);
  }

  if (conn.targets.length > 0) {
    lines.push(`\nAttached Tabs (${conn.targets.length}):`);
    for (const t of conn.targets) {
      const title = t.title.length > 60 ? t.title.slice(0, 60) + "..." : t.title;
      lines.push(`  [${t.id.slice(0, 8)}] ${title}`);
      lines.push(`           ${t.url}`);
    }
  }

  if (conn.status === BRIDGE_STATUS.EXTENSION_MISSING) {
    lines.push(
      "\nChrome extension relay is running but no tab is attached." +
        "\nOpen Chrome on MacBook → click the OpenClaw extension icon on the tab you want to control.",
    );
  }

  if (conn.status === BRIDGE_STATUS.RELAY_UNREACHABLE) {
    lines.push(
      "\nNo Chrome bridge found. Options:" +
        "\n  1. Start OpenClaw with browser profile: openclaw browser --browser-profile chrome" +
        "\n  2. Launch Chrome with remote debugging: chrome --remote-debugging-port=9222" +
        "\n  3. Provide cdpUrl manually: /eye diagnose <url> --cdp <cdpUrl>",
    );
  }

  return lines.join("\n");
}
