import * as fs from "fs";
import * as path from "path";
import { chromium, Browser, BrowserContext, Page, Dialog } from "playwright";
import type OpenAI from "openai";
import { logger } from "../logger";
import { config } from "../config";
import { bus } from "../events";

type ToolResult = { success: true; data: unknown } | { success: false; error: string };

const BASE_SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");

type Snapshot = { url: string; title: string; headings: string[]; elements: string[]; count: number };

/**
 * The DOM walker that runs INSIDE the page to build an accessibility-style snapshot.
 * Every visible interactive element is tagged with a stable `data-agent-ref` attribute
 * and a short ref id (e1, e2, ...); the agent then acts on elements BY REF - far more
 * robust than pixel coordinates or brittle CSS selectors.
 *
 * IMPORTANT: this is a STRING evaluated as an expression in the browser, NOT a passed
 * function. tsx/esbuild rewrites named inner functions with a `__name(...)` helper that
 * does not exist in the page context, so a serialized function would throw
 * "__name is not defined". Keeping the code as a string literal sidesteps that entirely.
 * It is an IIFE returning a Snapshot; MAX_SNAPSHOT_ELEMENTS is inlined below.
 */
const MAX_SNAPSHOT_ELEMENTS = 200;
const SNAPSHOT_JS = `(() => {
  var MAX = ${MAX_SNAPSHOT_ELEMENTS};
  var SEL = "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=option],[role=searchbox],[role=textbox],[contenteditable=''],[contenteditable=true],summary,[onclick]";
  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    var style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    return true;
  }
  function accName(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.labels && el.labels.length) return (el.labels[0].textContent || "").trim();
    var ph = el.getAttribute("placeholder");
    if (ph) return ph.trim();
    if (el.value) return String(el.value).trim();
    var title = el.getAttribute("title");
    if (title) return title.trim();
    var alt = el.getAttribute("alt");
    if (alt) return alt.trim();
    return (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  }
  document.querySelectorAll("[data-agent-ref]").forEach(function (el) { el.removeAttribute("data-agent-ref"); });
  var lines = [];
  var i = 0;
  var nodes = document.querySelectorAll(SEL);
  for (var n = 0; n < nodes.length; n++) {
    var el = nodes[n];
    if (i >= MAX || !isVisible(el)) continue;
    var ref = "e" + (++i);
    el.setAttribute("data-agent-ref", ref);
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role") || (tag === "a" ? "link" : tag);
    var extra = "";
    if (tag === "input" || tag === "textarea") {
      var t = el.getAttribute("type") || "text";
      extra += " type=" + t;
      if (el.value) extra += ' value="' + String(el.value).slice(0, 40) + '"';
      if ((t === "checkbox" || t === "radio") && el.checked !== undefined) extra += " checked=" + el.checked;
    }
    if (tag === "select" && el.value) extra += ' value="' + el.value + '"';
    var nm = accName(el).replace(/"/g, "'");
    lines.push("[" + ref + "] <" + role + extra + '> "' + nm + '"');
  }
  var headings = [];
  var hs = document.querySelectorAll("h1,h2,h3");
  for (var h = 0; h < hs.length && headings.length < 15; h++) {
    var ht = (hs[h].textContent || "").replace(/\\s+/g, " ").trim();
    if (ht) headings.push("(" + hs[h].tagName + ") " + ht);
  }
  return { url: location.href, title: document.title, headings: headings, elements: lines, count: lines.length };
})()`;

/**
 * Wraps Playwright as a broad, flexible toolkit callable by the LLM agent.
 * Two action styles coexist:
 *  - REF-based (preferred): act on elements by the `ref` ids from get_page_snapshot.
 *  - Coordinate/selector-based (fallback): for visual or non-standard widgets.
 * Every method returns a consistent {success, data|error} envelope so failures feed
 * back to the model as observations instead of crashing the run.
 */
export class BrowserTools {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private client: OpenAI;
  private screenshotsDir: string = BASE_SCREENSHOTS_DIR;
  private dialogAction: "accept" | "dismiss" = "accept";
  private dialogPromptText = "";

