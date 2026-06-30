import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { config } from "../config";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
});

const fn = (name: string, description: string, parameters: ReturnType<typeof obj>): ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters },
});

/**
 * The agent's full toolbox. Two action styles:
 *  - REF-based (preferred): act on elements via the `ref` ids from get_page_snapshot.
 *  - Coordinate/selector-based: fallbacks for visual or non-standard widgets.
 * analyze_screen (vision) is only exposed when VISION is enabled.
 */
const ALL_TOOLS: ChatCompletionTool[] = [
  // ── Lifecycle & navigation ──
  fn("open_browser", "Launch the Chromium browser. Already called automatically at run start; only call again to reset.",
    obj({ headless: { type: "boolean", description: "Run with no visible window. Default false." } })),
  fn("navigate_to_url", "Go to a URL and wait for it to load. Infer the full URL (add https:// if missing).",
    obj({ url: { type: "string", description: "Full URL, e.g. https://example.com" } }, ["url"])),
  fn("go_back", "Navigate back to the previous page in history.", obj({})),
  fn("go_forward", "Navigate forward in history.", obj({})),
  fn("reload_page", "Reload the current page.", obj({})),
  fn("close_browser", "Close the browser and release resources (done automatically at run end).", obj({})),

  // ── Perception ──
  fn("get_page_snapshot", "PRIMARY way to see the page: returns the URL, headings, and every visible interactive element tagged with a stable `ref` id (e1, e2, …). Act on elements by ref. Call this after navigating or whenever the page changes.",
    obj({})),
  fn("read_page_text", "Read the page's visible text content (for articles, search results, confirmations).",
    obj({ max_chars: { type: "number", description: "Max characters to return. Default 4000." } })),
  fn("get_page_info", "Get the current page URL and title without a full snapshot.", obj({})),
  fn("take_screenshot", "Capture the current view as a PNG and stream it to the UI. Use after meaningful steps so the user sees progress.",
    obj({ filename: { type: "string", description: "Optional base name (auto-timestamped)." } })),

  // ── Ref-based actions (preferred) ──
  fn("click", "Click an element by its snapshot ref. Preferred over coordinates for buttons, links, checkboxes, tabs.",
    obj({ ref: { type: "string", description: "Element ref from get_page_snapshot, e.g. \"e5\"." } }, ["ref"])),
  fn("double_click_element", "Double-click an element by its snapshot ref.",
    obj({ ref: { type: "string", description: "Element ref, e.g. \"e5\"." } }, ["ref"])),
  fn("hover", "Hover the mouse over an element by ref (reveals menus/tooltips).",
    obj({ ref: { type: "string", description: "Element ref." } }, ["ref"])),
  fn("fill", "Fill a text input/textarea by ref. Atomically sets the value and fires React onChange. PREFER this for form fields.",
    obj({ ref: { type: "string", description: "Element ref of the input/textarea." }, text: { type: "string", description: "Text to enter." } }, ["ref", "text"])),
  fn("clear_field", "Clear the text of an input/textarea by ref.",
    obj({ ref: { type: "string", description: "Element ref." } }, ["ref"])),
  fn("select_option", "Choose an option in a <select> dropdown by ref.",
    obj({ ref: { type: "string", description: "Element ref of the select." }, value: { type: "string", description: "Option value or visible label." } }, ["ref", "value"])),
  fn("set_checkbox", "Check or uncheck a checkbox/radio/switch by ref.",
    obj({ ref: { type: "string", description: "Element ref." }, checked: { type: "boolean", description: "true to check, false to uncheck." } }, ["ref", "checked"])),
  fn("scroll_to", "Scroll an element into view by ref.",
    obj({ ref: { type: "string", description: "Element ref." } }, ["ref"])),
  fn("upload_file", "Upload local file(s) into a file input by ref.",
    obj({ ref: { type: "string", description: "Element ref of the file input." }, file_paths: { type: "array", items: { type: "string" }, description: "Absolute file path(s)." } }, ["ref", "file_paths"])),
  fn("drag_and_drop", "Drag one element onto another, both by ref.",
    obj({ source_ref: { type: "string", description: "Ref to drag." }, target_ref: { type: "string", description: "Ref to drop onto." } }, ["source_ref", "target_ref"])),

  // ── Selector-based fallbacks ──
  fn("find_element", "Locate an element by CSS selector and return its centre (x, y). Use when you need coordinates for a coordinate click.",
    obj({ selector: { type: "string", description: "CSS selector, e.g. 'button:has-text(\"Submit\")'." } }, ["selector"])),
  fn("fill_element", "Fill a field by CSS selector (use when no ref is available).",
    obj({ selector: { type: "string", description: "CSS selector of the input/textarea." }, text: { type: "string", description: "Text to enter." } }, ["selector", "text"])),

  // ── Coordinate & keyboard ──
  fn("click_on_screen", "Click at absolute pixel (x, y). Fallback for canvas/visual targets when no ref/selector works.",
    obj({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"])),
  fn("drag_on_screen", "Click-and-drag from pixel (x1, y1) to pixel (x2, y2). Use for canvas drawing apps (e.g. Excalidraw): first use analyze_screen to identify tool button coordinates, click_on_screen to select the tool, then drag_on_screen to draw the shape.",
    obj({ x1: { type: "number", description: "Start X pixel" }, y1: { type: "number", description: "Start Y pixel" }, x2: { type: "number", description: "End X pixel" }, y2: { type: "number", description: "End Y pixel" } }, ["x1", "y1", "x2", "y2"])),
  fn("double_click", "Double-click at absolute pixel (x, y).",
    obj({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"])),
  fn("send_keys", "Type text into the currently focused element, key by key.",
    obj({ text: { type: "string" } }, ["text"])),
  fn("press_key", "Press a key or chord, e.g. \"Enter\", \"Escape\", \"Tab\", \"Control+A\", \"ArrowDown\".",
    obj({ key: { type: "string" } }, ["key"])),
  fn("scroll", "Scroll the page by pixel deltas (positive y = down).",
    obj({ delta_x: { type: "number" }, delta_y: { type: "number" } }, ["delta_x", "delta_y"])),

  // ── Sync ──
  fn("wait_for", "Wait until text appears, a selector attaches, or a fixed delay passes. Use after actions that trigger async updates.",
    obj({ text: { type: "string", description: "Text to wait for." }, selector: { type: "string", description: "CSS selector to wait for." }, ms: { type: "number", description: "Or just wait this many ms." } })),

  // ── Tabs ──
  fn("new_tab", "Open a new browser tab (optionally navigate it) and make it active.",
    obj({ url: { type: "string", description: "Optional URL to open." } })),
  fn("list_tabs", "List all open tabs with their index, url, and title.", obj({})),
  fn("switch_tab", "Switch the active tab by index.",
    obj({ index: { type: "number" } }, ["index"])),
  fn("close_tab", "Close a tab by index (defaults to the active tab).",
    obj({ index: { type: "number" } })),

  // ── Advanced ──
  fn("evaluate_js", "Run arbitrary JavaScript in the page and return the result. Powerful escape hatch for custom extraction or interactions.",
    obj({ script: { type: "string", description: "JS expression/function body, e.g. \"document.title\" or \"() => [...document.querySelectorAll('h2')].map(e=>e.innerText)\"." } }, ["script"])),
  fn("handle_dialog", "Pre-decide how the next native dialog (alert/confirm/prompt) is handled.",
    obj({ accept: { type: "boolean", description: "true to accept (default), false to dismiss." }, prompt_text: { type: "string", description: "Text for a prompt() dialog." } })),
];

const VISION_TOOL = fn(
  "analyze_screen",
  "VISION: send the current screenshot to a vision model and ask about it. Use when the DOM snapshot is unclear, to locate elements visually, or to verify the visible result of an action.",
  obj({ question: { type: "string", description: "What to look for / ask about the screen." } }),
);

export const TOOL_DEFINITIONS: ChatCompletionTool[] = config.visionEnabled
  ? [...ALL_TOOLS, VISION_TOOL]
  : ALL_TOOLS;
