import { EventEmitter } from "events";

/**
 * Discriminated union of every event the agent can surface to the web UI.
 * The frontend (public/index.html) switches on `type` to render each kind.
 */
export type AgentEvent =
  | { type: "status"; state: "running" | "done" | "error"; message: string }
  | { type: "iteration"; current: number; max: number }
  | { type: "log"; level: string; message: string; data?: string }
  | { type: "tool-call"; name: string; args: unknown }
  | { type: "tool-result"; name: string; success: boolean; result: unknown }
  | { type: "assistant"; content: string }
  | { type: "screenshot"; name: string; dataUrl: string };

/**
 * Process-wide singleton event bus. The agent, browser tools, and logger all
 * publish here; the HTTP server (src/server.ts) subscribes and forwards every
 * event to connected browsers over Server-Sent Events.
 *
 * Decoupling via a bus (instead of threading callbacks through every method)
 * keeps BrowserTools/AgentLoop unaware of the transport - they just announce
 * what happened and the server decides how to stream it.
 */
class AgentEventBus extends EventEmitter {
  emitEvent(event: AgentEvent): void {
    this.emit("event", event);
  }

  onEvent(listener: (event: AgentEvent) => void): void {
    this.on("event", listener);
  }

  offEvent(listener: (event: AgentEvent) => void): void {
    this.off("event", listener);
  }
}

// A single run streams to potentially many SSE clients, so raise the listener
// cap above Node's default of 10 to avoid spurious MaxListeners warnings.
export const bus = new AgentEventBus();
bus.setMaxListeners(50);
