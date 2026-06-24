# Architecture Document

## 1. Goal

Build an autonomous website automation agent that, given a **free-form natural-language request** naming any website and any action, drives a real browser to perform it - exposed through a local web UI. This is a mini version of tools like *Browser Use*.

## 2. High-level design

```
┌─────────────────────────────────────────────────────────────┐
│ Browser (public/index.html)                                  │
│   • prompt box + examples                                    │
│   • live activity feed   ◄── Server-Sent Events (/events)    │
│   • screenshot gallery                                       │
└───────────────┬───────────────────────────▲─────────────────┘
        POST /run {prompt}                   │ stream events
                ▼                            │
┌─────────────────────────────────────────────────────────────┐
│ HTTP server (src/server.ts)                                  │
│   • serves the UI, accepts /run, fans events to SSE clients  │
│   • one run at a time (busy guard), opens/closes the browser │
└───────────────┬─────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────┐
│ AgentLoop (src/agent.ts)  - ReAct-style tool-use loop        │
│   system prompt + user task ─► Nvidia NIM (OpenAI SDK)        │
│   model returns tool calls ─► execute ─► feed results back   │
│   repeat until TASK_COMPLETE or max iterations               │
└───────────────┬─────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────┐
│ BrowserTools (src/tools/browser.ts)  - Playwright wrappers    │
│   open_browser, navigate_to_url, get_page_snapshot,          │
│   find_element, fill_element, click_on_screen, double_click,  │
│   send_keys, scroll, take_screenshot, close_browser           │
└──────────────────────────────────────────────────────────────┘

           event bus (src/events.ts) ── decouples all of the above
                  from the SSE transport (publish/subscribe)
```

## 3. Key design decisions

### 3.1 Agent loop (ReAct pattern)
The LLM is the planner. On each iteration it sees the full conversation (system prompt, user task, prior assistant turns, prior tool results) and either calls tools or stops. The model has no memory between API calls, so the **entire history is re-sent every iteration**. The loop drains *all* tool calls in a response before the next API call, because the OpenAI tool-calling protocol requires every `tool_call_id` to have a matching `tool` result message.

A hard `MAX_ITERATIONS` cap prevents runaway loops from burning API quota or hanging.

### 3.2 Website- and task-agnostic
The previous version hardcoded the URL and a shadcn-specific task. Now the **system prompt is generic** and the concrete website + action arrive only via the user's prompt. The agent itself navigates (`navigate_to_url`) and discovers the page (`get_page_snapshot`) before acting - no per-site code.

### 3.3 Element detection strategy
Two complementary tools give the LLM "eyes":
- `get_page_snapshot` extracts headings, inputs (with labels/names/placeholders), buttons, and links as compact text - low-token DOM awareness without vision.
- `find_element` resolves a CSS selector to center `(x, y)` coordinates for coordinate-based clicks.

For form fields, `fill_element` uses Playwright's `locator.fill()`, which atomically sets the value and fires React's synthetic `onChange` - more reliable than click + per-key typing on controlled inputs.

### 3.4 Streaming via an event bus
A single `EventEmitter` singleton (`src/events.ts`) decouples the agent/tools/logger from the HTTP transport. They just publish typed `AgentEvent`s; the server subscribes once and forwards each to all connected browsers over **Server-Sent Events**. SSE (not WebSockets) is the right fit: the stream is one-directional (server → UI) and works over plain HTTP with no extra dependencies.

Screenshots are streamed as base64 data URLs so they render in the UI the instant they are captured.

### 3.5 Zero extra runtime dependencies
The server uses only Node's built-in `http` module. The whole stack is `playwright` + `openai` + `dotenv` - nothing added for the web layer - keeping setup friction minimal.

### 3.6 Concurrency & lifecycle
The browser is a single shared resource, so the server enforces **one run at a time** (a `busy` flag → HTTP 409 while busy). Each run opens a fresh browser, clears old screenshots, and the `finally` block guarantees the browser closes even on error.

## 4. Error handling

- Every `BrowserTools` method returns a `{ success, data | error }` envelope; failures are fed back to the LLM as tool results so it can adapt (scroll, re-snapshot, try another selector) instead of crashing.
- `navigate_to_url` uses a 30 s timeout with `networkidle`.
- The agent loop wraps argument parsing and surfaces a clear error if the model exceeds `MAX_ITERATIONS`.
- The server catches run failures and emits a `status:error` event so the UI shows the reason.

## 5. Configuration

All settings come from environment variables (`.env`), loaded in `src/config.ts`:
`NIM_API_KEY` (required), `NIM_BASE_URL`, `MODEL`, `HEADLESS`, `MAX_ITERATIONS`, `PORT`.
The model must support OpenAI-style function/tool calling.

## 6. Possible extensions
- Multi-session support (one browser/agent per client) instead of a global single run.
- A "stop" control to abort a run mid-flight.
- Vision: feed screenshots to a multimodal model for purely visual element detection.
- Persisted run history and downloadable screenshot bundles.
