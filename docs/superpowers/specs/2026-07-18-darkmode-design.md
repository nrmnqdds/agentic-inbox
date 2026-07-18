# Dark Mode Support — Design

**Date:** 2026-07-18
**Status:** Approved

## Summary

Add light/dark theme support to Agentic Inbox. The app is built on `@cloudflare/kumo`,
which already ships complete dark-mode tokens: every `*-kumo-*` semantic color uses
CSS `light-dark()` and flips when `data-mode="dark"` is set on the `<html>` element.
Kumo component CSS (skeletons, date picker, shiki) also keys off `[data-mode="dark"]`.
The app itself uses kumo tokens almost exclusively (~280 usages across components),
so dark mode is a matter of theme state management, pre-paint application, and a
toggle UI — not a restyling effort.

## Decisions (from brainstorming)

- **Modes:** Light / Dark only. No system/OS-preference following. Default is light.
- **Persistence:** `localStorage`, key `agentic-inbox-theme`.
- **Toggle placement:** Settings page only (new "Appearance" card). Nothing in the header.
- **Email bodies:** The `EmailIframe` keeps its forced white background and
  `color-scheme: light` in both modes (Gmail/Outlook behavior — sender HTML renders
  as designed).

## Approach

localStorage + inline anti-flash script (rejected alternatives: cookie-based SSR
rendering — too much machinery for a cosmetic pref; mount-only localStorage read —
causes a visible light flash before dark applies).

## Components

### 1. Theme store — `app/hooks/useThemeStore.ts` (new)

A small zustand store, matching the existing `useUIStore` pattern:

- State: `theme: "light" | "dark"`.
- Actions: `setTheme(theme)`, `toggleTheme()`.
- `setTheme` writes `localStorage["agentic-inbox-theme"]` and sets
  `document.documentElement.dataset.mode` and
  `document.documentElement.style.colorScheme` to the theme (so native scrollbars
  and form controls follow).
- Initial value: `"light"` during SSR; in the browser, lazily read from
  localStorage on store creation.
- Only the exact stored values `"light"` and `"dark"` are honored; anything else
  (missing, corrupted, old value) falls back to `"light"`.

### 2. Anti-flash inline script — `app/root.tsx`

An inline `<script>` in `<head>` (via `dangerouslySetInnerHTML`, placed before
`<Links/>`) that runs before first paint:

1. Reads `localStorage["agentic-inbox-theme"]` inside try/catch.
2. If the value is exactly `"dark"` or `"light"`, sets `data-mode` and
   `color-scheme` on `document.documentElement`.
3. On any error (e.g. private-mode localStorage access failure), does nothing —
   the app degrades to light without crashing.

SSR renders light by default (no `data-mode` attribute); the script corrects to
dark pre-paint when dark is saved. No root loader, no cookies, no server-side
changes.

The localStorage key string appears in both this script and the theme store; the
script must stay inline and self-contained (it cannot import app modules), so the
duplication is accepted and called out in a comment in both places.

### 3. Settings UI — `app/routes/settings.tsx`

A new "Appearance" card rendered first in the settings stack, using the same card
markup as the existing Account/Agent sections
(`rounded-lg border border-kumo-line bg-kumo-base p-5`):

- Header row: `SunIcon` (phosphor, duotone, `text-kumo-subtle`) + "Appearance"
  label (`text-sm font-medium text-kumo-default`).
- Control: a two-option segmented control — **Light** (`SunIcon`) and **Dark**
  (`MoonIcon`) — built from kumo `Button`s; the active option uses a primary-ish
  visual state, the inactive one a subtle state.
- Selection calls `setTheme` immediately: the theme applies and persists
  instantly, with no save step.
- Helper text (`text-xs text-kumo-subtle`) clarifies that appearance applies
  instantly and is separate from the mailbox "Save Changes" button below, which
  stays scoped to mailbox settings.

## Data flow

1. First paint: SSR HTML has no `data-mode` (light). Inline script reads
   localStorage and sets `data-mode="dark"` pre-paint when saved → no flash.
2. Hydration: theme store initializes from the same localStorage key → React
   state matches the DOM.
3. Toggle: settings control → `setTheme` → localStorage write +
   `document.documentElement.dataset.mode` update → all kumo tokens flip via
   `light-dark()` instantly.
4. Subsequent visits: step 1 applies the saved choice.

## Error handling

- localStorage unavailable/throws (private mode, disabled storage): inline script
  no-ops (light theme); store reads/writes are guarded so the UI still toggles for
  the session even if persistence fails.
- Corrupted stored value: ignored, falls back to light.

## Explicit non-changes

- `app/components/EmailIframe.tsx`: untouched — email bodies stay white with
  `color-scheme: light` in both modes.
- `app/routes/mailbox.tsx`: the `bg-black/30` mobile scrim stays (works in both modes).
- No cross-tab `storage`-event synchronization (YAGNI).
- No system/OS-preference mode.
- No backend/worker changes of any kind.

## Files touched

| File | Change |
| --- | --- |
| `app/hooks/useThemeStore.ts` | New — zustand theme store |
| `app/root.tsx` | Add inline anti-flash script in `<head>` |
| `app/routes/settings.tsx` | Add "Appearance" card |

## Verification

1. `npm run typecheck` passes.
2. Run the dev server; manually verify:
   - Toggling Light/Dark in settings flips the whole app instantly.
   - Reloading with dark saved renders dark with no light flash.
   - Email list, thread view, compose panel, agent panel, and settings all read
     correctly in dark mode.
   - Email bodies inside the iframe still render on white.
   - Mobile scrim and dialogs look right in dark mode.
