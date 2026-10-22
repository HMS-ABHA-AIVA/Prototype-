import "dotenv/config";
import { loadHospitalEnv } from "../src/hospital/config.js";
import { aiEnabled, aiStatus, askModel, extractJson } from "../src/hospital/modules/ai/ai-client.js";

// npm run ai:check — sends one tiny made-up request to the configured AI service, so a key, model name and provider can be
// checked in seconds. It sends no patient data and never prints the key. (See docs/hospital/AI-PROVIDERS.md.)
const env = loadHospitalEnv();
const status = aiStatus(env);
console.log(`Provider: ${env.aiProvider}   Model: ${env.aiModel}   Address: ${env.aiBaseUrl}`);

if (!aiEnabled(env)) {
  console.log(`NOT SWITCHED ON: set ${env.aiProvider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} in backend/.env (or the server's environment).`);
  process.exitCode = 1;
} else {
  if (status.demoOnly) {
    console.log("Note: this is Gemini without AI_PAID_TIER. On Google's free tier, staff may read what is sent: use invented patients only.");
  }
  try {
    const started = Date.now();
    const answer = await askModel(env, { system: "Reply with a JSON object only.", user: 'Return {"ok": true, "word": "ready"}.', maxTokens: 50 });
    const json = extractJson(answer) as { ok?: boolean } | null;
    console.log(`Answered in ${Date.now() - started} ms. ${json?.ok ? "The key and model work." : `The service answered, but not as asked: ${answer.slice(0, 120)}`}`);
  } catch (error) {
    console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    console.log("Common causes: a wrong key, a model name this key cannot use (HTTP 404: set AI_MODEL), or a used-up free-tier limit (HTTP 429).");
    // Let the process end by itself: process.exit() while a connection is closing makes Node on Windows print an assertion.
    process.exitCode = 1;
  }
}
