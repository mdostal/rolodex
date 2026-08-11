# Rolodex — First-Run Setup Wizard: Wireframe Design Brief

**Tool discovery note:** Frame0 CLI is not available in this environment. Text-based layout specs with ASCII mockups per the documented fallback.

**Source context:** `.pHive/CONTEXT.md`, `structured-outline.md` Part 2 Phase 4, `src/lib/store.ts` (default DB path `~/.local/share/rolodex/rolodex.db`, SecretsAdapter keys `google.oauth.client`/`google.oauth.token`). No `brand-system.yaml` exists yet — neutral desktop-app heuristics applied.

---

## 0. Design principles applied

1. **This is infrastructure, not a product tour.** Every screen's job is to get the user to their contact list as fast as correctness allows.
2. **Fail fast, explain clearly.** Database and Secrets screens catch environment problems before they become silent data-loss or silent-failure bugs.
3. **Never force the awkward part.** Google OAuth setup requires leaving the app for Google Cloud Console — make that detour as short and well-signposted as possible, and let the user defer it entirely.
4. **Capability over coverage, reflected in copy.** Exactly one sync provider (Google) and one secrets backend (OS keychain) this epic — screens read as definitive, not as a provider picker with options cut.
5. **No login screen — ever.** Screen 5 hands off directly into the contact list. Nothing resembles an auth gate.

---

## 1. Global wizard chrome

- **Window:** fixed-size, non-resizable, centered. ~720×560. Modal-style single window, no menu bar.
- **Title bar:** "Rolodex Setup" + native close control. Closing mid-wizard prompts "Quit setup? You can resume where you left off."
- **Progress stepper:** persistent horizontal row, all 5 steps visible at once (not "step 2 of 5" text-only). Completed = checkmark, current = filled/bracketed, upcoming = plain.
- **Navigation bar:** fixed footer. `Back` bottom-left (disabled/absent on screen 1), primary action bottom-right.
- **Keyboard:** `Enter` triggers primary action, `Esc`/`Alt+←` triggers Back. Tab order follows visual reading order.

---

## 2. Screen-by-screen

### Screen 1 — Welcome
Centered single column, generous whitespace. App mark, H1 ("Welcome to your rolodex."), one-sentence subtext, a 3-item plain preview list (informational only, not clickable — no skipping ahead). No Back button.

### Screen 2 — Database location
Single field row: read-only path display (monospace) + `Change…` button opening the OS-native folder picker (never a custom in-app tree view). A writability status line runs automatically on entry and on path change. `Reset to default` link appears once changed. Error state: "Rolodex can't write to this location — choose a different folder or use the default." `Next` disabled until resolved (soft gate — reset-to-default is always a working escape hatch).

### Screen 3 — Google connect
Instructions collapsed by default (disclosure triangle) so returning/technical users see just two fields + two buttons. Expanding reveals numbered setup steps + two external links (Google Cloud Console directly, a Rolodex-authored written guide). Two inputs: Client ID (plain), Client Secret (masked, Show/Hide toggle). Trust microcopy: "🔒 Stored only in your system keychain. Never written to a file, an environment variable, or a log." Footer: `Back` / `Skip for now` / `Connect & Continue`.