  /** @param client - LLM client reused for the vision model (analyze_screen). */
  constructor(client: OpenAI) {
    this.client = client;
  }

  /** Call once per agent run to set a timestamped screenshot subfolder. */
  startRun(runId: string): void {
    this.screenshotsDir = path.join(BASE_SCREENSHOTS_DIR, runId);
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
  }

  private getPage(): Page {
    if (!this.page) throw new Error("Browser not open. Call open_browser first.");
    return this.page;
  }

  /** Resolve a snapshot ref (e.g. "e7") to a Playwright locator. */
  private byRef(ref: string) {
    const clean = String(ref).trim();
    return this.getPage().locator(`[data-agent-ref="${clean}"]`).first();
  }

  private ensureScreenshotsDir(): void {
    if (!fs.existsSync(this.screenshotsDir)) fs.mkdirSync(this.screenshotsDir, { recursive: true });
  }

  private async autoScreenshot(label: string): Promise<void> {
    try {
      this.ensureScreenshotsDir();
      const ts = Date.now();
      const name = `${label}_${ts}`;
      const filePath = path.join(this.screenshotsDir, `${name}.png`);
      const buffer = await this.getPage().screenshot({ path: filePath, fullPage: false });
      bus.emitEvent({ type: "screenshot", name: `${name}.png`, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` });
    } catch { /* non-fatal */ }
  }

  // ── Lifecycle & navigation ────────────────────────────────────────────────

  /** Launch Chromium. Closes any existing instance first (idempotent). */
  async open_browser(args: { headless?: boolean }): Promise<ToolResult> {
    try {
      if (this.browser) {
        logger.info("Closing existing browser before reopening");
        await this.browser.close();
        this.browser = this.context = this.page = null;
      }
      const headless = args.headless ?? config.headless;
      logger.info("Opening browser", { headless });
      this.browser = await chromium.launch({ headless });
      this.context = await this.browser.newContext({ viewport: null });
      this.page = await this.context.newPage();
      this.wireDialogs(this.page);
      return { success: true, data: "Browser opened." };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Auto-handle native dialogs per the current dialogAction so runs never hang. */
  private wireDialogs(page: Page): void {
    page.on("dialog", async (dialog: Dialog) => {
      logger.info("Dialog appeared", { type: dialog.type(), message: dialog.message() });
      try {
        if (this.dialogAction === "accept") await dialog.accept(this.dialogPromptText || undefined);
        else await dialog.dismiss();
      } catch { /* dialog may already be handled */ }
    });
  }

  /** Navigate to a URL, waiting for the network to settle so SPAs finish rendering. */
  async navigate_to_url(args: { url: string }): Promise<ToolResult> {
    try {
      logger.info("Navigating to URL", args.url);
      const page = this.getPage();
      await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
      const result: ToolResult = { success: true, data: { url: page.url(), title: await page.title() } };
      await this.autoScreenshot("nav");
      return result;
    } catch (e) {
      // networkidle can time out on long-polling sites; the page is often still usable.
      await this.autoScreenshot("nav_partial").catch(() => {});
      return { success: false, error: `navigate failed (page may still be partly loaded): ${String(e)}` };
    }
  }

  async go_back(): Promise<ToolResult> {
    try { await this.getPage().goBack({ waitUntil: "domcontentloaded" }); return { success: true, data: { url: this.getPage().url() } }; }
    catch (e) { return { success: false, error: String(e) }; }
  }

  async go_forward(): Promise<ToolResult> {
    try { await this.getPage().goForward({ waitUntil: "domcontentloaded" }); return { success: true, data: { url: this.getPage().url() } }; }
    catch (e) { return { success: false, error: String(e) }; }
  }

  async reload_page(): Promise<ToolResult> {
    try { await this.getPage().reload({ waitUntil: "networkidle" }); return { success: true, data: "Reloaded." }; }
    catch (e) { return { success: false, error: String(e) }; }
  }

  async close_browser(): Promise<ToolResult> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = this.context = this.page = null;
        logger.info("Browser closed.");
      }
      return { success: true, data: "Browser closed." };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  // ── Perception ────────────────────────────────────────────────────────────

  /**
   * Build the accessibility snapshot: tags interactive elements with refs and
   * returns them as compact text. This is the agent's primary way to "see" the page.
   */
  async get_page_snapshot(): Promise<ToolResult> {
    try {
      const page = this.getPage();
      const snap = (await page.evaluate(SNAPSHOT_JS)) as Snapshot;
      const text =
        `URL: ${snap.url}\nTITLE: ${snap.title}\n` +
        (snap.headings.length ? `HEADINGS:\n${snap.headings.join("\n")}\n` : "") +
        `INTERACTIVE ELEMENTS (act on these by ref, e.g. click {ref:"e3"}):\n${snap.elements.join("\n")}` +
        (snap.count >= MAX_SNAPSHOT_ELEMENTS ? `\n…(truncated at ${MAX_SNAPSHOT_ELEMENTS} elements; scroll for more)` : "");
      return { success: true, data: text };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Return the page's visible text content (for reading articles, results, etc.). */
  async read_page_text(args: { max_chars?: number }): Promise<ToolResult> {
    try {
      const page = this.getPage();
      const txt = await page.evaluate(() => document.body?.innerText ?? "");
      const limit = args.max_chars ?? 4000;
      return { success: true, data: txt.replace(/\n{3,}/g, "\n\n").slice(0, limit) };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Quick page identity without a full snapshot. */
  async get_page_info(): Promise<ToolResult> {
    try {
      const page = this.getPage();
      return { success: true, data: { url: page.url(), title: await page.title() } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Capture a screenshot, stream it live to the UI, and save a PNG. */
  async take_screenshot(args: { filename?: string }): Promise<ToolResult> {
    try {
      this.ensureScreenshotsDir();
      const ts = Date.now();
      const name = `${args.filename ? args.filename + "_" : "screenshot_"}${ts}`;
      const filePath = path.join(this.screenshotsDir, `${name}.png`);
      const buffer = await this.getPage().screenshot({ path: filePath, fullPage: false });
      bus.emitEvent({ type: "screenshot", name: `${name}.png`, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` });
      logger.info("Screenshot saved", filePath);
      return { success: true, data: { path: filePath } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /**
   * VISION: send the current screenshot to the multimodal NIM model and ask a
   * question about it. Use when the DOM snapshot is ambiguous, to locate elements
   * visually, or to verify the visible result of an action.
   */
  async analyze_screen(args: { question?: string }): Promise<ToolResult> {
    try {
      if (!config.visionEnabled) return { success: false, error: "Vision is disabled (VISION_ENABLED=false)." };
      const page = this.getPage();
      const buffer = await page.screenshot({ fullPage: false });
      const b64 = buffer.toString("base64");
      bus.emitEvent({ type: "screenshot", name: `vision_${Date.now()}.png`, dataUrl: `data:image/png;base64,${b64}` });
      const question = args.question?.trim() ||
        "Describe this screen: the main content, and the key interactive elements (buttons, fields, links) with their approximate locations.";
      logger.info("Vision: analyzing screen", question);
      const resp = await this.client.chat.completions.create({
        model: config.visionModel,
        max_tokens: 800,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        }] as any,
      });
      const answer = resp.choices[0]?.message?.content ?? "(no answer)";
      return { success: true, data: answer };
    } catch (e) {
      return { success: false, error: `analyze_screen failed: ${String(e)}` };
    }
  }

  // ── Ref-based actions (preferred) ─────────────────────────────────────────

  async click(args: { ref: string }): Promise<ToolResult> {
    const urlBefore = this.page?.url();
    const result = await this.refAction("click", args.ref, async (loc) => {
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await loc.click({ timeout: 8_000 });
    });
    if (result.success) {
      await this.getPage().waitForTimeout(400);
      if (this.page?.url() !== urlBefore) await this.autoScreenshot("after_click");
    }
    return result;
  }

  async double_click_element(args: { ref: string }): Promise<ToolResult> {
    return this.refAction("double_click_element", args.ref, async (loc) => {
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await loc.dblclick({ timeout: 8_000 });
    });
  }

  async hover(args: { ref: string }): Promise<ToolResult> {
    return this.refAction("hover", args.ref, (loc) => loc.hover({ timeout: 8_000 }));
  }

  async fill(args: { ref: string; text: string }): Promise<ToolResult> {
    return this.refAction("fill", args.ref, async (loc) => {
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await loc.fill(args.text, { timeout: 8_000 });
    }, `filled with "${args.text}"`);
  }

  async clear_field(args: { ref: string }): Promise<ToolResult> {
    return this.refAction("clear_field", args.ref, (loc) => loc.fill("", { timeout: 8_000 }));
  }

  async select_option(args: { ref: string; value: string }): Promise<ToolResult> {
    return this.refAction("select_option", args.ref, (loc) => loc.selectOption(args.value, { timeout: 8_000 }) as any, `selected "${args.value}"`);
  }

  async set_checkbox(args: { ref: string; checked: boolean }): Promise<ToolResult> {
    const checked = args.checked !== false;
    return this.refAction("set_checkbox", args.ref, (loc) => loc.setChecked(checked, { timeout: 8_000 }), `set checked=${checked}`);
  }

  async scroll_to(args: { ref: string }): Promise<ToolResult> {
    return this.refAction("scroll_to", args.ref, (loc) => loc.scrollIntoViewIfNeeded({ timeout: 5_000 }));
  }

  async upload_file(args: { ref: string; file_paths: string[] | string }): Promise<ToolResult> {
    const files = Array.isArray(args.file_paths) ? args.file_paths : [args.file_paths];
    return this.refAction("upload_file", args.ref, (loc) => loc.setInputFiles(files, { timeout: 8_000 }), `uploaded ${files.length} file(s)`);
  }

  async drag_and_drop(args: { source_ref: string; target_ref: string }): Promise<ToolResult> {
    try {
      const source = this.byRef(args.source_ref);
      const target = this.byRef(args.target_ref);
      await source.dragTo(target, { timeout: 8_000 });
      return { success: true, data: `Dragged ${args.source_ref} → ${args.target_ref}` };
    } catch (e) {
      return { success: false, error: this.refError(args.source_ref, e) };
    }
  }

  /** Shared executor for ref-based actions: resolves the ref, runs the op, formats errors. */
  private async refAction(name: string, ref: string, op: (loc: ReturnType<BrowserTools["byRef"]>) => Promise<unknown>, ok?: string): Promise<ToolResult> {
    try {
      logger.info(name, ref);
      const loc = this.byRef(ref);
      await op(loc);
      await this.getPage().waitForTimeout(250);
      return { success: true, data: `${name} ${ref} ${ok ?? "ok"}` };
    } catch (e) {
      return { success: false, error: this.refError(ref, e) };
    }
  }

  private refError(ref: string, e: unknown): string {
    return `Could not act on ref "${ref}": ${String(e)}. The ref may be stale (page changed) - call get_page_snapshot again for fresh refs.`;
  }

  // ── Selector-based helpers (flexible fallback) ────────────────────────────

  /** Locate an element by CSS selector and return its centre pixel coordinates. */
  async find_element(args: { selector: string }): Promise<ToolResult> {
    try {
      const box = await this.getPage().locator(args.selector).first().boundingBox({ timeout: 5_000 });
      if (!box) return { success: false, error: `"${args.selector}" found but has no bounding box (hidden).` };
      return { success: true, data: { selector: args.selector, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), width: box.width, height: box.height } };
    } catch (e) {
      return { success: false, error: `Element "${args.selector}" not found: ${String(e)}` };
    }
  }

