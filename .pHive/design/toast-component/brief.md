# Design Brief: Toast/Notification Component

## Surface

A single `<div id="toast-region" role="region" aria-label="Notifications">`
appended once to `<body>` at boot (not `#content`) — survives every
navigation, since it's outside the router's mount point entirely.

## Layout

- Fixed position, bottom-right, `20px` inset.
- Stacks newest-on-top (`flex-direction: column-reverse`), each toast a
  bordered card using the app's real tokens (`--bg`/`--border`/`--muted`),
  a 3px left accent border colored by kind (`--ok-fg`/`--danger`/`--accent`).
- Icon + message + a manual `×` close button per toast.

## Behavior

- `showToast(message, kind)` — `kind: "success" | "error" | "info"`.
- Auto-dismiss after ~4s; the manual close button clears it immediately.
- Success/info toasts: `role="status"`, `aria-live="polite"` (region-level).
- Error toasts: `role="alert"` — announced immediately regardless of where
  focus currently is, since a delete/save failure needs to interrupt.
- Respects `prefers-reduced-motion` (the wireframe's slide-in animation is
  disabled, not just slowed).

## What routes through here vs. stays inline

See `ui-feedback-states`' design-discussion.md, Decision 2, for the full
reasoning. Short version: transient one-off events (sync/push results,
delete failure, save success/failure for verdict/next-step/autostart/
secrets-backend) go through toast. Standing state tied to a specific field
or persistent condition (form validation errors, the Database/Secrets-
backend "restart to apply" notes, the Google account status line) stays
inline where it already is.

## Open question for review

1. Position: bottom-right (as wireframed) vs. bottom-center vs. top-right.
   Bottom-right chosen as the least likely to overlap the settings-page
   card stack or the contact-detail action buttons (both live top-right/
   top-of-page); confirm this reads as out-of-the-way enough.
