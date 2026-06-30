# Website Automation Agent

An AI-driven browser automation agent built with **Nvidia NIM** (LLM) and **Playwright** (browser control), driven from a **local web dashboard**.

Type a natural-language request naming **any website** and **any action** - the agent opens a real Chromium browser, *understands the page*, and performs the action autonomously while streaming every step (logs, tool calls, vision analysis, and live screenshots) back to the dashboard.

> A mini "Browser Use": an LLM tool-use loop that **plans → observes → acts → verifies**, deciding which browser actions to take to satisfy a free-form request.

---

## What makes it smart

- **Accessibility-tree perception with stable refs.** `get_page_snapshot` tags every visible interactive element with a ref id (`e1`, `e2`, …) and the agent acts **by ref** - far more robust than guessing pixel coordinates or brittle selectors. Refs self-heal: when a page re-renders, the agent just re-snapshots.
- **Hybrid vision.** When the DOM is ambiguous, the agent calls `analyze_screen` to send the screenshot to a **vision model** and ask about it - so it can literally *look* at the screen and verify results.
- **A broad, flexible toolbox (30+ tools).** Navigation, forms, dropdowns, checkboxes, hover, drag-and-drop, file upload, tabs, waiting, keyboard shortcuts, scrolling, an `evaluate_js` escape hatch, and coordinate fallbacks. It can do essentially anything a human can in a browser.
- **Context-aware loop.** A planning-oriented system prompt (observe → plan → act → verify) plus self-correction on tool failures, instead of a rigid hardcoded script.
- **Stop control.** Cancel a run mid-flight from the dashboard.

See [MODEL_RESEARCH.md](MODEL_RESEARCH.md) for how the models were chosen.

---

## What you can ask

The website and the action come entirely from your prompt. Examples:

- `Go to wikipedia.org and search for 'quantum computing', then summarise the first paragraph`
- `Open https://ui.shadcn.com/docs/forms/react-hook-form and fill the Bug Title with 'Test bug' and the Description with 'Filed by the automation agent'`
- `Go to news.ycombinator.com and list the titles of the top 5 posts`
- `Open example.com and take a screenshot`

---

## Architecture Overview

```
Browser dashboard (public/)
   │  POST /run {prompt}   POST /stop      GET /events (SSE)
   ▼                                         ▲
HTTP server (src/server.ts) ──────────────── event bus (src/events.ts)
   │                                         ▲
   ▼                                         │ status / logs / tool calls / vision / screenshots
AgentLoop (src/agent.ts)  ──tool calls──►  BrowserTools (src/tools/browser.ts)
   │                                         │
   ├─ brain  → Nvidia NIM (text, tool calling)
   └─ eyes   → Nvidia NIM (vision)          ▼
                                          Playwright → real Chromium
```

The loop: prompt → LLM plans + picks a tool → server executes it via Playwright → result fed back → repeat until the model replies `TASK_COMPLETE` (or the user stops / the cap is hit). See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

---

## Project Structure

```
public/
├── index.html        - Dashboard markup (header badges, request, summary, screenshots, activity, mobile tabs)
├── styles.css        - Warm green theme, responsive (desktop / tablet / phone)
└── app.js            - SSE stream, run/stop, model badges, live feed, screenshot gallery
src/
├── index.ts          - Entry point (boots the web server)
├── server.ts         - HTTP server: serves UI, POST /run, POST /stop, SSE /events, /health
├── events.ts         - Typed event bus that streams agent steps to the UI
├── agent.ts          - AgentLoop: website-agnostic plan→observe→act→verify tool-use loop
├── config.ts         - Env loader (brain model, vision model, temperature, port, headless)
├── logger.ts         - Timestamped logger (also mirrors to the UI)
└── tools/
    ├── browser.ts    - BrowserTools: all Playwright tool implementations (ref + vision + fallbacks)
    └── definitions.ts - OpenAI-format tool schemas
MODEL_RESEARCH.md     - Model selection writeup with citations
screenshots/          - Saved PNGs (auto-created, cleared each run)
```

