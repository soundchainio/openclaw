// Agent Eye — Diagnose Orchestrator
// Active diagnostic scan: navigate URL → collect errors → classify → return report
// Zero booleans. All state uses typed string enums with explicit equality checks.

import {
  getPageErrorsViaPlaywright,
  getConsoleMessagesViaPlaywright,
  getNetworkRequestsViaPlaywright,
} from "../../../src/browser/pw-tools-core.activity.js";
import { takeScreenshotViaPlaywright } from "../../../src/browser/pw-tools-core.interactions.js";
import {
  navigateViaPlaywright,
  snapshotAiViaPlaywright,
} from "../../../src/browser/pw-tools-core.snapshot.js";
import { normalizeBrowserScreenshot } from "../../../src/browser/screenshot.js";
import {
  BugStore,
  classifySeverity,
  BUG_SEVERITY,
  TRIGGER_KIND,
  type BugSeverity,
  type BugReport,
} from "./store.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const DIAGNOSE_STATUS = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type DiagnoseStatus = (typeof DIAGNOSE_STATUS)[keyof typeof DIAGNOSE_STATUS];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiagnoseTimelineEntry = {
  step: string;
  timestamp: number;
  durationMs: number;
};

export type DiagnoseConsoleEntry = {
  type: string;
  text: string;
  timestamp: string;
};

export type DiagnoseNetworkFailure = {
  method: string;
  url: string;
  status?: number;
  failureText?: string;
  timestamp: string;
};

export type DiagnoseReport = {
  id: string;
  url: string;
  startedAt: number;
  completedAt: number;
  status: DiagnoseStatus;
  overallSeverity: BugSeverity;
  bugs: BugReport[];
  consoleMessages: DiagnoseConsoleEntry[];
  networkFailures: DiagnoseNetworkFailure[];
  domSnapshot: string;
  screenshotBuffer: Buffer | null;
  actionTimeline: DiagnoseTimelineEntry[];
  summary: string;
};

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

let diagIdCounter = 0;

function generateDiagId(): string {
  const now = Date.now().toString(36);
  const count = (diagIdCounter++).toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `diag_${now}_${count}_${rand}`;
}

// ---------------------------------------------------------------------------
// Timeline helper
// ---------------------------------------------------------------------------

function timelineEntry(step: string, startMs: number): DiagnoseTimelineEntry {
  return { step, timestamp: startMs, durationMs: Date.now() - startMs };
}

// ---------------------------------------------------------------------------
// Severity ranking
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<BugSeverity, number> = {
  [BUG_SEVERITY.CRITICAL]: 4,
  [BUG_SEVERITY.ERROR]: 3,
  [BUG_SEVERITY.WARNING]: 2,
  [BUG_SEVERITY.INFO]: 1,
};

function worstSeverity(a: BugSeverity, b: BugSeverity): BugSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Core orchestrator
// ---------------------------------------------------------------------------

export type DiagnoseOptions = {
  cdpUrl: string;
  targetId?: string;
  store: BugStore;
  timeoutMs?: number;
};

