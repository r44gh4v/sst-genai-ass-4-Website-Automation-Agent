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
  model: process.env.MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1",
  headless: process.env.HEADLESS !== "false",
  maxIterations: Number(process.env.MAX_ITERATIONS ?? 20),
};
