// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";

export type Theme = "light" | "dark";

/**
 * localStorage key for the theme preference.
 * NOTE: This key string is duplicated in the inline anti-flash script in
 * app/root.tsx — that script runs before app modules load and cannot import
 * this constant. Keep both in sync.
 */
export const THEME_STORAGE_KEY = "agentic-inbox-theme";

function isTheme(value: unknown): value is Theme {
	return value === "light" || value === "dark";
}

/**
 * Read the persisted theme. Returns "light" when unset, invalid, or storage
 * is unavailable (e.g. private browsing). SSR-safe.
 */
function readStoredTheme(): Theme {
	if (typeof window === "undefined") return "light";
	try {
		const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
		return isTheme(stored) ? stored : "light";
	} catch {
		return "light";
	}
}

/**
 * Apply a theme to the document root. Kumo's semantic tokens flip under
 * [data-mode="dark"]; color-scheme makes native scrollbars and form
 * controls follow.
 */
function applyThemeToDocument(theme: Theme) {
	const root = document.documentElement;
	root.dataset.mode = theme;
	root.style.colorScheme = theme;
}

interface ThemeState {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
	theme: readStoredTheme(),

	setTheme: (theme) => {
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, theme);
		} catch {
			// Storage unavailable — theme still applies for this session.
		}
		applyThemeToDocument(theme);
		set({ theme });
	},

	toggleTheme: () => {
		get().setTheme(get().theme === "dark" ? "light" : "dark");
	},
}));
