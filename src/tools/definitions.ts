import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "open_browser",
      description: "Initialize and launch a browser instance. Must be called before any other browser action.",
      parameters: {
        type: "object",
        properties: {
          headless: {
            type: "boolean",
            description: "Run browser in headless mode (no visible window). Default false.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate_to_url",
      description: "Direct the browser to a specific URL and wait for the page to load.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full URL to navigate to (e.g. https://example.com).",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Capture the current state of the browser window as a PNG image. Returns the saved file path.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Optional filename (without path/extension). Auto-timestamped if omitted.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_on_screen",
      description: "Perform a mouse click at the specified (x, y) pixel coordinates on the page.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "Horizontal pixel coordinate." },
          y: { type: "number", description: "Vertical pixel coordinate." },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "double_click",
      description: "Perform a double mouse click at the specified (x, y) pixel coordinates.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "Horizontal pixel coordinate." },
          y: { type: "number", description: "Vertical pixel coordinate." },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_keys",
      description: "Type text into the currently focused element (e.g. after clicking a form field).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to type." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page by the given pixel deltas.",
      parameters: {
        type: "object",
        properties: {
          delta_x: { type: "number", description: "Horizontal scroll amount in pixels (positive = right)." },
          delta_y: { type: "number", description: "Vertical scroll amount in pixels (positive = down)." },
        },
        required: ["delta_x", "delta_y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_snapshot",
      description: "Return a simplified text snapshot of the current page DOM - useful for understanding page structure and finding element selectors without a screenshot.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_element",
      description: "Locate an element by CSS selector or text content and return its center (x, y) coordinates. Use this to find exact click coordinates for form fields and buttons.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector (e.g. 'input[name=username]', 'button:has-text(\"Submit\")', '#my-id').",
          },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill_element",
      description: "Fill a form field with text using its CSS selector. Scrolls to the element, clicks it, clears existing content, and types the text. PREFER this over click_on_screen + send_keys for form inputs and textareas.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector for the input or textarea (e.g. 'input[name=\"title\"]', 'textarea[name=\"description\"]').",
          },
          text: {
            type: "string",
            description: "The text to fill into the field.",
          },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_browser",
      description: "Close the browser instance and release resources.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];
