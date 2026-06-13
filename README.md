# Website Automation Agent

An AI-driven browser automation agent built with **Nvidia NIM** (LLM) and **Playwright** (browser control). The agent autonomously navigates to a target URL, identifies form elements, and fills them in - demonstrating intelligent decision-making via an LLM tool-use loop.

## Target Task

Navigate to [shadcn/ui React Hook Form demo](https://ui.shadcn.com/docs/forms/react-hook-form), locate the **Name** and **Description** form fields, and fill them automatically.

---

## Architecture Overview

```
User Task
   ↓
AgentLoop (src/agent.ts)
   ↓
Nvidia NIM API  ←→  OpenAI-compatible SDK
   ↓
Tool calls dispatched to BrowserTools (src/tools/browser.ts)
   ↓
Playwright controls real Chromium browser
   ↓
Results fed back to LLM → loop until TASK_COMPLETE
```

---

## Project Structure

```
src/
├── index.ts          - Entry point, task definition
├── agent.ts          - AgentLoop: LLM tool-use loop
├── config.ts         - Env var loader
├── logger.ts         - Timestamped logger
└── tools/
    ├── browser.ts    - BrowserTools: all Playwright implementations
    └── definitions.ts - OpenAI-format tool schemas
screenshots/          - Saved PNG screenshots (auto-created)
```

---

## Tools Implemented

| Tool | Description |
|---|---|
| `open_browser` | Launch Chromium via Playwright (idempotent - closes existing instance first) |
| `navigate_to_url` | Navigate to URL, waits for `networkidle` so SPAs finish rendering |
| `take_screenshot` | Capture browser state to timestamped PNG in `screenshots/` |
| `click_on_screen` | Mouse click at pixel (x, y) coordinates |
| `double_click` | Double-click at pixel (x, y) coordinates |
| `send_keys` | Type text into currently focused element (30ms/char delay) |
| `scroll` | Scroll page by pixel deltas via `mouse.wheel` |
| `get_page_snapshot` | Extract headings, inputs, buttons, links as structured text - gives LLM DOM awareness |
| `find_element` | Locate element by CSS selector, return center (x, y) for clicking |
| `fill_element` | Fill form field by CSS selector using Playwright `locator.fill()` - correctly triggers React `onChange` |
| `close_browser` | Close browser and release Playwright resources |

---

## Setup

### Prerequisites
- Node.js 18+
- Nvidia NIM API key ([get one at build.nvidia.com](https://build.nvidia.com))

### Installation

```bash
npm install
npx playwright install chromium
```

### Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
NIM_API_KEY=nvapi-your-key-here
NIM_BASE_URL=https://integrate.api.nvidia.com/v1
MODEL=meta/llama-3.1-8b-instruct
HEADLESS=false
MAX_ITERATIONS=20
```

**Supported NIM models** (must support function/tool calling):
- `meta/llama-3.1-8b-instruct`
- `meta/llama-3.1-70b-instruct`
- `nvidia/llama-3.1-nemotron-70b-instruct`

### Run

```bash
npm start
```

The browser window will open (if `HEADLESS=false`), and you can watch the agent work in real time. Screenshots are saved to the `screenshots/` directory.

---

## How It Works

1. **`src/index.ts`** defines the task and starts the agent.
2. **`AgentLoop.run()`** sends the task + system prompt to Nvidia NIM with all tool definitions.
3. The LLM decides which tools to call (e.g., `navigate_to_url`, `scroll`, `find_element`, `click_on_screen`, `send_keys`).
4. Each tool call is executed by `BrowserTools` using Playwright.
5. The result is appended to the message history and sent back to the LLM.
6. The loop continues until the LLM says `TASK_COMPLETE` or `stop_reason === 'stop'`.

---

## Logs & Screenshots

- All agent actions are logged with timestamps to stdout.
- Screenshots are saved to `screenshots/` after each major action.
- The final LLM response is printed to the console.
