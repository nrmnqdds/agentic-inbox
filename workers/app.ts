// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createRequestHandler } from "react-router";
import {
	app as apiApp,
	forwardIncomingEmail,
	getSigningKey,
	receiveEmail,
	verifyDownloadToken,
} from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { EmailAgent } from "./agent";
export { MailboxDO } from "./durableObject";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// -- Public attachment download route (no Access auth needed) ----------
// Tokens are HMAC-signed and self-validating; no DB lookup required for auth.
// Route must be registered before the Access middleware to bypass it.
app.get("/d/:token", async (c) => {
	const token = c.req.param("token");
	if (!token || token.length < 20) {
		return c.text("Invalid or missing token", 400);
	}

	try {
		const key = await getSigningKey(c.env);
		const payload = await verifyDownloadToken(key, token);
		if (!payload) {
			return c.text("Invalid or expired download link", 403);
		}

		// Look up attachment metadata from the mailbox DO
		const doId = c.env.MAILBOX.idFromName(payload.mailboxId);
		const stub = c.env.MAILBOX.get(doId);
		const attachment = (await (stub as any).getAttachment(
			payload.attachmentId,
		)) as {
			filename: string;
			mimetype: string;
		} | null;
		if (!attachment) {
			return c.text("Attachment not found", 404);
		}

		// Fetch the file from R2
		const r2Key = `attachments/${payload.emailId}/${payload.attachmentId}/${attachment.filename}`;
		const obj = await c.env.BUCKET.get(r2Key);
		if (!obj) {
			return c.text("Attachment file not found", 404);
		}

		const headers = new Headers();
		headers.set("Content-Type", attachment.mimetype);
		const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
		headers.set(
			"Content-Disposition",
			`attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
		);
		// Prevent MIME-type sniffing (defense-in-depth with Content-Disposition: attachment)
		headers.set("X-Content-Type-Options", "nosniff");
		// Prevent search engines from indexing download links
		headers.set("X-Robots-Tag", "noindex, nofollow");
		return new Response(obj.body, { headers });
	} catch (e) {
		console.error("Download route error:", (e as Error).message);
		return c.text("Internal error", 500);
	}
});

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		// Forward a copy first (best-effort — never blocks ingestion). If
		// receiveEmail later throws, Cloudflare retries the whole event and this
		// re-forwards, so a rare processing failure can produce a duplicate copy.
		await forwardIncomingEmail(message, env);
		try {
			await receiveEmail(message, env, ctx);
		} catch (e) {
			console.error(
				"Failed to process incoming email:",
				(e as Error).message,
				(e as Error).stack,
			);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
