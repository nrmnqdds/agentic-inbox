import { describe, expect, it } from "vitest";
import { appendDownloadLinks } from "./attachments";

describe("appendDownloadLinks", () => {
	it("appends a link section to both html and text bodies", () => {
		const { html, text } = appendDownloadLinks(
			[{ filename: "report.pdf", url: "https://inbox.test/d/tok" }],
			"<p>hi</p>",
			"hi",
		);
		// original bodies are preserved
		expect(html).toContain("<p>hi</p>");
		expect(text).toContain("hi");
		// link + filename are appended
		expect(html).toContain("report.pdf");
		expect(html).toContain("https://inbox.test/d/tok");
		expect(text).toContain("report.pdf → https://inbox.test/d/tok");
	});

	it("escapes HTML in the filename to prevent body injection", () => {
		const { html } = appendDownloadLinks(
			[{ filename: "<img src=x onerror=alert(1)>.pdf", url: "https://x/d/t" }],
			"<p>b</p>",
			undefined,
		);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img");
	});

	it("returns bodies unchanged when there are no links", () => {
		const { html, text } = appendDownloadLinks([], "<p>b</p>", "b");
		expect(html).toBe("<p>b</p>");
		expect(text).toBe("b");
	});

	it("leaves an undefined body undefined but still fills the defined one", () => {
		const { html, text } = appendDownloadLinks(
			[{ filename: "a.pdf", url: "https://x/d/t" }],
			undefined,
			"t",
		);
		expect(html).toBeUndefined();
		expect(text).toContain("a.pdf");
	});
});
