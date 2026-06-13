import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { config } from "./config";
import { logger } from "./logger";
import { BrowserTools } from "./tools/browser";
import { AgentLoop } from "./agent";

const SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");

function clearScreenshots(): void {
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    fs.readdirSync(SCREENSHOTS_DIR)
      .filter((f) => f.endsWith(".png"))
      .forEach((f) => fs.unlinkSync(path.join(SCREENSHOTS_DIR, f)));
    logger.info("Cleared screenshots directory");
  }
}

const TASK = `Fill in the Bug Report form on the current page. The form has two fields: "Bug Title" (input[name="title"]) and "Description" (textarea[name="description"]). Fill the title with "John Doe" and the description with "This is an automated test by the website automation agent." Take a screenshot after each field is filled.`;

async function main(): Promise<void> {
  logger.info("=== Website Automation Agent ===");
  logger.info("Model", config.model);
  logger.info("NIM Base URL", config.nimBaseUrl);
  clearScreenshots();

  const client = new OpenAI({
    apiKey: config.nimApiKey,
    baseURL: config.nimBaseUrl,
  });

  const browserTools = new BrowserTools();

  const openResult = await browserTools.open_browser({ headless: config.headless });
  if (!openResult.success) {
    logger.error("Failed to open browser", openResult.error);
    process.exit(1);
  }

  const navResult = await browserTools.navigate_to_url({ url: "https://ui.shadcn.com/docs/forms/react-hook-form" });
  if (!navResult.success) {
    logger.error("Failed to navigate", navResult.error);
    process.exit(1);
  }
  logger.info("Page loaded - handing off to agent");

  const agent = new AgentLoop(client, browserTools);

  try {
    await agent.run(TASK);
    logger.info("Task completed successfully.");
  } catch (err) {
    logger.error("Agent error", String(err));
  } finally {
    await browserTools.close_browser();
    logger.info("Browser closed. Done.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
