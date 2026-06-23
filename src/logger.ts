import { bus } from "./events";

type Level = "INFO" | "WARN" | "ERROR" | "TOOL";

function log(level: Level, message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}]`;
  const dataStr = data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data, null, 2);

  if (dataStr !== undefined) {
    console.log(`${prefix} ${message}`, dataStr);
  } else {
    console.log(`${prefix} ${message}`);
  }

  // Mirror INFO/WARN/ERROR lines to the web UI. TOOL lines are streamed by the
  // agent itself as richer structured tool-call/tool-result events, so skip them
  // here to avoid duplicate noise in the browser panel.
  if (level !== "TOOL") {
    bus.emitEvent({ type: "log", level, message, data: dataStr });
  }
}

export const logger = {
  info: (msg: string, data?: unknown) => log("INFO", msg, data),
  warn: (msg: string, data?: unknown) => log("WARN", msg, data),
  error: (msg: string, data?: unknown) => log("ERROR", msg, data),
  tool: (name: string, args: unknown, result: unknown) => {
    log("TOOL", `→ ${name}`, args);
    log("TOOL", `← ${name}`, result);
  },
};
