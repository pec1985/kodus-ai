# libs/llm

Shared LLM **provider** infrastructure — generic, domain-agnostic. Anything that
turns configuration into a usable model, or governs how model calls are made,
lives here (NOT review/agent logic). This is the in-repo BYOK layer (it replaced
the old `@kodus/kodus-common/llm` package — that package is gone).

## The BYOK model: config → slot → call

There is **one** BYOK format and **one** door for making a call. Understand these
three stages and you understand the layer:

1. **Stored config — `BYOKConfig`** (`byok-config.ts`). The org's whole BYOK
   setup, persisted as a single jsonb blob in Postgres (`organization_parameters`,
   `configKey = 'byok_config'`): many `credentials[]`, many `models[]`, and a
   `routing` policy. It is the _input_ to routing and describes everything the org
   can use — not a single chosen model. `version: 2` is the only format; older
   `{ main, fallback }` blobs are up-converted by `migrateLegacyToV2` (the DB
   migration runs it once; readers tolerate either on the way in).

2. **Resolved slot — `NormalizedModel`** (`byok-config.ts`). **One** model,
   flattened together with its credential, ready to build a client. It is the
   _output_ of routing. Getting one from a config:
    - `resolveTaskSlot(config, task)` — route a task (e.g. `LLM_TASK.codeReview`)
      to its slot, plus a `verdict` explaining the choice. The app-facing wrapper
      is `PermissionValidationService.resolveTaskSlot(orgTeam, task)`, which loads
      the org's config and returns `NormalizedModel | undefined`.
    - `resolveModelSlot(config, modelId)` / `resolveDefaultSlot(config)` — pick a
      slot by explicit id or the config's default, no task routing.
      A slot carries the **encrypted** `apiKey` ciphertext verbatim — these
      resolvers NEVER decrypt (that happens at build time, below).

3. **Run it — `LLM.run(req)`** (`llm.ts`). The single entry point for every LLM
   call. Give it either a pre-resolved `byokConfig` slot **or** `{ config, task }`
   to route internally. The return shape follows the request:
    - `schema` present → the parsed, typed object (structured output)
    - `loop` present → the multi-step agent-loop result (steps / usage / text)
    - neither → the raw generated string
      `LLM.run` owns the whole call: it builds the model from the slot
      (`buildModelFromSlot`, which decrypts there), emits the usage/telemetry span,
      and applies the hard timeout and the process-wide BYOK concurrency limiter.

**Absence is always `undefined`, never `null`.** No slot ⇒ `undefined` ⇒ the
managed/env default is resolved downstream (`resolveManagedSlot`). A function
that means "no BYOK configured" returns `undefined`; don't reintroduce `null`.

## Core BYOK flow

- **`byok-config.ts`** — the canonical types: `BYOKCredential`, `BYOKModelConfig`,
  `BYOKRouting`, `BYOKConfig` (the stored blob), `NormalizedModel` (the resolved
  slot), the `LLM_TASK` task registry, and the `isByokConfig` shape guard.
- **`migrate-byok-config.ts`** — `migrateLegacyToV2(blob)`: pure legacy
  `{ main, fallback }` → v2 `BYOKConfig` transform. Carries ciphertext verbatim;
  never decrypts.
- **`resolve-model-slot.ts`** — `resolveModelSlot(config, modelId)` and
  `resolveDefaultSlot(config)`: project a stored config down to one
  `NormalizedModel` (by id / by default). Ciphertext preserved.
- **`resolve-task-model.ts`** — `resolveTaskSlot(config, task, …)`: route a task
  to its slot + a `RoutingVerdict`.
- **`resolve-task-invocation.ts`** — `resolveTaskInvocation(…)`: assembles a full
  `TaskInvocation` (slot + reasoning/provider options) for a task in one call.
- **`routing-strategy.ts`** — the `RoutingStrategy` / `RoutingVerdict` /
  `RequestContext` contracts the resolvers route through.
- **`managed-slot.ts`** — the fallback path when the org has no BYOK:
  `resolveManagedSlot` / `resolveEnvProvider` (Kodus-managed / self-hosted `.env`
  keys) and `getModelName(slot)` (the telemetry model NAME, `provider:model`).

## Model building & calls

- **`llm.ts`** — `LLM.run`, the one door (above), and the `LlmRequest` shape.
- **`byok-to-vercel.ts`** — `buildModelFromSlot`: turn a slot into a Vercel AI SDK
  `LanguageModel` (decrypts here); also re-exports `getModelName` and the
  process-wide BYOK concurrency limiter (`runWithBYOKLimiter`, defined in
  `byok-limiter.ts`).
- **`byok-model-wrapper.ts`** — wraps any `LanguageModel` so every generate goes
  through the BYOK concurrency limiter and reports BYOK failures (via AI SDK
  `wrapLanguageModel`; the failure reporter is injected).
- **`structured-review-call.ts`** — `runStructuredReviewCall` / `runTextReviewCall`,
  the executors `LLM.run` delegates to (span + telemetry + `BaseReviewCallParams`).