export async function runDiagnose(url: string, opts: DiagnoseOptions): Promise<DiagnoseReport> {
  const { cdpUrl, targetId, store } = opts;
  const timeline: DiagnoseTimelineEntry[] = [];
  const bugs: BugReport[] = [];
  const consoleMessages: DiagnoseConsoleEntry[] = [];
  const networkFailures: DiagnoseNetworkFailure[] = [];
  let domSnapshot = "";
  let screenshotBuffer: Buffer | null = null;
  let overallSeverity: BugSeverity = BUG_SEVERITY.INFO;
  let status: DiagnoseStatus = DIAGNOSE_STATUS.RUNNING;
  const startedAt = Date.now();

  const cdpOpts = { cdpUrl, targetId };

  try {
    // Step 1: Navigate
    const navStart = Date.now();
    try {
      await navigateViaPlaywright({
        ...cdpOpts,
        url,
        timeoutMs: opts.timeoutMs ?? 30_000,
      });
      timeline.push(timelineEntry("navigate", navStart));
    } catch (err) {
      timeline.push(timelineEntry("navigate_failed", navStart));
      status = DIAGNOSE_STATUS.FAILED;
      return buildReport({
        id: generateDiagId(),
        url,
        startedAt,
        status,
        overallSeverity: BUG_SEVERITY.CRITICAL,
        bugs,
        consoleMessages,
        networkFailures,
        domSnapshot,
        screenshotBuffer,
        actionTimeline: timeline,
        summary: `Navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 2: Settle (let deferred JS execute)
    const settleStart = Date.now();
    await sleep(2000);
    timeline.push(timelineEntry("settle", settleStart));

    // Step 3: Collect page errors
    const errStart = Date.now();
    try {
      const { errors } = await getPageErrorsViaPlaywright({ ...cdpOpts, clear: false });
      for (const err of errors) {
        const severity = classifySeverity(TRIGGER_KIND.JS_ERROR);
        overallSeverity = worstSeverity(overallSeverity, severity);
        const bugId = store.add({
          url,
          timestamp: Date.now(),
          severity,
          trigger: TRIGGER_KIND.JS_ERROR,
          message: err.message,
          stack: err.stack,
          actions: [],
        });
        const bug = store.get(bugId);
        if (bug) bugs.push(bug);
      }
      timeline.push(timelineEntry("collect_errors", errStart));
    } catch {
      timeline.push(timelineEntry("collect_errors_failed", errStart));
    }

    // Step 4: Collect console messages
    const consStart = Date.now();
    try {
      const messages = await getConsoleMessagesViaPlaywright({ ...cdpOpts });
      for (const msg of messages) {
        consoleMessages.push({
          type: msg.type,
          text: msg.text,
          timestamp: msg.timestamp,
        });
        // Console errors become bugs
        if (msg.type === "error") {
          const severity = classifySeverity(TRIGGER_KIND.CONSOLE_ERROR);
          overallSeverity = worstSeverity(overallSeverity, severity);
          const bugId = store.add({
            url,
            timestamp: Date.now(),
            severity,
            trigger: TRIGGER_KIND.CONSOLE_ERROR,
            message: msg.text,
            actions: [],
          });
          const bug = store.get(bugId);
          if (bug) bugs.push(bug);
        }
      }
      timeline.push(timelineEntry("collect_console", consStart));
    } catch {
      timeline.push(timelineEntry("collect_console_failed", consStart));
    }

    // Step 5: Collect network requests (filter failures)
    const netStart = Date.now();
    try {
      const { requests } = await getNetworkRequestsViaPlaywright({ ...cdpOpts, clear: false });
      for (const req of requests) {
        const isFail = req.ok === false || (typeof req.status === "number" && req.status >= 400);
        if (isFail) {
          networkFailures.push({
            method: req.method,
            url: req.url,
            status: req.status,
            failureText: req.failureText,
            timestamp: req.timestamp,
          });
          const severity = classifySeverity(TRIGGER_KIND.NETWORK_ERROR, req.status);
          overallSeverity = worstSeverity(overallSeverity, severity);
          const bugId = store.add({
            url: req.url,
            timestamp: Date.now(),
            severity,
            trigger: TRIGGER_KIND.NETWORK_ERROR,
            message: `${req.method} ${req.url} → ${req.status ?? "failed"}${req.failureText ? ` (${req.failureText})` : ""}`,
            status: req.status,
            method: req.method,
            actions: [],
          });
          const bug = store.get(bugId);
          if (bug) bugs.push(bug);
        }
      }
      timeline.push(timelineEntry("collect_network", netStart));
    } catch {
      timeline.push(timelineEntry("collect_network_failed", netStart));
    }

    // Step 6: Capture screenshot
    const ssStart = Date.now();
    try {
      const { buffer } = await takeScreenshotViaPlaywright({
        ...cdpOpts,
        fullPage: false,
        type: "jpeg",
      });
      const normalized = await normalizeBrowserScreenshot(buffer);
      screenshotBuffer = normalized.buffer;
      timeline.push(timelineEntry("capture_screenshot", ssStart));
    } catch {
      timeline.push(timelineEntry("capture_screenshot_failed", ssStart));
    }

    // Step 7: Capture DOM snapshot
    const domStart = Date.now();
    try {
      const { snapshot } = await snapshotAiViaPlaywright({
        ...cdpOpts,
        maxChars: 50_000,
      });
      domSnapshot = snapshot;
      timeline.push(timelineEntry("capture_dom", domStart));
    } catch {
      timeline.push(timelineEntry("capture_dom_failed", domStart));
    }

    status = DIAGNOSE_STATUS.COMPLETED;
  } catch (err) {
    status = DIAGNOSE_STATUS.FAILED;
    return buildReport({
      id: generateDiagId(),
      url,
      startedAt,
      status,
      overallSeverity,
      bugs,
      consoleMessages,
      networkFailures,
      domSnapshot,
      screenshotBuffer,
      actionTimeline: timeline,
      summary: `Diagnose failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Build summary
  const summary = [
    `Scanned ${url}`,
    `${bugs.length} bug(s) found`,
    `${consoleMessages.length} console message(s)`,
    `${networkFailures.length} network failure(s)`,
    `Overall severity: ${overallSeverity}`,
  ].join(" | ");

  return buildReport({
    id: generateDiagId(),
    url,
    startedAt,
    status,
    overallSeverity,
    bugs,
    consoleMessages,
    networkFailures,
    domSnapshot,
    screenshotBuffer,
    actionTimeline: timeline,
    summary,
  });
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

type ReportFields = Omit<DiagnoseReport, "completedAt">;

function buildReport(fields: ReportFields): DiagnoseReport {
  return { ...fields, completedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
