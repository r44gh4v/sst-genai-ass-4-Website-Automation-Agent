# Website Automation Agent

An AI-driven browser automation agent built with **Nvidia NIM** (LLM) and **Playwright** (browser control), driven from a **local web UI**.

Type a natural-language request naming **any website** and **any action** - the agent opens a real Chromium browser, figures out the page, and performs the action autonomously while streaming every step (logs, tool calls, and live screenshots) back to the web page.

> This is a mini "Browser Use": an LLM tool-use loop deciding which browser actions to take to satisfy a free-form request.

---

## What you can ask

The website and the action are **not hardcoded** - they come entirely from your prompt. Examples:

- `Go to wikipedia.org and search for 'quantum computing'`
- `Open https://ui.shadcn.com/docs/forms/react-hook-form and fill the Bug Title with 'Test bug' and the Description with 'Filed by the automation agent'`
- `Go to duckduckgo.com and search for 'playwright automation'`
- `Open example.com and take a screenshot`

---

## Architecture Overview

```
Browser UI (public/index.html)
   │  POST /run {prompt}                    GET /events (SSE)
   ▼                                         ▲
HTTP server (src/server.ts) ──────────────── event bus (src/events.ts)
   │                                         ▲
   ▼                                         │ emits status / logs / tool calls / screenshots
AgentLoop (src/agent.ts)  ──tool calls──►  BrowserTools (src/tools/browser.ts)
   │                                         │
   ▼                                         ▼
Nvidia NIM (OpenAI-compatible SDK)        Playwright → real Chromium
```

The loop: prompt → LLM picks a tool → server executes it via Playwright → result fed back → repeat until the model replies `TASK_COMPLETE`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

---

## Project Structure

```
public/
├── index.html        - Web UI markup
├── styles.css        - Light, green-themed responsive styles
└── app.js            - Frontend logic: SSE stream, run controls, screenshot gallery
src/
├── index.ts          - Entry point (boots the web server)
├── server.ts         - HTTP server: serves UI, POST /run, SSE /events
├── events.ts         - Typed event bus that streams agent steps to the UI
├── agent.ts          - AgentLoop: website-agnostic LLM tool-use loop
├── config.ts         - Env var loader (API key, model, port, headless)
├── logger.ts         - Timestamped logger (also mirrors to the UI)
└── tools/
    ├── browser.ts    - BrowserTools: all Playwright tool implementations
    └── definitions.ts - OpenAI-format tool schemas
screenshots/          - Saved PNGs (auto-created, cleared each run)
```

---

## Tools Implemented

All required capabilities are present as composable, LLM-callable tools:

| Tool | Description |
|---|---|
| `open_browser` | Launch Chromium via Playwright (idempotent - closes any existing instance first) |
| `navigate_to_url` | Navigate to a URL, waits for `networkidle` so SPAs finish rendering |
| `take_screenshot` | Capture browser state to a timestamped PNG **and stream it live to the UI** |
| `click_on_screen` | Mouse click at pixel `(x, y)` coordinates |
| `double_click` | Double-click at pixel `(x, y)` coordinates |
| `send_keys` | Type text into the currently focused element (30 ms/char) |
| `scroll` | Scroll the page by pixel deltas via `mouse.wheel` |
| `get_page_snapshot` | Extract headings, inputs, buttons, links as structured text - gives the LLM DOM awareness |
| `find_element` | Locate an element by CSS selector, return its center `(x, y)` for clicking |
| `fill_element` | Fill a form field by selector via `locator.fill()` - correctly triggers React `onChange` |
| `close_browser` | Close the browser and release Playwright resources |

---

## Setup

### Prerequisites
- Node.js 18+
- An Nvidia NIM API key - get one free at [build.nvidia.com](https://build.nvidia.com)

### Installation

```bash
npm install
npx playwright install chromium
```

### Configuration

Copy `.env.example` to `.env` and fill in your key:

```bash
cp .env.example .env
```

```env
NIM_API_KEY=nvapi-your-key-here
NIM_BASE_URL=https://integrate.api.nvidia.com/v1
MODEL=meta/llama-3.3-70b-instruct
HEADLESS=false
MAX_ITERATIONS=25
PORT=3000
```

**Model choice:** the loop relies on OpenAI-style **function/tool calling**, so pick a NIM model that supports it. `meta/llama-3.3-70b-instruct` is recommended (large instruct model, reliable tool calling). Alternatives: `nvidia/llama-3.1-nemotron-70b-instruct`, `meta/llama-3.1-70b-instruct`.

### Run

```bash
npm start
```

Then open **http://localhost:3000**, type a request, and click **Run automation**. A Chromium window opens (when `HEADLESS=false`) so you can watch the agent work; screenshots and logs also stream into the page.

---

## How It Works

1. The browser UI sends your prompt to `POST /run`.
2. `src/server.ts` opens a fresh browser and starts `AgentLoop.run(prompt)`.
3. `AgentLoop` sends the prompt + a generic system prompt + all tool definitions to Nvidia NIM.
4. The LLM decides which tools to call (`navigate_to_url`, `get_page_snapshot`, `fill_element`, `click_on_screen`, …).
5. `BrowserTools` executes each call with Playwright; results are fed back to the LLM.
6. Every step is published to an event bus and streamed to the browser over Server-Sent Events.
7. The loop ends when the model replies `TASK_COMPLETE` (or hits the iteration cap), then the browser closes.

---

## Logs & Screenshots

- Every action is logged with timestamps to **stdout** and mirrored to the **Live activity** panel in the UI.
- Screenshots are saved to `screenshots/` and appear in the UI gallery in real time (click to enlarge).
- The final agent summary is shown in the **Result summary** panel.