  /** Fill a field by CSS selector (when no ref is available). */
  async fill_element(args: { selector: string; text: string }): Promise<ToolResult> {
    try {
      const loc = this.getPage().locator(args.selector).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await loc.fill(args.text, { timeout: 8_000 });
      return { success: true, data: `Filled "${args.selector}" with "${args.text}"` };
    } catch (e) {
      return { success: false, error: `fill_element failed for "${args.selector}": ${String(e)}` };
    }
  }

  // ── Coordinate & keyboard actions ─────────────────────────────────────────

  async click_on_screen(args: { x: number; y: number }): Promise<ToolResult> {
    try {
      await this.getPage().mouse.click(Number(args.x), Number(args.y));
      await this.getPage().waitForTimeout(250);
      return { success: true, data: `Clicked (${args.x}, ${args.y})` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async drag_on_screen(args: { x1: number; y1: number; x2: number; y2: number }): Promise<ToolResult> {
    try {
      const page = this.getPage();
      await page.mouse.move(Number(args.x1), Number(args.y1));
      await page.mouse.down();
      await page.mouse.move(Number(args.x2), Number(args.y2), { steps: 20 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      return { success: true, data: `Dragged (${args.x1},${args.y1}) → (${args.x2},${args.y2})` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async double_click(args: { x: number; y: number }): Promise<ToolResult> {
    try {
      await this.getPage().mouse.dblclick(Number(args.x), Number(args.y));
      await this.getPage().waitForTimeout(250);
      return { success: true, data: `Double-clicked (${args.x}, ${args.y})` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async send_keys(args: { text: string }): Promise<ToolResult> {
    try {
      await this.getPage().keyboard.type(args.text, { delay: 25 });
      return { success: true, data: `Typed: "${args.text}"` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  /** Press a key or chord, e.g. "Enter", "Escape", "Tab", "Control+A", "ArrowDown". */
  async press_key(args: { key: string }): Promise<ToolResult> {
    try {
      await this.getPage().keyboard.press(args.key);
      const isEnter = /^enter$/i.test(args.key.trim());
      await this.getPage().waitForTimeout(isEnter ? 800 : 150);
      if (isEnter) await this.autoScreenshot("after_enter");
      return { success: true, data: `Pressed ${args.key}` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async scroll(args: { delta_x: number; delta_y: number }): Promise<ToolResult> {
    try {
      await this.getPage().mouse.wheel(Number(args.delta_x) || 0, Number(args.delta_y) || 0);
      await this.getPage().waitForTimeout(400);
      return { success: true, data: `Scrolled (${args.delta_x ?? 0}, ${args.delta_y ?? 0})` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  // ── Sync / waiting ────────────────────────────────────────────────────────

  /** Wait for text to appear, a selector to attach, or a fixed delay (ms). */
  async wait_for(args: { text?: string; selector?: string; ms?: number }): Promise<ToolResult> {
    try {
      const page = this.getPage();
      if (args.selector) { await page.waitForSelector(args.selector, { timeout: 15_000 }); return { success: true, data: `Saw selector ${args.selector}` }; }
      if (args.text) { await page.getByText(args.text, { exact: false }).first().waitFor({ timeout: 15_000 }); return { success: true, data: `Saw text "${args.text}"` }; }
      await page.waitForTimeout(Math.min(Number(args.ms) || 1000, 15_000));
      return { success: true, data: `Waited ${args.ms ?? 1000}ms` };
    } catch (e) {
      return { success: false, error: `wait_for timed out: ${String(e)}` };
    }
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  async new_tab(args: { url?: string }): Promise<ToolResult> {
    try {
      if (!this.context) throw new Error("Browser not open.");
      const page = await this.context.newPage();
      this.wireDialogs(page);
      if (args.url) await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
      this.page = page;
      return { success: true, data: { index: this.context.pages().length - 1, url: page.url() } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async list_tabs(): Promise<ToolResult> {
    try {
      if (!this.context) throw new Error("Browser not open.");
      const pages = this.context.pages();
      const tabs = await Promise.all(pages.map(async (p, i) => ({ index: i, url: p.url(), title: await p.title().catch(() => ""), active: p === this.page })));
      return { success: true, data: tabs };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async switch_tab(args: { index: number }): Promise<ToolResult> {
    try {
      if (!this.context) throw new Error("Browser not open.");
      const page = this.context.pages()[Number(args.index)];
      if (!page) return { success: false, error: `No tab at index ${args.index}.` };
      this.page = page;
      await page.bringToFront();
      return { success: true, data: { index: args.index, url: page.url() } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async close_tab(args: { index?: number }): Promise<ToolResult> {
    try {
      if (!this.context) throw new Error("Browser not open.");
      const pages = this.context.pages();
      const page = args.index === undefined ? this.page : pages[Number(args.index)];
      if (!page) return { success: false, error: "Tab not found." };
      await page.close();
      this.page = this.context.pages()[0] ?? null;
      return { success: true, data: "Tab closed." };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  // ── Advanced / escape hatches ─────────────────────────────────────────────

  /** Run arbitrary JS in the page and return its (JSON-serialisable) result. */
  async evaluate_js(args: { script: string }): Promise<ToolResult> {
    try {
      const result = await this.getPage().evaluate(args.script as string);
      let data: unknown;
      try { data = JSON.parse(JSON.stringify(result)); } catch { data = String(result); }
      return { success: true, data };
    } catch (e) {
      return { success: false, error: `evaluate_js failed: ${String(e)}` };
    }
  }

  /** Configure how the next native dialog (alert/confirm/prompt) is handled. */
  async handle_dialog(args: { accept?: boolean; prompt_text?: string }): Promise<ToolResult> {
    this.dialogAction = args.accept === false ? "dismiss" : "accept";
    this.dialogPromptText = args.prompt_text ?? "";
    return { success: true, data: `Dialogs will be ${this.dialogAction}ed.` };
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /** Route an LLM tool call to the matching method. Explicit switch keeps it type-checked. */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case "open_browser":          return this.open_browser(args as any);
      case "navigate_to_url":       return this.navigate_to_url(args as any);
      case "go_back":               return this.go_back();
      case "go_forward":            return this.go_forward();
      case "reload_page":           return this.reload_page();
      case "close_browser":         return this.close_browser();
      case "get_page_snapshot":     return this.get_page_snapshot();
      case "read_page_text":        return this.read_page_text(args as any);
      case "get_page_info":         return this.get_page_info();
      case "take_screenshot":       return this.take_screenshot(args as any);
      case "analyze_screen":        return this.analyze_screen(args as any);
      case "click":                 return this.click(args as any);
      case "double_click_element":  return this.double_click_element(args as any);
      case "hover":                 return this.hover(args as any);
      case "fill":                  return this.fill(args as any);
      case "clear_field":           return this.clear_field(args as any);
      case "select_option":         return this.select_option(args as any);
      case "set_checkbox":          return this.set_checkbox(args as any);
      case "scroll_to":             return this.scroll_to(args as any);
      case "upload_file":           return this.upload_file(args as any);
      case "drag_and_drop":         return this.drag_and_drop(args as any);
      case "find_element":          return this.find_element(args as any);
      case "fill_element":          return this.fill_element(args as any);
      case "click_on_screen":       return this.click_on_screen(args as any);
      case "drag_on_screen":        return this.drag_on_screen(args as any);
      case "double_click":          return this.double_click(args as any);
      case "send_keys":             return this.send_keys(args as any);
      case "press_key":             return this.press_key(args as any);
      case "scroll":                return this.scroll(args as any);
      case "wait_for":              return this.wait_for(args as any);
      case "new_tab":               return this.new_tab(args as any);
      case "list_tabs":             return this.list_tabs();
      case "switch_tab":            return this.switch_tab(args as any);
      case "close_tab":             return this.close_tab(args as any);
      case "evaluate_js":           return this.evaluate_js(args as any);
      case "handle_dialog":         return this.handle_dialog(args as any);
      default:                      return { success: false, error: `Unknown tool: ${toolName}` };
    }
  }
}
