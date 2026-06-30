import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { TOOL_DEFINITIONS } from "./tools/definitions";
import { BrowserTools } from "./tools/browser";
import { logger } from "./logger";
import { config } from "./config";
import { bus } from "./events";

const SYSTEM_PROMPT = `You are an autonomous, general-purpose website automation agent driving a REAL Chromium browser through tools. You can automate essentially anything a human can do in a browser: navigate, read and understand pages, fill and submit forms, click/hover/drag, use dropdowns and checkboxes, switch tabs, scroll, upload files, run JS, and visually inspect the screen.

You are SMART and CONTEXT-AWARE. Do not follow a rigid script - look at what is actually on the screen and adapt.

## How you perceive the page
- get_page_snapshot is your main sense: it lists every visible interactive element with a stable ref id (e1, e2, …) plus headings and the URL. ALWAYS snapshot after navigating or whenever the page changes, then act on elements BY REF.
- read_page_text reads visible text (articles, results, confirmations).
- analyze_screen (vision) lets you actually LOOK at a screenshot and ask a question - use it when the snapshot is ambiguous, when an element isn't in the DOM list, to locate something visually, or to verify what happened.

## How you act
- Prefer REF-based tools (click, fill, select_option, set_checkbox, hover, …) using refs from the latest snapshot - they are robust.
- fill is best for inputs/textareas (handles React controlled inputs). Use press_key for Enter/Tab/shortcuts, send_keys to type into a focused field.
- Coordinate tools (click_on_screen, find_element) are fallbacks for canvas/visual targets.
- evaluate_js is an escape hatch for anything the other tools can't express.

## Your loop: OBSERVE → PLAN → ACT → VERIFY
1. PLAN: briefly state the steps you intend to take for the user's request.
2. OBSERVE: snapshot (or analyze_screen) to understand the CURRENT state before acting.
3. ACT: take one logical step using the right tool with refs from the freshest snapshot.
4. VERIFY: after important actions, re-snapshot, read text, or analyze_screen to confirm it worked, then continue.
5. Take a screenshot after meaningful milestones so the user can watch.

## Robustness
- Tools return {success, error}. On failure, ADAPT - don't repeat the same failing call. Re-snapshot for fresh refs (refs go stale when the page re-renders), try a different element, scroll, wait_for, or fall back to analyze_screen / coordinates.
- Be efficient: don't re-snapshot when nothing changed, and don't repeat a step that already succeeded.
- Only call tools from the provided list. Never invent tool names or refs - use refs that appear in the latest snapshot.

## Handling blocked searches / CAPTCHAs
- If a search engine (Google, Bing, etc.) returns a CAPTCHA, "unusual traffic", or /sorry page, do NOT try to solve the CAPTCHA. Instead, immediately navigate_to_url directly to the target site (e.g. if searching for "excalidraw", go straight to https://excalidraw.com).
- If a site blocks automated access, try navigating to a known alternative URL or a different search engine.

## Canvas and visual-only applications (Excalidraw, Figma, drawing tools, maps, etc.)
- The DOM snapshot may not list toolbar buttons if they are icon-only or use non-standard roles. Use analyze_screen to visually identify the toolbar and tool locations.
- To select a drawing tool: call analyze_screen asking "where is the [rectangle/line/etc.] tool button, give pixel coordinates", then click_on_screen at those coordinates.
- To draw a shape on a canvas: use drag_on_screen with start and end pixel coordinates. First use analyze_screen to identify a clear area of the canvas to draw on.
- Do NOT use evaluate_js with querySelector to interact with canvas UI - toolbar buttons in canvas apps rarely have predictable DOM selectors. Use visual coordinates instead.

## Screenshots
Take a screenshot (take_screenshot) after every major milestone: after the page loads, after filling and submitting a form, after search results appear, after clicking an important link, and at the end of the task. The user watches progress via these screenshots so be generous — err on the side of taking more. Navigation auto-screenshots are handled for you; still call take_screenshot after significant interactions.

## Finishing
When the request is fully done (or genuinely impossible), reply with a SHORT plain-text summary of what you did and what you observed, ending with the token TASK_COMPLETE.`;

/**
 * ReAct-style agentic loop. The LLM plans and emits tool calls; the loop executes
 * them against the browser and feeds results back, repeating until the model stops
 * calling tools (signalling completion) or a safety iteration cap is hit.
 *
 * Website- and task-agnostic: the concrete site and action come entirely from the
 * user's natural-language request. Perception (DOM snapshot + optional vision) and
 * ref-based actions make the loop adapt to whatever page it lands on.
 */
export class AgentLoop {
  private client: OpenAI;
  private browserTools: BrowserTools;

  constructor(client: OpenAI, browserTools: BrowserTools) {
    this.client = client;
    this.browserTools = browserTools;
  }

  async run(task: string, signal?: AbortSignal): Promise<string> {
    logger.info("Agent starting task", task);

    // Full history is re-sent every call - the model has no memory between API calls.
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task },
    ];

    let lastText = "";

    for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
      if (signal?.aborted) {
        logger.info("Agent run aborted by user.");
        return lastText ? `${lastText}\n\n(Run stopped by user.)` : "Run stopped by user.";
      }

      logger.info(`--- Iteration ${iteration}/${config.maxIterations} ---`);
      bus.emitEvent({ type: "iteration", current: iteration, max: config.maxIterations });

      let response;
      try {
        response = await this.client.chat.completions.create(
          {
            model: config.model,
            temperature: config.temperature,
            tools: TOOL_DEFINITIONS,
            tool_choice: "auto",
            messages,
          },
          { signal },
        );
      } catch (e) {
        if (signal?.aborted) return lastText ? `${lastText}\n\n(Run stopped by user.)` : "Run stopped by user.";
        throw e;
      }

      const assistantMsg = response.choices[0].message;
      messages.push(assistantMsg as ChatCompletionMessageParam);

      // Strip the TASK_COMPLETE sentinel so it never leaks into the UI.
      const cleanContent = (assistantMsg.content ?? "").replace(/\bTASK_COMPLETE\b/g, "").trim();
      if (cleanContent) {
        lastText = cleanContent;
        bus.emitEvent({ type: "assistant", content: cleanContent });
      }

      // Completion is keyed SOLELY on the absence of tool calls. We deliberately ignore
      // finish_reason: NIM/Llama over the OpenAI-compatible endpoint often reports "stop"
      // even when tool_calls are present, which would drop pending calls and end early.
      if (!assistantMsg.tool_calls?.length) {
        logger.info("Agent finished.", cleanContent);
        return cleanContent || lastText;
      }

      // Drain every tool call in this response before the next API turn - the protocol
      // requires a matching tool result message for each tool_call_id.
      const toolResults: ChatCompletionToolMessageParam[] = [];
      for (const toolCall of assistantMsg.tool_calls) {
        if (signal?.aborted) return lastText ? `${lastText}\n\n(Run stopped by user.)` : "Run stopped by user.";
        const name = toolCall.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* tools with no params send empty/invalid JSON */
        }

        bus.emitEvent({ type: "tool-call", name, args });
        logger.tool(name, args, "executing...");
        const result = await this.browserTools.execute(name, args);
        logger.tool(name, args, result);
        bus.emitEvent({ type: "tool-result", name, success: result.success, result: result.success ? result.data : result.error });

        toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
      messages.push(...toolResults);
    }

    // Safety guard against an endless tool-calling loop burning API quota.
    throw new Error(`Agent exceeded max iterations (${config.maxIterations}). Task incomplete. Last note: ${lastText || "(none)"}`);
  }
}
