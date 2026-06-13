type Level = "INFO" | "WARN" | "ERROR" | "TOOL";

function log(level: Level, message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${message}`);
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
