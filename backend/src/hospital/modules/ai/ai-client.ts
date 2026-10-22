import type { HospitalEnv } from "../../config.js";

/**
 * The one place that talks to the AI model (Anthropic's Claude, or Google's Gemini). Everything AI-related goes through
 * askModel, so there is a single switch, a single timeout and a single error shape.
 *
 * The model only ever DRAFTS text for a clinician to review. Callers must send clinical facts only, never identifiers.
 */
type AiEnv = Pick<HospitalEnv, "aiProvider" | "anthropicApiKey" | "geminiApiKey">;

export const aiEnabled = (env: AiEnv) => !!(env.aiProvider === "gemini" ? env.geminiApiKey : env.anthropicApiKey);

/**
 * What the screens need to know: is AI on, which service, and whether the data may be read by the provider (Gemini's free tier:
 * Google's terms say human reviewers may read it and that personal information must not be submitted). Never includes the key.
 */
export function aiStatus(env: AiEnv & Pick<HospitalEnv, "aiPaidTier">) {
  return {
    enabled: aiEnabled(env),
    provider: env.aiProvider,
    /** True when prompts could be read by the provider's staff: use invented patients only. */
    demoOnly: env.aiProvider === "gemini" && !env.aiPaidTier,
  };
}

export interface ModelRequest {
  system: string;
  user: string;
  maxTokens: number;
}

// Gemini's reasoning models count their "thinking" against the output limit, so a small limit can leave an empty answer.
const GEMINI_THINKING_HEADROOM = 6000;

export async function askModel(
  env: AiEnv & Pick<HospitalEnv, "aiModel" | "aiBaseUrl" | "aiReasoningEffort">,
  request: ModelRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = env.aiBaseUrl.replace(/\/+$/, "");

  if (env.aiProvider === "gemini") {
    // Google's OpenAI-compatible endpoint.
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.geminiApiKey!}` },
      body: JSON.stringify({
        model: env.aiModel,
        max_tokens: request.maxTokens + GEMINI_THINKING_HEADROOM,
        ...(env.aiReasoningEffort ? { reasoning_effort: env.aiReasoningEffort } : {}),
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`AI service answered ${response.status}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
    const choice = body.choices?.[0];
    const text = choice?.message?.content?.trim();
    if (!text) throw new Error(`AI service returned no text${choice?.finish_reason ? ` (${choice.finish_reason})` : ""}`);
    return text;
  }

  const response = await fetchImpl(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.anthropicApiKey!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.aiModel,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`AI service answered ${response.status}`);
  const body = (await response.json()) as { content?: { type: string; text?: string }[] };
  const text = body.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
  if (!text) throw new Error("AI service returned no text");
  return text;
}

/** Pulls the JSON object out of a model answer, tolerating a code fence or a sentence around it. Returns null if there is none. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
