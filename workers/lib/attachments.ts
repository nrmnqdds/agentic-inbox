// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import { escapeHtml } from "./email-helpers";
import type { Env } from "../types";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = (att.filename || "untitled").replace(
			/[/\\:*?"<>|\x00-\x1f]/g,
			"_",
		);
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
		const binaryStr = atob(att.content);
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}

/**
 * Append a "download links" section to the outgoing email bodies.
 * Used when real attachments are sent as secure /d/ links instead of MIME
 * parts. An undefined body stays undefined; a defined body is augmented.
 */
export function appendDownloadLinks(
	links: { filename: string; url: string }[],
	html?: string,
	text?: string,
): { html?: string; text?: string } {
	if (!links.length) return { html, text };

	const htmlBlock =
		`<hr><p>📎 Attachments:</p><ul>${links
			.map(
				(l) =>
					`<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.filename)}</a></li>`,
			)
			.join("")}</ul>`;

	const textBlock = `\n\n📎 Attachments:\n${links
		.map((l) => `• ${l.filename} → ${l.url}`)
		.join("\n")}`;

	return {
		html: html !== undefined ? html + htmlBlock : html,
		text: text !== undefined ? text + textBlock : text,
	};
}
