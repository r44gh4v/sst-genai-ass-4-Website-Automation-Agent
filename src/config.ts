import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  nimApiKey: required("NIM_API_KEY"),
  nimBaseUrl: process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",

  // Primary "brain": drives the ReAct tool-use loop. Must be strong at OpenAI-style
  // function/tool calling and multi-step agentic reasoning. meta/llama-3.3-70b-instruct
  // is a reliable default on NIM; override via MODEL.
  model: process.env.MODEL ?? "meta/llama-3.3-70b-instruct",

  // Vision "eyes": a multimodal NIM model the agent consults via the analyze_screen
  // tool when the DOM snapshot is ambiguous or it needs to verify what is on screen.
  // Hybrid design: the text model plans + tool-calls, the vision model interprets pixels.
  visionModel: process.env.VISION_MODEL ?? "meta/llama-3.2-90b-vision-instruct",

  // Vision is opt-out: if no vision model is wanted, set VISION_ENABLED=false and the
  // analyze_screen tool is hidden from the agent so it relies on DOM + screenshots only.
  visionEnabled: process.env.VISION_ENABLED !== "false",

  // Sampling: low temperature keeps tool-calling deterministic and on-task.
  temperature: Number(process.env.TEMPERATURE ?? 0.2),

  // Visible browser by default so the user can watch the agent work in real time.
  headless: process.env.HEADLESS === "true",
  maxIterations: Number(process.env.MAX_ITERATIONS ?? 30),
  port: Number(process.env.PORT ?? 3000),
};
