import { describe, expect, it, vi } from "vitest";
import {
	app,
	forwardIncomingEmail,
	getSigningKey,
	verifyDownloadToken,
} from "./index";
import type { Env } from "./types";

// Minimal in-memory stand-ins for the Cloudflare bindings the send route
// touches (R2, the mailbox DO, and the Email binding). Enough to exercise the
// attachment-to-link conversion without Miniflare.
function makeSendEnv() {
	const store = new Map<string, Uint8Array>();
	const bucket = {
		head: async (key: string) =>
			key.startsWith("mailboxes/") || store.has(key) ? { key } : null,
		get: async (key: string) => {
			if (!store.has(key)) return null;
			const bytes = store.get(key)!;
			return {
				body: bytes,
				arrayBuffer: async () =>
					bytes.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + bytes.byteLength,
					),
			};
		},
		put: async (key: string, value: Uint8Array | ArrayBuffer) => {
			store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
		},
	};
	const createEmailCalls: unknown[][] = [];
	const stub = {
		checkSendRateLimit: async () => null,
		createEmail: async (...args: unknown[]) => {
			createEmailCalls.push(args);
		},
	};
	const sent: Record<string, unknown>[] = [];
	const env = {
		BUCKET: bucket,
		MAILBOX: { idFromName: (n: string) => n, get: () => stub },
		EMAIL: {
			send: async (msg: Record<string, unknown>) => {
				sent.push(msg);
				return { messageId: "smtp-1" };
			},
		},
	} as unknown as Env;
	return { env, sent, createEmailCalls };
}

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

describe("POST /api/v1/mailboxes/:id/emails — attachment auto-links", () => {
	async function send(env: Env, mailboxId: string, body: unknown) {
		const waited: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (p: Promise<unknown>) => waited.push(p),
			passThroughOnException: () => {},
		};
		const res = await app.request(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
			env,
			ctx as never,
		);
		await Promise.all(waited);
		return res;
	}

	it("replaces a file attachment with a signed /d/ link and keeps inline attached", async () => {
		const { env, sent, createEmailCalls } = makeSendEnv();
		const mailboxId = "me@mail.build";

		const res = await send(env, mailboxId, {
			to: "them@example.com",
			from: mailboxId,
			subject: "hi",
			html: "<p>see file</p>",
			text: "see file",
			attachments: [
				{
					content: btoa("PDFDATA"),
					filename: "report.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
				{
					content: btoa("IMG"),
					filename: "logo.png",
					type: "image/png",
					disposition: "inline",
					contentId: "logo",
				},
			],
		});

		expect(res.status).toBe(202);
		expect(sent).toHaveLength(1);
		const msg = sent[0] as {
			html: string;
			attachments?: { filename: string }[];
		};

		// The real file is no longer a MIME attachment; the inline image stays.
		const sentFilenames = (msg.attachments ?? []).map((a) => a.filename);
		expect(sentFilenames).toContain("logo.png");
		expect(sentFilenames).not.toContain("report.pdf");

		// The body gained a /d/ link for the report.
		expect(msg.html).toContain("report.pdf");
		const match = msg.html.match(/\/d\/([A-Za-z0-9._-]+)/);
		expect(match).toBeTruthy();
		const token = match![1];

		// And that token is a VALID signed download token for this send.
		const key = await getSigningKey(env);
		const payload = await verifyDownloadToken(key, token);
		expect(payload).not.toBeNull();
		expect(payload!.mailboxId).toBe(mailboxId);
		expect(payload!.emailId).toBeTruthy();
		expect(payload!.attachmentId).toBeTruthy();

		// The stored SENT copy carries the link-augmented body too.
		const storedBody = (createEmailCalls[0][1] as { body: string }).body;
		expect(storedBody).toContain("/d/");
	});

	it("sends no MIME attachments and no link section when there are none", async () => {
		const { env, sent } = makeSendEnv();
		const mailboxId = "me@mail.build";

		await send(env, mailboxId, {
			to: "them@example.com",
			from: mailboxId,
			subject: "plain",
			html: "<p>body</p>",
		});

		const msg = sent[0] as { html: string; attachments?: unknown[] };
		expect(msg.attachments ?? []).toHaveLength(0);
		expect(msg.html).not.toContain("/d/");
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