- **`providers/kernel/structured-output.ts`** — `resolveStructuredOutputPolicy`:
  what a structured call for a given config actually puts on the wire
  (`json_schema` / `json_object` / `none`). Every provider module declares it
  (`structuredOutputPolicy(cfg)`, required, sibling to `temperaturePolicy`) and
  its `build()` derives `supportsStructuredOutputs` from the same call, so the
  declaration and the request body cannot drift. On a `json_object` route the
  wire carries NO schema, so the executor writes the schema — and the word
  "json", which those providers require — into the prompt itself (#1916).
- **`reasoning-options.ts`** — builds provider-specific reasoning/thinking
  `providerOptions` (Anthropic / Gemini / OpenAI / OpenRouter / compatible) from a
  normalized `ReasoningEffort`, plus OpenRouter provider-pinning.

## Supporting

- **`env-llm-config.ts`** — pure, side-effect-free inspection of the self-hosted
  `.env`-driven LLM configuration.
- **`model-context-window.ts`** (+ `model-context-windows.json`) — resolves a
  model name to its context-window size (LiteLLM data + manual overrides).
- **`error-classifier.ts`** (+ `errors.ts`) — maps raw provider errors into the
  canonical `LlmErrorCategory` (auth / quota / rate-limit / context-overflow / …)
  so callers react to error _meaning_, not provider-specific strings.
- **`llm-call.ts`** — call timeouts (`AGENT_TIMEOUT_MS`, `LLM_CALL_TIMEOUT_MS`,
  `timeoutSignal`, `hardTimeout`) and `tracedGenerateText` (generateText + hard
  timeout for providers that ignore AbortSignal).
- **`system-cache.ts`** — `systemCacheControl`: registry-driven provider options to
  cache the (large) system prompt on Anthropic models across an agent loop's steps.

Consumed by `code-review`, `cli-review`, `organization`, … — any lib that needs to
create or describe an LLM model. Keep this free of review/agent-specific shapes
(findings, diffs, suggestions): those belong in their own domain libs.

## ChatGPT / Codex subscriptions

The `chatgpt_subscription` provider runs reviews using subscription OAuth
credentials. This integration is backend-only: it does not add a sign-in flow
or a credential form to the dashboard. Model access and quotas depend on the
account; the static picker is only a convenience, and a supported model id can
be supplied directly.

An organization administrator can obtain `tokens.access_token`,
`tokens.refresh_token`, and `tokens.account_id` from a Codex CLI login and save
them through `POST /organization-parameters/create-or-update`, authenticated
with the administrator's user JWT (a CLI team key does not authorize this
route). Supply the tokens as plaintext over HTTPS; the API encrypts both token
fields at rest and masks them on reads. Do not put them in a repository or logs.

Example request body for an organization with no existing BYOK configuration:

```json
{
    "key": "byok_config",
    "configValue": {
        "version": 2,
        "credentials": [
            {
                "id": "codex-subscription",
                "provider": "chatgpt_subscription",
                "settings": {
                    "codexAccessToken": "<access_token>",
                    "codexRefreshToken": "<refresh_token>",
                    "accountId": "<account_id>"
                }
            }
        ],
        "models": [
            {
                "id": "codex-review",
                "credentialId": "codex-subscription",
                "model": "<model available to your subscription>"
            }
        ],
        "routing": { "defaultModelId": "codex-review" }
    }
}
```

A save replaces the complete BYOK configuration. For an already configured
organization, retain its other credentials, models and routing entries. Use
blank token fields when keeping saved secrets. The connection test at
`POST /organization-parameters/test-byok` accepts `provider`, `model`,
`codexAccessToken`, `codexRefreshToken`, and `accountId` at the top level. It
uses the runtime transport, but never refreshes an unsaved credential; expired
tokens must be reconnected.

Production refreshes are coordinated across workers with a PostgreSQL advisory
lock. The worker reloads the credential under that lock, exchanges only a stale
token, and persists its replacement with compare-and-swap before retrying the
model call. Settings saves and model deletion also compare-and-swap when a
subscription is present. Persistence failures retry with bounded backoff; a
process crash between the OAuth exchange and persistence can still require a
new login. Subscription token usage is recorded with its provider prefix and
contributes zero to per-token spend (the subscription fee is not tracked).

For a single-process local development setup, `API_CODEX_AUTH_FILE` can point
to a writable Codex CLI `auth.json`. Mount its containing directory if using
Docker: refresh replaces the file atomically. This is an explicit alternative
for directly constructed models without stored tokens, not an implicit home
file fallback or a way to select the subscription via `API_LLM_PROVIDER`.

Offline coverage lives in `codex-subscription-model.spec.ts` and the provider,
credential, usage and registry suites. Real database checks live in
`test/integration/byok/codex-rotation.integration.spec.ts` (`TEST_PG_*` selects
the test database). Live endpoint tests are opt-in via `CODEX_LIVE=1`,
`CODEX_LIVE_AUTH=/path/to/auth.json`, and `CODEX_LIVE_MODEL=<available model>`;
they consume subscription quota and are skipped by default.
