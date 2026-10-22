<!-- From AIVA OSHealth, adapted to the merged application. -->
# Which AI service runs the assistant

The doctor's assistant (dictation sorting, suggested prescriptions) and the discharge-summary draft all go through one place,
`backend/src/hospital/modules/ai/ai-client.ts`. It can use either of two services.

| | Claude (Anthropic) | Gemini (Google) |
|---|---|---|
| Switch | `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` (and `AI_PROVIDER=gemini` if both keys are set) |
| Default model | `claude-sonnet-5-5` | `gemini-3.5-flash` |
| Cost | Pay as you go. Anthropic's pricing page lists Haiku 4.5 at $1 / $5 and Sonnet 5.5 at $2 / $10 per million input / output tokens; a suggestion is roughly under a rupee. New users get "a small amount of free credits" (amount not stated: see your Billing page) | **A free tier exists** for several Flash models. Limits are shown in Google AI Studio (aistudio.google.com/rate-limit) |
| Real patients | Yes | **Only on a paid (billing-enabled) Google project.** See below |

## Gemini's free tier is for demos with invented patients only

Google's Gemini API terms say that for **unpaid services** Google uses what is sent "to provide, improve, and develop Google products
and services", that "human reviewers may read, annotate, and process your API input and output", and "Do not submit sensitive,
confidential, or personal information to the Unpaid Services". For **paid services** they say Google does not use prompts or
responses to improve its products. The pricing page shows the same split.

The app already removes the patient's name, phone, MRN and ABHA number before anything is sent, but age, sex, allergies, problems and
the clinical note still go, and that is health information. So:

- While the server runs on Gemini **without** `AI_PAID_TIER=true`, the assistant card shows an amber **"Demo AI, invented patients only"** warning
  (`GET /api/v1/ai/status` reports `demoOnly: true`).
- Use it to try the feature, show it to people, and test, with made-up patients.
- For real patients, use Claude, or put the Gemini key on a Google Cloud project with billing enabled and then set `AI_PAID_TIER=true`
  (which removes the warning; set it only if that is true). Check the result against your hospital's data-protection policy.

## Trying Gemini for free

1. Open [Google AI Studio](https://aistudio.google.com/apikey), accept the terms and choose **Create API key**. (Google's key page does not
   say a card is needed for the free tier. India is on Google's list of available regions.)
2. Put it in the backend's `.env` (local) or in the server's environment (hosted: Cloud Run or Render secrets). Type it yourself; never paste it into chat or commit it:
   ```
   GEMINI_API_KEY=your-key
   ```
3. Check it works, with no patient data involved:
   ```
   npm run ai:check
   ```
   It prints the provider and model, sends one tiny made-up request and says whether it worked or why not (wrong key, a model your key
   cannot use, or HTTP 429 because the free limit is used up).
4. Restart the API. The consultation screen's assistant now works and shows the demo warning.

**Model names go out of date.** Google retires older models for new keys: a new key got HTTP 404 "no longer available to new users" on
`gemini-2.5-flash`, which was this app's first default. Tried with a real key (October 2026), same small request:

| Model | Time | Verdict |
|---|---|---|
| `gemini-3.5-flash` (default) | about 1.5 to 1.9 seconds | good for a consultation screen |
| `gemini-3.5-flash-lite` | about 1 second | fastest, smaller model |
| `gemini-3.8-flash` | about 11 to 13 seconds | Google's newest and recommended, but too slow here |

If a model name is refused (404), set `AI_MODEL` to another model from Google's pricing page; `npm run ai:check` tests it in seconds.

## Notes on how Gemini is called

- It uses Google's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, key sent as a
  bearer token). Google describes that endpoint as beta.
- Gemini's reasoning ("thinking") counts against the output limit, so the app asks for extra room and sends `reasoning_effort: low`.
  Change or remove it with `AI_REASONING_EFFORT` (`none`, `minimal`, `low`, `medium`, `high`; empty sends nothing). Google says some
  models cannot turn thinking off entirely.
- If Gemini fails, returns nothing or hits its free daily limit, dictation falls back to sorting by the section words the doctor says, and the
  prescription button says the AI could not be reached. Nothing is ever saved automatically.
- The same checks run whichever service answers: allergies (also through a brand's generic make-up), duplicates, drug-name recognition and
  pharmacy stock are done by the server, not the model.
- Checked once against Google's live service with a real free-tier key (the request format works; see the table above). The automated
  tests use a stand-in that speaks the same format. `npm run ai:check` is how you confirm your own key and model.
