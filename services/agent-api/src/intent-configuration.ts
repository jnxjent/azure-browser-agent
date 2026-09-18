import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Read only the LLM settings from an explicitly configured local env file. */
export function loadSharedIntentConfiguration(): void {
  const path = process.env.DESKNETS_AZURECHAT_ENV_FILE?.trim();
  if (!path) return;
  const childEnvironment = { ...process.env };
  for (const key of ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_DEPLOYMENT_NAME"]) delete childEnvironment[key];
  const source = JSON.parse(execFileSync(process.execPath, [
    `--env-file=${resolve(path)}`, "-e",
    "const e=process.env;process.stdout.write(JSON.stringify({AZURE_OPENAI_ENDPOINT:e.AZURE_OPENAI_ENDPOINT,AZURE_OPENAI_API_KEY:e.AZURE_OPENAI_API_KEY,AZURE_OPENAI_DEPLOYMENT:e.AZURE_OPENAI_DEPLOYMENT||e.AZURE_OPENAI_API_DEPLOYMENT_NAME}));",
  ], { env: childEnvironment, encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })) as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(source)) {
    if (!process.env[key]?.trim() && value) process.env[key] = value;
  }
}
