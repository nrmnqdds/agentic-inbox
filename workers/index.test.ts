import { describe, expect, it, vi } from "vitest";
import { app, forwardIncomingEmail } from "./index";
import type { Env } from "./types";

// These hit the mailbox-create validation path, which returns before any
// Cloudflare binding (R2/DO) is touched — so they run in plain Node with an
// empty env. Regression cover for: invalid input must return a clean 400, not
// crash as a 500 (unhandled ZodError).
async function postMailbox(body: unknown) {
	return app.request(
		"/api/v1/mailboxes",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		},
		{} as never,
	);
}

describe("POST /api/v1/mailboxes — body validation", () => {
	it("returns 400 (not 500) for a non-email `email`", async () => {
		const res = await postMailbox({ email: "notanemail", name: "x" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(
			/invalid request body/i,
		);
	});

	it("returns 400 (not 500) for a non-ASCII / CJK local-part (EAI not yet supported)", async () => {
		const res = await postMailbox({ email: "测试@mail.build", name: "x" });
		expect(res.status).toBe(400);
	});

	it("returns 400 (not 500) for a missing `name`", async () => {
		const res = await postMailbox({ email: "ok@mail.build" });
		expect(res.status).toBe(400);
	});

	it("returns 400 (not 500) for malformed JSON", async () => {
		const res = await postMailbox("{not valid json");
		expect(res.status).toBe(400);
	});
});

describe("forwardIncomingEmail", () => {
	const envWith = (forwardTo?: string) =>
		({ FORWARD_TO: forwardTo }) as unknown as Env;
	const mockMessage = () => ({ forward: vi.fn().mockResolvedValue(undefined) });

	it("forwards to env.FORWARD_TO when set", async () => {
		const message = mockMessage();
		await forwardIncomingEmail(message as never, envWith("dest@example.com"));
		expect(message.forward).toHaveBeenCalledTimes(1);
		expect(message.forward).toHaveBeenCalledWith("dest@example.com");
	});

	it("does not throw when forward() rejects (best-effort)", async () => {
		const message = { forward: vi.fn().mockRejectedValue(new Error("boom")) };
		await expect(
			forwardIncomingEmail(message as never, envWith("dest@example.com")),
		).resolves.toBeUndefined();
		expect(message.forward).toHaveBeenCalledTimes(1);
	});

	it("does not forward when FORWARD_TO is unset", async () => {
		const message = mockMessage();
		await forwardIncomingEmail(message as never, envWith(undefined));
		expect(message.forward).not.toHaveBeenCalled();
	});
});
