// Anti-flash: apply the saved theme before first paint. Loaded as a
// render-blocking script in <head> from app/root.tsx.
// NOTE: The storage key below is a hard-coded duplicate of THEME_STORAGE_KEY
// in app/hooks/useThemeStore.ts — this file is served as a static asset and
// cannot import app modules. Keep both in sync.
(() => {
	try {
		var t = localStorage.getItem("agentic-inbox-theme");
		if (t === "dark" || t === "light") {
			var r = document.documentElement;
			r.dataset.mode = t;
			r.style.colorScheme = t;
		}
	} catch (e) {
		// Storage unavailable (private mode etc.) — fall back to light.
	}
})();