---

## Tools Implemented

All assignment-required tools are present (`open_browser`, `navigate_to_url`, `take_screenshot`, `click_on_screen(x,y)`, `double_click(x,y)`, `send_keys`, `scroll`), plus a broad smart toolkit:

| Group | Tools |
|---|---|
| **Lifecycle / nav** | `open_browser`, `close_browser`, `navigate_to_url`, `go_back`, `go_forward`, `reload_page` |
| **Perception** | `get_page_snapshot` (ref-tagged a11y tree), `read_page_text`, `get_page_info`, `take_screenshot`, `analyze_screen` (vision) |
| **Ref-based actions** | `click`, `double_click_element`, `hover`, `fill`, `clear_field`, `select_option`, `set_checkbox`, `scroll_to`, `upload_file`, `drag_and_drop` |
| **Selector fallbacks** | `find_element`, `fill_element` |
| **Coordinate / keyboard** | `click_on_screen`, `double_click`, `send_keys`, `press_key`, `scroll` |
| **Sync** | `wait_for` (text / selector / ms) |
| **Tabs** | `new_tab`, `list_tabs`, `switch_tab`, `close_tab` |
| **Advanced** | `evaluate_js`, `handle_dialog` |

The agent **prefers ref-based tools** (from the snapshot) and falls back to selectors/coordinates/vision when needed.

---

## Setup

### Prerequisites
- Node.js 18+
- A free Nvidia NIM API key - [build.nvidia.com](https://build.nvidia.com)

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
VISION_MODEL=meta/llama-3.2-90b-vision-instruct
VISION_ENABLED=true
TEMPERATURE=0.2
HEADLESS=false
MAX_ITERATIONS=30
PORT=3000
```

**Model choice (short version):** the **brain** (`MODEL`) must support OpenAI-style tool calling - `meta/llama-3.3-70b-instruct` is the reliable default (the only NIM family with automatic, unconditional tool calling). The **eyes** (`VISION_MODEL`) only need image input - `meta/llama-3.2-90b-vision-instruct` is the strongest. Swap recipes (single multimodal brain, strongest tool brain, vision off) and the full rationale are in [MODEL_RESEARCH.md](MODEL_RESEARCH.md) and `.env.example`.

### Run

```bash
npm start
```

Open **http://localhost:3000**, type a request, and click **Run automation**. A Chromium window opens (when `HEADLESS=false`) so you can watch; screenshots, vision analysis, and logs stream into the dashboard. Click **Stop** to cancel.

---

## How It Works

1. The dashboard sends your prompt to `POST /run`.
2. `src/server.ts` opens a fresh browser and starts `AgentLoop.run(prompt, signal)`.
3. `AgentLoop` sends the prompt + a planning system prompt + all tool definitions to the NIM brain.
4. The LLM **plans**, then **observes** (`get_page_snapshot` / `analyze_screen`), **acts** by ref, and **verifies** - looping over tool calls.
5. `BrowserTools` executes each call with Playwright (or the vision model for `analyze_screen`); results feed back to the LLM.
6. Every step is published to an event bus and streamed to the dashboard over Server-Sent Events.
7. The loop ends when the model replies `TASK_COMPLETE`, the user clicks **Stop**, or the iteration cap is hit - then the browser closes.

---

## Dashboard, Logs & Screenshots

- **Header badges** show the active brain + vision models (from `/health`).
- The **Live activity** feed shows every log, tool call (with icons), vision analysis, and result - color-coded, auto-scrolling.
- **Screenshots** stream into a gallery in real time (click to enlarge).
- The final agent summary appears in **Result summary** (with a copy button).
- The dashboard is **responsive**: two columns on desktop, stacked on tablet, and a tab switcher (Activity / Screenshots) on phones.
- All actions are also logged with timestamps to **stdout**.
