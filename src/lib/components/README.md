# Vendored UI components

Reusable primitives under `ui/` and `ai-elements/` are **vendored into this
repository**. They are part of the whatsagent tree: edit them here, review them
here, and do not treat an external catalog checkout as a runtime dependency.

| Path | Role |
| --- | --- |
| `ui/` | Bits-ui / shadcn-style primitives (button, sidebar, sheet, …) |
| `ai-elements/` | Conversation / message / shimmer building blocks |
| `app/` | whatsagent-specific widgets (chat list, conversation pane, …) — not vendored |

Styling routes through `src/app.css` `@theme` tokens. Prefer token changes over
per-component surgery when restyling.
