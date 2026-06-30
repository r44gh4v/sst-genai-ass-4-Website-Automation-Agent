import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { config } from "./config";
import { logger } from "./logger";
import { bus, AgentEvent } from "./events";
import { BrowserTools } from "./tools/browser";
import { AgentLoop } from "./agent";

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

// Single shared LLM client - the agent loop reuses it across runs.
const client = new OpenAI({ apiKey: config.nimApiKey, baseURL: config.nimBaseUrl });

// Only one automation run at a time: the browser is a single shared resource and
// concurrent runs would fight over the same page. New requests are rejected while busy.
let busy = false;

// Abort controller for the in-flight run, so the UI's Stop button can cancel it.
let currentAbort: AbortController | null = null;

/** Connected Server-Sent-Events clients. Every AgentEvent is fanned out to all of them. */
const sseClients = new Set<http.ServerResponse>();

function broadcast(event: AgentEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    // A client socket may be half-closed before its 'close' handler fired; writing
    // to it can throw synchronously. Guard each write so one dead client cannot
    // abort the fan-out to the rest (and never let it bubble into the emitting code).
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Subscribe the broadcaster to the bus once at startup. Logger, agent, and
// browser tools all publish to the bus; this forwards everything to the browsers.
bus.onEvent(broadcast);

/**
 * Runs one full automation task: opens a fresh browser, hands the prompt to the
 * agent loop, and guarantees the browser is closed afterwards. All progress is
 * streamed to connected clients via the event bus, so this returns void.
 */
async function runTask(prompt: string): Promise<void> {
  const browserTools = new BrowserTools(client);
  const runId = new Date().toISOString().replace(/T/, "_").replace(/[:.]/g, "-").slice(0, 19);
  browserTools.startRun(runId);
  currentAbort = new AbortController();
  try {
    bus.emitEvent({ type: "status", state: "running", message: "Launching browser..." });

    const opened = await browserTools.open_browser({ headless: config.headless });
    if (!opened.success) {
      throw new Error(`Failed to open browser: ${opened.error}`);
    }

    const agent = new AgentLoop(client, browserTools);
    const summary = await agent.run(prompt, currentAbort.signal);

    bus.emitEvent({ type: "status", state: "done", message: summary || "Task finished." });
  } catch (err) {
    logger.error("Agent run failed", String(err));
    bus.emitEvent({ type: "status", state: "error", message: String(err) });
  } finally {
    await browserTools.close_browser();
    currentAbort = null;
    busy = false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/**
 * Serves a single static asset from the public directory.
 * `path.basename` strips any directory components, so the client cannot escape
 * PUBLIC_DIR via path traversal (e.g. "../../etc/passwd").
 */
function serveFile(res: http.ServerResponse, fileName: string): void {
  const safe = path.basename(fileName);
  const full = path.join(PUBLIC_DIR, safe);
  const ext = path.extname(safe).toLowerCase();
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`${safe} not found`);
      return;
    }
    res.writeHead(200, { "Content-Type": STATIC_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
  });
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Initial comment flushes headers and opens the stream in the browser.
  res.write(": connected\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let prompt = "";
  try {
    const body = await readBody(req);
    prompt = (JSON.parse(body || "{}").prompt ?? "").toString().trim();
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body." }));
    return;
  }

  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Prompt is required." }));
    return;
  }

  // Check-and-set the busy flag with NO await in between, so in single-threaded
  // Node two near-simultaneous requests cannot both pass the guard. (The body
  // parse above is the only await, and it happens before this point.)
  if (busy) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "An automation run is already in progress." }));
    return;
  }
  busy = true;

  // Kick off the run in the background; progress streams over SSE.
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ accepted: true }));
  void runTask(prompt);
}

export function startServer(): void {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && url === "/") return serveFile(res, "index.html");
    if (req.method === "GET" && (url === "/styles.css" || url === "/app.js" || url === "/explainer.html")) return serveFile(res, url);
    if (req.method === "GET" && url === "/events") return handleSse(req, res);
    if (req.method === "POST" && url === "/run") {
      void handleRun(req, res);
      return;
    }
    if (req.method === "POST" && url === "/stop") {
      if (currentAbort && busy) {
        currentAbort.abort();
        bus.emitEvent({ type: "status", state: "running", message: "Stopping..." });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stopping: true }));
      } else {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No run in progress." }));
      }
      return;
    }
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        busy,
        model: config.model,
        vision: config.visionEnabled ? config.visionModel : null,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(config.port, () => {
    logger.info("=== Website Automation Agent ===");
    logger.info("Model", config.model);
    logger.info("Vision", config.visionEnabled ? config.visionModel : "disabled");
    logger.info("NIM Base URL", config.nimBaseUrl);
    logger.info(`Open the UI at http://localhost:${config.port}`);
  });
}