`Connect & Continue`: opens OAuth consent in the **system default browser** (never an embedded webview — required for Google's desktop OAuth flow, avoids phishing-lookalike risk). Inline waiting state with spinner + Cancel. On success: fields lock, "✓ Connected as <email>" replaces waiting state, auto-advances to Screen 4. On failure: see error catalog below.

`Skip for now` advances to Screen 4 with no Google credentials — mitigates the OAuth-per-installer drop-off risk named in the outline; the user is never blocked from reaching their contact list because Google Cloud Console defeated them today.

### Screen 4 — Secrets check
Runs automatically on entry: spinner "Checking keychain access…", `Next` disabled during the check. Success: "✓ Keychain access confirmed — Using: macOS Keychain", `Next` enables automatically. Failure: "✗ Couldn't write to your system keychain" + specific causes (locked keychain, permission denied, no keychain daemon available) + `Retry` / `Copy error details` / `Troubleshooting guide` — **this is the wizard's one true hard gate**, matching the "fail fast, not silently" requirement.

Sequencing note: Google credentials collected on Screen 3 stay wizard-local in memory until this screen's check-and-write — Screen 4 is simultaneously the capability check and the actual commit point. Recommendation for engineering: run a silent, non-blocking capability probe as early as Screen 1-2 (background thread) so a broken keychain surfaces before the user has typed OAuth credentials.

### Screen 5 — Finish
Summary checklist: "✓ Database ready" (path shown), "✓ Google connected" (email shown, or a "connect anytime from Settings" note if skipped), "✓ Secure storage verified" (backend name shown). Single CTA: `Open Rolodex →`. Clicking it writes the first-run-complete sentinel, closes the wizard, and mounts the contact list directly — populated if Google sync ran, or in its empty state if skipped. **No intermediate screen, no login/auth gate.**

---

## 3. Flow diagram

```
Welcome -> Database -> Google connect -+-> Secrets check -> Finish -> Contact list
                            |          |         |
                      [Skip for now] --+   [Retry loop on keychain
                                             failure, blocks Next]
```

Strictly linear, `Back` is the only reverse path — no jumping via the stepper (later screens depend on state committed by earlier ones). First-run detection (not a screen): on app boot, check the first-run sentinel; if set, skip the wizard entirely.

Recommendation: persist wizard progress (last completed step) alongside the first-run sentinel, so a user who quits mid-setup resumes rather than restarting from Welcome.

---

## 4. Error / retry state catalog

| Screen | Failure | Message | Recovery |
|---|---|---|---|
| Database | Path not writable | "Rolodex can't write to this location — choose a different folder or use the default." | Reset to default / pick another folder |
| Google connect | User denies consent | "Google sign-in was cancelled. You can try again or skip Google for now." | Retry / Skip |
| Google connect | Invalid client ID/secret | "Google didn't recognize these credentials. Double-check the Client ID and Secret." | Fields stay populated, editable |
| Google connect | Network/timeout | "Couldn't reach Google. Check your connection and try again." | Retry, no data loss |
| Secrets check | Keychain locked | "Your keychain is locked — unlock it and retry." | Retry |
| Secrets check | Permission denied | "Rolodex doesn't have permission to access the keychain. Check your OS privacy/security settings." | Retry + troubleshooting link |
| Secrets check | No keychain backend (headless Linux/SSH) | "No secure keychain is available in this session." | Genuine hard stop — no env-var fallback exists per the epic's security constraint |

All failures retryable within the wizard, never fatal — no failure forces a quit/relaunch.

---

## 5. Accessibility notes (WCAG 2.1 AA)

- Focus order matches visual reading order; primary action reachable via Tab → Enter.
- `aria-live="polite"` on the Secrets-check and Google-connect state transitions.
- Error text never color-only — red/✗ pairs with a written sentence and a distinct icon shape from success ✓.
- Contrast 4.5:1 for body/error/success text; disabled `Next` still meets 3:1 non-text contrast.
- Both credential inputs need explicit `<label>` elements; Show/Hide toggle's accessible name changes with state.
- Target size ≥24×24 CSS px (WCAG 2.5.8) with comfortable spacing in the Screen 3 footer.
- Spinners respect `prefers-reduced-motion` — fall back to a static "Checking…" text state.
- External links labeled as opening externally, both visually (↗) and via accessible name.

---

## 6. Component reuse note (forward-looking)

Build the Google-connect panel and Secrets-check panel as standalone, embeddable components (not wizard-screen-only markup) — they're exactly what a future Settings → Google Contacts screen (deferred, per structured-outline.md Deferred Items) will need to reuse verbatim.

**Linked story:** saf-04-setup-wizard
