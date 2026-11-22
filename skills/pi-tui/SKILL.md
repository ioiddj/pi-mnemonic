---
name: pi-tui
description: Build Pi TUI components, dialogs, overlays, and widgets that use Pi's theme, keybindings, layout, and rendering contracts. Use when creating or reviewing an interactive extension UI.
---

# Pi TUI components

Use this skill when adding or reviewing interactive UI in a Pi extension. It vendors the Pi 1.6.0 TUI docs and the `pi-extensions` UI references so the guidance stays available with this package.

## Choose the right surface

- `ctx.ui.select/confirm/input/editor` for standard dialogs.
- `ctx.ui.notify` / `setStatus` for non-blocking feedback.
- `ctx.ui.setWidget` for persistent content around the editor.
- `ctx.ui.custom` for temporary interactive screens and overlays.
- `ctx.ui.setHeader/setFooter/setEditorComponent` only when replacing a main area.

Do not render memory dumps, status tables, or tool output into the chat transcript or footer when an overlay or widget is appropriate.

## Custom component contract

A custom component returns terminal lines for a given width. It must:

- Fit every visible line to the supplied width using `truncateToWidth` / `visibleWidth`, not `String.length`.
- Reapply styling each line; Pi resets styles after every line.
- Cache rendered lines by width and state; invalidate on change.
- Call `tui.requestRender()` after state changes.
- Finish with the supplied `done()` callback.
- Dispose timers, subprocesses, and listeners in `dispose()`.

Use Pi's theme and keybindings passed to the factory:

```ts
const result = await ctx.ui.custom<void>(
  (tui, theme, keybindings, done) => new MyComponent(tui, theme, keybindings, done),
  { overlay: true, overlayOptions: { anchor: "center", width: 72, maxHeight: 20 }, blocked: { kind: "question", message: "Browse memory" } },
);
```

Use `keybindings.matches(data, "tui.select.cancel")` and `matchesKey(data, Key.escape)` rather than hard-coded byte comparisons when possible.

## Overlay guidance

Use `overlay: true` for temporary dialogs. Prefer `overlayOptions` for size and placement instead of manually positioning lines. For a register browser, a centered box with `anchor: "center"`, `width: 72`, `maxHeight: 20`, and a blocked status of `"question"` is appropriate.

Keyboard must always work; mouse events are unavailable in regular mode. If adding mouse support to a self-drawn list, implement `rowMap` and two-phase press/click as described in `references/tui-mouse-interaction.md`.

## Theming

Use semantic tokens through `theme.fg` / `theme.style`:

- `accent` for titles and active items
- `border`, `borderMuted` for box frames
- `text`, `muted`, `dim` for content hierarchy
- `success`, `warning`, `error` for status
- `selectedBg` for highlighted rows

Do not store themed strings permanently unless `invalidate()` rebuilds them after theme changes.

## References

- `../../docs/pi/tui.md` — upstream TUI component and lifecycle reference.
- `../../docs/pi/themes.md` — theme tokens and color rules.
- `../../docs/pi/keybindings.md` — named actions and key syntax.
- `../../docs/pi/extensions.md` — extension lifecycle and `ctx.ui` API.
- `../../docs/pi/rpc-extension-ui.md` — RPC UI behavior.
- `references/ui-components.md` — component and dialog quick reference.
- `references/tui-beautiful-rendering.md` — border/box/status patterns.
- `references/tui-mouse-interaction.md` — mouse and hit-testing contracts.
- `references/PATTERNS.md` / `references/ANTI-PATTERNS.md` — broader extension patterns.
- `../../docs/pi/examples/` — upstream examples for overlays, widgets, and async UI.

Vendored from Pi 1.6.0 on 2026-11-22. Refresh when upgrading Pi.
