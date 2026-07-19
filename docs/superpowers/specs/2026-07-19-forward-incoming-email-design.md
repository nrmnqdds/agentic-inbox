# Forward every incoming email to a configured address

**Date:** 2026-07-19
**Status:** Approved

## Goal

Forward a copy of every inbound email to a single configured destination
(`quddusnuriman@gmail.com`) while keeping the existing inbox behavior fully
intact — the app still parses, stores, and runs the AI agent on each message.

## Approach

Use the native Cloudflare Email Routing `message.forward()` API inside the
Worker `email()` handler.

Alternatives considered and rejected:

- **Cloudflare Email Routing dashboard rule** — a routing rule cannot both
  deliver to the Worker *and* forward; the Worker is the routing destination.
  Doing it in code keeps forwarding alongside existing processing.
- **Re-send via the `EMAIL` send binding** — would rewrite `From` to our own
  domain and degrade deliverability. `message.forward()` relays the original
  message intact (headers, DKIM alignment, attachments) and preserves the real
  sender.

## Changes

### 1. Config — `wrangler.jsonc`
Add a var to `vars`:
```jsonc
"FORWARD_TO": "quddusnuriman@gmail.com"
```
Unset or empty ⇒ forwarding is skipped (feature is off).

### 2. Env type — `workers/types.ts`
Add `FORWARD_TO?: string` to the `Env` interface.

### 3. Forwarding helper — `workers/index.ts`
Add and export a small, well-bounded function:
```ts
export async function forwardIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
) {
  if (!env.FORWARD_TO) return;
  try {
    await message.forward(env.FORWARD_TO);
  } catch (e) {
    // Best-effort: a forwarding failure must never block ingestion.
    console.error("Failed to forward email:", (e as Error).message);
  }
}
```
Placed in `index.ts` (not `app.ts`) so it is unit-testable in the hermetic Node
test environment, matching `receiveEmail`.

### 4. Wire it in — `workers/app.ts` `email()` handler
- Retype the `event` param to `ForwardableEmailMessage` (already present in the
  generated `worker-configuration.d.ts`).
- Forward **first** (best-effort), then run `receiveEmail(...)` unchanged,
  preserving its re-throw-on-error retry behavior.

```ts
async email(message: ForwardableEmailMessage, env, ctx) {
  await forwardIncomingEmail(message, env);
  try {
    await receiveEmail(message, env, ctx);
  } catch (e) {
    console.error("Failed to process incoming email:", ...);
    throw e; // let Cloudflare retry/bounce rather than silently drop
  }
}
```

## Prerequisite (one-time, manual)

`message.forward()` only relays to a **verified** Email Routing destination:
```
npx wrangler email routing addresses create quddusnuriman@gmail.com
```
Then click the verification link Cloudflare emails to that Gmail. Until verified,
forward calls throw and are logged (non-fatal).

## Known trade-off

Forwarding runs before `receiveEmail`. If `receiveEmail` throws, Cloudflare
retries the whole email event, re-forwarding — so a rare processing failure can
produce a duplicate copy in Gmail. Accepted in exchange for guaranteeing every
message is forwarded even when processing later fails. Documented in a code
comment.

## Testing

Extend `workers/index.test.ts` (hermetic Node, no bindings) covering
`forwardIncomingEmail`:

1. Calls `message.forward(env.FORWARD_TO)` when `FORWARD_TO` is set.
2. A `forward()` rejection is swallowed (does not throw).
3. No `FORWARD_TO` ⇒ `forward()` is never called.
