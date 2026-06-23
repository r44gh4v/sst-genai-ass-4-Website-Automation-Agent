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
  // meta/llama-3.3-70b-instruct: large instruct model on NIM with reliable
  // OpenAI-style function/tool calling - the key requirement for this agent loop.
  model: process.env.MODEL ?? "meta/llama-3.3-70b-instruct",
  // Visible browser by default so the user can watch the agent work in real time.
  headless: process.env.HEADLESS === "true",
  maxIterations: Number(process.env.MAX_ITERATIONS ?? 25),
  port: Number(process.env.PORT ?? 3000),
};
