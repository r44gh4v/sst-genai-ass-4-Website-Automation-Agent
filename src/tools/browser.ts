import * as fs from "fs";
import * as path from "path";
import { chromium, Browser, Page } from "playwright";
import { logger } from "../logger";
import { config } from "../config";
import { bus } from "../events";

type ToolResult = { success: true; data: unknown } | { success: false; error: string };

const SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");

/** Wraps Playwright browser operations as discrete tools callable by the LLM agent. All methods return a consistent {success, data|error} envelope. */
export class BrowserTools {
  private browser: Browser | null = null;
  private page: Page | null = null;

  private getPage(): Page {
    if (!this.page) throw new Error("Browser not open. Call open_browser first.");
    return this.page;
  }

  private ensureScreenshotsDir(): void {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
  }

  /**
   * Launches a Chromium browser instance.
   * @param args.headless - Run without a visible window; falls back to config default.
   * Closes any existing instance first so the agent can safely call this tool again without leaking processes.
   */
  async open_browser(args: { headless?: boolean }): Promise<ToolResult> {
    try {
      // Close any existing instance before opening a new one
      if (this.browser) {
        logger.info("Closing existing browser before reopening");
        await this.browser.close();
        this.browser = null;
        this.page = null;
      }
      const headless = args.headless ?? config.headless;
      logger.info("Opening browser", { headless });
      this.browser = await chromium.launch({ headless });
      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      this.page = await context.newPage();
      return { success: true, data: "Browser opened successfully." };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Navigates to a URL and waits for the page to fully settle.
   * @param args.url - Absolute URL to load.
   * Uses `networkidle` so SPAs finish async data fetching and rendering before control returns.
   */
  async navigate_to_url(args: { url: string }): Promise<ToolResult> {
    try {
      logger.info("Navigating to URL", args.url);
      const page = this.getPage();
      await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
      const title = await page.title();
      return { success: true, data: { url: args.url, title } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Captures a viewport screenshot and saves it to the screenshots directory.
   * @param args.filename - Optional base name; a millisecond timestamp is always appended to guarantee uniqueness across runs.
   */
  async take_screenshot(args: { filename?: string }): Promise<ToolResult> {
    try {
      this.ensureScreenshotsDir();
      const ts = Date.now();
      const name = args.filename ? `${args.filename}_${ts}` : `screenshot_${ts}`;
      const filePath = path.join(SCREENSHOTS_DIR, `${name}.png`);
      const page = this.getPage();
      const buffer = await page.screenshot({ path: filePath, fullPage: false });
      logger.info("Screenshot saved", filePath);
      // Stream the image to the web UI as a base64 data URL so the user sees it live.
      bus.emitEvent({
        type: "screenshot",
        name: `${name}.png`,
        dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
      });
      return { success: true, data: { path: filePath } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Fires a single mouse click at absolute pixel coordinates.
   * @param args.x - Horizontal pixel position.
   * @param args.y - Vertical pixel position.
   * `Number()` coerces both coords because the LLM may serialise numeric args as strings.
   */
  async click_on_screen(args: { x: number; y: number }): Promise<ToolResult> {
    try {
      logger.info("Clicking at", args);
      const page = this.getPage();
      await page.mouse.click(Number(args.x), Number(args.y));
      await page.waitForTimeout(300);
      return { success: true, data: `Clicked at (${args.x}, ${args.y})` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Fires a double-click at absolute pixel coordinates.
   * @param args.x - Horizontal pixel position.
   * @param args.y - Vertical pixel position.
   * `Number()` coercion guards against the LLM sending string-typed numeric args.
   */
  async double_click(args: { x: number; y: number }): Promise<ToolResult> {
    try {
      logger.info("Double-clicking at", args);
      const page = this.getPage();
      await page.mouse.dblclick(Number(args.x), Number(args.y));
      await page.waitForTimeout(300);
      return { success: true, data: `Double-clicked at (${args.x}, ${args.y})` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Types text into whichever element currently has focus, key by key.
   * @param args.text - String to type.
   * `delay: 30` ms between keystrokes prevents dropped characters in fast React controlled inputs that debounce onChange.
   */
  async send_keys(args: { text: string }): Promise<ToolResult> {
    try {
      logger.info("Typing text", `"${args.text}"`);
      const page = this.getPage();
      await page.keyboard.type(args.text, { delay: 30 });
      return { success: true, data: `Typed: "${args.text}"` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Scrolls the page by a pixel delta using the mouse wheel.
   * @param args.delta_x - Horizontal scroll amount in pixels.
   * @param args.delta_y - Vertical scroll amount in pixels.
   * `mouse.wheel` emulates natural browser scrolling and fires scroll event listeners, unlike JS `window.scrollBy`.
   */
  async scroll(args: { delta_x: number; delta_y: number }): Promise<ToolResult> {
    try {
      logger.info("Scrolling", args);
      const page = this.getPage();
      await page.mouse.wheel(Number(args.delta_x), Number(args.delta_y));
      await page.waitForTimeout(500);
      return { success: true, data: `Scrolled by (${args.delta_x}, ${args.delta_y})` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Returns a structured text summary of the page's headings, inputs, buttons, and links.
   * `page.evaluate` runs inside the browser context to extract DOM structure as plain text,
   * giving the LLM a low-token representation of the page without requiring vision/screenshot parsing.
   */
  async get_page_snapshot(): Promise<ToolResult> {
    try {
      const page = this.getPage();
      // Extract visible text and interactive elements from the DOM
      const snapshot = await page.evaluate(() => {
        const elements: string[] = [];

        // Collect headings
        document.querySelectorAll("h1,h2,h3,h4").forEach((el) => {
          elements.push(`[${el.tagName}] ${el.textContent?.trim()}`);
        });

        // Collect inputs, textareas, selects
        document.querySelectorAll("input,textarea,select").forEach((el) => {
          const input = el as HTMLInputElement;
          const label = input.labels?.[0]?.textContent?.trim() ?? "";
          const id = input.id ? `#${input.id}` : "";
          const name = input.name ? `name="${input.name}"` : "";
          const placeholder = input.placeholder ? `placeholder="${input.placeholder}"` : "";
          const type = input.type ?? el.tagName.toLowerCase();
          elements.push(`[INPUT type=${type}${id} ${name} ${placeholder}] label="${label}"`);
        });

        // Collect buttons
        document.querySelectorAll("button").forEach((el) => {
          elements.push(`[BUTTON] "${el.textContent?.trim()}"`);
        });

        // Collect links
        document.querySelectorAll("a[href]").forEach((el) => {
          const text = el.textContent?.trim();
          if (text) elements.push(`[LINK] "${text}"`);
        });

        return elements.join("\n");
      });

      return { success: true, data: snapshot };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Locates a DOM element by CSS/Playwright selector and returns its centre pixel coordinates.
   * @param args.selector - Any Playwright-compatible selector string.
   * Centre is computed from `boundingBox()` so the returned (x, y) can be passed directly to `click_on_screen`.
   */
  async find_element(args: { selector: string }): Promise<ToolResult> {
    try {
      logger.info("Finding element", args.selector);
      const page = this.getPage();
      const locator = page.locator(args.selector).first();
      const box = await locator.boundingBox({ timeout: 5_000 });
      if (!box) {
        return { success: false, error: `Element "${args.selector}" found but has no bounding box (possibly hidden).` };
      }
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      return { success: true, data: { selector: args.selector, x, y, width: box.width, height: box.height } };
    } catch (e) {
      return { success: false, error: `Element "${args.selector}" not found: ${String(e)}` };
    }
  }

  /**
   * Fills a form field identified by selector with the given text.
   * @param args.selector - CSS/Playwright selector for the input or textarea.
   * @param args.text - Value to set.
   * `scrollIntoViewIfNeeded` ensures the element is visible, then `fill()` atomically sets the value and
   * triggers React's synthetic onChange - unlike click+send_keys which can miss controlled-input state updates.
   */
  async fill_element(args: { selector: string; text: string }): Promise<ToolResult> {
    try {
      logger.info("Filling element", { selector: args.selector, text: args.text });
      const page = this.getPage();
      const locator = page.locator(args.selector).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await locator.click({ timeout: 5_000 });
      await locator.fill(args.text, { timeout: 5_000 });
      return { success: true, data: `Filled "${args.selector}" with: "${args.text}"` };
    } catch (e) {
      return { success: false, error: `fill_element failed for "${args.selector}": ${String(e)}` };
    }
  }

  /** Closes the browser and resets internal state; safe to call even if no browser is open. */
  async close_browser(): Promise<ToolResult> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        logger.info("Browser closed.");
      }
      return { success: true, data: "Browser closed." };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * Dispatches a tool call from the LLM to the correct method by name.
   * @param toolName - Exact function name as declared in the tool definitions schema.
   * @param args - Parsed JSON arguments object from the LLM response.
   * An explicit switch is used instead of reflection so TypeScript can verify every case at compile time
   * and unknown tool names are caught safely rather than causing a runtime property access error.
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case "open_browser":       return this.open_browser(args as { headless?: boolean });
      case "navigate_to_url":    return this.navigate_to_url(args as { url: string });
      case "take_screenshot":    return this.take_screenshot(args as { filename?: string });
      case "click_on_screen":    return this.click_on_screen(args as { x: number; y: number });
      case "double_click":       return this.double_click(args as { x: number; y: number });
      case "send_keys":          return this.send_keys(args as { text: string });
      case "scroll":             return this.scroll(args as { delta_x: number; delta_y: number });
      case "get_page_snapshot":  return this.get_page_snapshot();
      case "find_element":       return this.find_element(args as { selector: string });
      case "fill_element":       return this.fill_element(args as { selector: string; text: string });
      case "close_browser":      return this.close_browser();
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  }
}
