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

const SYSTEM_PROMPT = `You are an autonomous website automation agent. You control a real Chromium web browser using the provided tools.

The user gives you a natural-language request that names a WEBSITE and an ACTION to perform on it (for example: "go to wikipedia.org and search for quantum computing", or "open github.com/login and type my username in the username field").

Your workflow:
1. The browser is already open. Call navigate_to_url to go to the website named in the request. Infer the full URL - add "https://" if the scheme is missing, and ".com" only if it is clearly implied.
2. Call get_page_snapshot to inspect the page structure and discover element selectors, labels, and buttons.
3. Perform the requested action using the most appropriate tools:
   - fill_element(selector, text) for text inputs and textareas (handles scrolling, focus, and React controlled inputs).
   - find_element(selector) to get an element's (x, y), then click_on_screen(x, y) for buttons, links, or non-standard widgets.
   - send_keys for typing into an already-focused element, scroll to reveal hidden content, double_click when a single click is not enough.
4. Call take_screenshot after each meaningful step so the user can see progress.
5. When the requested action is finished, reply with a SHORT plain-text summary of what you did, ending with the token TASK_COMPLETE.

Rules:
- Prefer fill_element over click_on_screen + send_keys for any input or textarea.
- Always get_page_snapshot before guessing selectors on an unfamiliar page.
- If a tool fails, adapt: scroll, take a fresh snapshot, or try an alternative selector or coordinates. Do not give up after one failure.
- Only use tools from the provided list. Never invent tool names.
- Be efficient - avoid redundant or repeated tool calls once a step has succeeded.
- If the request is impossible (e.g. the named site or element does not exist), explain why and end with TASK_COMPLETE.`;

/**
 * Implements a ReAct-style agentic loop: the LLM reasons and emits tool calls,
 * the loop executes them and feeds results back as messages, repeating until the
 * model signals completion (finish_reason "stop") or a safety iteration cap is hit.
 *
 * The loop is website- and task-agnostic: the concrete site and action come
 * entirely from the user's natural-language task string, not from hardcoded logic.
 */
export class AgentLoop {
  private client: OpenAI;
  private browserTools: BrowserTools;

  constructor(client: OpenAI, browserTools: BrowserTools) {
    this.client = client;
    this.browserTools = browserTools;
  }

  async run(task: string): Promise<string> {
    logger.info("Agent starting task", task);

    // Mutable conversation history passed in full on every API call - the model has no memory between calls,
    // so the entire prior context (system prompt, user task, assistant turns, tool results) must be re-sent.
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task },
    ];

    for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
      logger.info(`--- Iteration ${iteration}/${config.maxIterations} ---`);
      bus.emitEvent({ type: "iteration", current: iteration, max: config.maxIterations });

      const response = await this.client.chat.completions.create({
        model: config.model,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        messages,
      });

      const choice = response.choices[0];
      const assistantMsg = choice.message;

      // Append assistant message to history
      messages.push(assistantMsg as ChatCompletionMessageParam);

      // Strip the TASK_COMPLETE sentinel so it never leaks into the UI summary/feed.
      const cleanContent = (assistantMsg.content ?? "").replace(/\bTASK_COMPLETE\b/g, "").trim();

      // Surface any reasoning/text the model produced this turn to the UI.
      if (cleanContent) {
        bus.emitEvent({ type: "assistant", content: cleanContent });
      }

      // Completion is driven SOLELY by the absence of tool calls. We deliberately do
      // not key off finish_reason: NIM/Llama models served over the OpenAI-compatible
      // endpoint frequently report finish_reason "stop" even when tool_calls are
      // present, which would silently drop the pending calls and end the task early.
      if (!assistantMsg.tool_calls?.length) {
        logger.info("Agent finished.", cleanContent);
        console.log("\n=== AGENT RESPONSE ===");
        console.log(cleanContent);
        console.log("======================\n");
        return cleanContent;
      }

      // Execute all tool calls the model requested in this single response before making the next API call.
      // The OpenAI API requires every tool_call_id in the assistant message to have a matching tool result
      // message before a new assistant turn can begin, so we must drain the entire batch first.
      const toolResultMessages: ChatCompletionToolMessageParam[] = [];

      for (const toolCall of assistantMsg.tool_calls) {
        const name = toolCall.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          // Empty args for tools with no parameters
        }

        bus.emitEvent({ type: "tool-call", name, args });
        logger.tool(name, args, "executing...");
        const result = await this.browserTools.execute(name, args);
        logger.tool(name, args, result);
        bus.emitEvent({ type: "tool-result", name, success: result.success, result: result.success ? result.data : result.error });

        toolResultMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      messages.push(...toolResultMessages);
    }

    // Safety guard: if the model keeps calling tools without ever stopping, this prevents an infinite loop
    // that would burn API quota and hang the process indefinitely.
    throw new Error(`Agent exceeded max iterations (${config.maxIterations}). Task incomplete.`);
  }
}
