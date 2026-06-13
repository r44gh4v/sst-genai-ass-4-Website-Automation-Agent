import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { TOOL_DEFINITIONS } from "./tools/definitions";
import { BrowserTools } from "./tools/browser";
import { logger } from "./logger";
import { config } from "./config";

const SYSTEM_PROMPT = `You are a browser automation agent. You control a real web browser using the provided tools.

Guidelines:
- navigate_to_url and open_browser are already done before you start - go straight to the task.
- Use get_page_snapshot to understand the page structure and find element selectors.
- Use fill_element(selector, text) to fill form inputs and textareas - it handles scrolling, clicking, and typing in one step.
- After filling each field, call take_screenshot to verify the text was entered.
- The demo form on the shadcn page has two fields: input[name="title"] (labeled "Bug Title") and textarea[name="description"] (labeled "Description").
- When BOTH fields are filled with the correct text, respond with TASK_COMPLETE.
- If fill_element fails, try scroll(0, 600) then retry, or try an alternative selector.
- Do NOT invent tool names that are not in the tools list.`;

/**
 * Implements a ReAct-style agentic loop: the LLM reasons and emits tool calls,
 * the loop executes them and feeds results back as messages, repeating until the
 * model signals completion (finish_reason "stop") or a safety iteration cap is hit.
 */
export class AgentLoop {
  private client: OpenAI;
  private browserTools: BrowserTools;

  constructor(client: OpenAI, browserTools: BrowserTools) {
    this.client = client;
    this.browserTools = browserTools;
  }

  async run(task: string): Promise<void> {
    logger.info("Agent starting task", task);

    // Mutable conversation history passed in full on every API call - the model has no memory between calls,
    // so the entire prior context (system prompt, user task, assistant turns, tool results) must be re-sent.
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task },
    ];

    for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
      logger.info(`--- Iteration ${iteration}/${config.maxIterations} ---`);

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

      // "stop" means the LLM decided it has nothing more to do - task is complete or it gave a final answer.
      if (choice.finish_reason === "stop" || !assistantMsg.tool_calls?.length) {
        const content = assistantMsg.content ?? "";
        logger.info("Agent finished.", content);
        console.log("\n=== AGENT RESPONSE ===");
        console.log(content);
        console.log("======================\n");
        return;
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

        logger.tool(name, args, "executing...");
        const result = await this.browserTools.execute(name, args);
        logger.tool(name, args, result);

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
