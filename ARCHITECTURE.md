# Architecture Document - Website Automation Agent

## Design Goals

1. **Modular tools** - each browser capability is an independent method; new tools can be added without touching the agent loop.
2. **LLM-driven intelligence** - the agent decides action order, handles failures, and adapts based on page snapshots.
3. **Observability** - every tool call is logged with inputs and outputs; screenshots provide visual audit trail.
4. **Simplicity** - no frameworks or extra abstractions beyond what the task requires.

---

## Component Breakdown

### `src/config.ts`
Loads environment variables via `dotenv`. Validates required keys at startup (throws if missing). Exports a typed `config` object consumed by all other modules.

### `src/logger.ts`
Simple timestamped logger. Four levels: `INFO`, `WARN`, `ERROR`, `TOOL`. The `tool` method logs both the input args and output result for every tool invocation, making the agent's decision trace easy to audit.

### `src/tools/definitions.ts`
Exports `TOOL_DEFINITIONS` - an array of OpenAI-format `ChatCompletionTool` objects. Each entry has a JSON Schema `parameters` block describing what the tool accepts. This array is passed directly to the NIM API on every request so the LLM knows what actions are available.

### `src/tools/browser.ts` - `BrowserTools`
Wraps Playwright. Holds a single `Browser` + `Page` instance (singleton pattern). Each public method corresponds to one tool:

- **`open_browser`** - launches Chromium with a fixed 1280×900 viewport. Idempotent: closes any existing instance first so the LLM can call it safely more than once.
- **`navigate_to_url`** - uses `waitUntil: 'networkidle'` to ensure the page (including any SPA hydration) is fully rendered before returning.
- **`take_screenshot`** - saves to `screenshots/<name>_<timestamp>.png`; auto-creates the directory and always appends a Unix timestamp to prevent filename collisions across runs.
- **`click_on_screen`** / **`double_click`** - raw mouse operations at pixel coordinates. Args are coerced with `Number()` because LLMs sometimes serialize numeric JSON values as strings.
- **`send_keys`** - types into the currently focused element with a 30ms delay per character to avoid dropped keystrokes in fast React controlled inputs.
- **`scroll`** - uses `page.mouse.wheel()` for natural browser scrolling that triggers scroll event listeners.
- **`get_page_snapshot`** - runs `page.evaluate()` to extract headings, inputs, buttons, and links as structured text. Gives the LLM DOM awareness without requiring vision/screenshot analysis.
- **`find_element`** - uses Playwright's `locator().boundingBox()` to return the center (x, y) of any CSS-selectable element, enabling precise coordinate-based clicks.
- **`fill_element`** - fills a form field by CSS selector using `locator.fill()`. Scrolls into view, clicks, then fills - correctly triggers React `onChange` events unlike raw `keyboard.type()`.
- **`close_browser`** - frees Playwright resources. Safe to call even if browser is already closed.

All methods return `{ success: true, data }` or `{ success: false, error }` - a consistent envelope the LLM can reason about and retry on failure.

The `execute(name, args)` dispatcher routes LLM tool call names to the correct method using a `switch` statement (compile-time exhaustiveness check, no runtime reflection).

### `src/agent.ts` - `AgentLoop`
Implements the core agentic loop:

```
messages = [system_prompt, user_task]
loop (max MAX_ITERATIONS):
  response = NIM_API(model, tools, messages)
  if finish_reason == "stop": print response, exit
  for each tool_call in response:
    result = BrowserTools.execute(tool_name, args)
    append tool_result to messages
```

Key design decisions:
- **System prompt** instructs the LLM to use `fill_element` for form fields (most reliable for React inputs), take screenshots after each action, and respond `TASK_COMPLETE` when done.
- **Full conversation history resent each iteration** - the NIM API is stateless; all prior messages must be included so the LLM retains context of what it has done.
- **All tool calls in one response executed before next API call** - matches the OpenAI parallel function calling spec; the LLM sees all results together.
- **Max iterations guard** prevents runaway loops and API quota burn; browser still closes via `finally`.

### `src/index.ts`
Entry point. Opens the browser before handing control to the agent (so `open_browser` tool is optional during the run - the agent won't need to call it). Wraps execution in `try/finally` to guarantee `close_browser()` always runs.

---

## Agent Workflow for Target Task

`index.ts` pre-navigates to the target URL before handing off to the agent, so the LLM starts with the page already loaded.

```
[index.ts] open_browser()
[index.ts] navigate_to_url("https://ui.shadcn.com/docs/forms/react-hook-form")
           ↓ agent loop starts
Iteration 1 (LLM tool calls):
  fill_element("input[name='title']", "John Doe")       ← scrolls, clicks, fills Bug Title
  take_screenshot("after_title")                         ← visual confirmation
  fill_element("textarea[name='description']", "...")   ← fills Description
  take_screenshot("after_description")                   ← visual confirmation

Iteration 2:
  LLM responds: TASK_COMPLETE
```

Key intelligence points:
- `get_page_snapshot` can be called at any time to understand the current DOM structure
- `find_element` returns precise (x, y) coordinates enabling coordinate-based clicks when needed
- The LLM selects correct CSS selectors (`name="title"`, `name="description"`) autonomously based on the task description and page snapshot
- If `fill_element` fails, the LLM retries with alternative selectors or scrolls first

---

## Error Handling Strategy

| Scenario | Handling |
|---|---|
| Network timeout on navigation | 30s timeout; returns error string to LLM |
| Element not found by selector | `find_element` returns descriptive error; LLM retries with alternative selector |
| Screenshot failure | Logged + error returned; agent continues |
| Max iterations exceeded | Throws with message; browser still closed via `finally` |
| Missing env var | `config.ts` throws at startup with clear message |

---

## Technology Choices

**TypeScript** - Type safety across tool definitions and API responses prevents silent bugs in argument passing.

**Playwright** - More reliable than Puppeteer for modern SPAs (better waitForSelector, network idle, locator API). Official support for Chromium, Firefox, WebKit.

**Nvidia NIM** - OpenAI-compatible API means the `openai` npm package works without modification. NIM hosts leading open-source models (Llama, Nemotron) with tool-calling support.

**`openai` npm package** - Mature, well-typed SDK. The `baseURL` override is the only change needed to point it at NIM instead of OpenAI.
