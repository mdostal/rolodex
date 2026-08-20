# Grill Record — release-readiness

**Source draft:** README.md (checked against docs/ARCHITECTURE.md as research brief, and against the actual current code in src/)
**CONTEXT.md substrate:** absent (reduced fidelity — no `.pHive/CONTEXT.md` in this repo)
**inconsistency_risk_signals:** absent (heuristic pass)
**round_number:** 2 (a first grill pass ran earlier this session against README.md before the settings-account-screen, ui-feedback-states, and ui-visual-cleanup epics existed; this round re-checks after all three merged)
**unresolved_count:** 6
**Generated:** 2026-08-20T00:35:00Z

## Summary

- Vocabulary mismatches: 1 finding (unresolved from round 1)
- Hidden assumptions: 2 findings
- Unresolved tensions: clean
- Convention violations: 1 finding
- Posture mismatches: clean
- Notes: 2 additional low-severity observations

## Vocabulary mismatches

- **V1** — README.md's own tagline frames MCP as a co-primary feature, directly tensioning with the "secondary integration surface" framing established everywhere else, including in the SAME document's own MCP section header.
  - Draft location: README.md line 4 — `> A local-first contact manager with an MCP server. Free & open source.`
  - Reference: README.md line 116 — `## MCP server (secondary integration surface)`; docs/ARCHITECTURE.md line 3 — `## This doc supersedes the old MCP-first framing`, which explicitly states "Earlier versions of this document (and of README.md) described rolodex as 'a Pantheon plugin / MCP tool' first... That framing is no longer accurate."
  - This appears to be the same finding a first grill pass (earlier this session) was explicitly asked to check for ("MCP server' framing vs. the standalone-app-first framing") and it is still present verbatim in the current tagline — unresolved across rounds, not new.
  - Question for planner: Is the tagline's "with an MCP server" phrasing an intentional, accepted marketing simplification (a tagline has to be short), or should it be reworded to lead with the standalone app (e.g. "A local-first contact manager you run yourself — with an MCP server for agent access")? If accepted as-is, worth an explicit note so a third grill round doesn't re-flag it.

## Hidden assumptions

- **H1** — docs/ARCHITECTURE.md's "What's actually built today" summary (the first substantive section after the framing note) still describes Google sync as one-way/pull-only, contradicting the same document's own later sections.
  - Draft location: docs/ARCHITECTURE.md line 30 — `A one-shot Google Contacts pull (src/lib/google-sync.ts)... that seeds the rolodex from the owner's Google Contacts, with local-only fields preserved across the merge.`
  - Why this matters: this predates the entire `google-two-way-sync` epic (real `push()`, etag-based conflict detection, `pushAllToGoogle()`, delete-propagation) which the SAME document's "Google sync" section (~line 279) and "Build-out status" Done list (~line 424) both correctly describe as real two-way sync. A reader who stops at the top summary — the most likely thing a skimming reader actually reads — gets a materially wrong picture of a shipped, real feature.
  - Question for planner: Update this bullet to describe real two-way sync (pull + push + conflict handling), matching the rest of the document.
- **H2** — Same section, adjacent bullet: MCP tool count is stated as 5, contradicting the same document's own later, correct count of 6.
  - Draft location: docs/ARCHITECTURE.md line 35 — `All 5 MCP tools (src/mcp/server.ts) wired to that same real Store/GoogleSync logic.`
  - Why this matters: `rolodex_delete` was added during the `google-two-way-sync` epic; the "Build-out status" Done list (~line 432, confirmed current) already correctly says "All 6 MCP tools." Same document, two different counts for the same fact.
  - Question for planner: Fix to 6, or generalize the wording (e.g. "every MCP tool") to avoid a number that needs updating each time a tool is added.
- **H3** (minor, folded in here rather than its own category) — docs/ARCHITECTURE.md still describes the Autostart toggle as living in a "Settings popover."
  - Draft location: docs/ARCHITECTURE.md line 171 — `A toggle in the Settings popover only renders when the route reports it's supported.`
  - Why this matters: the popover was fully retired in the `settings-account-screen` epic — Autostart is now a section on the real `#/settings` screen (confirmed: `wireSettingsPanel()` and its CSS were deleted in that epic's final story). A reader relying on this line for the actual current architecture would look for UI that no longer exists.
  - Question for planner: Update "Settings popover" → "Settings screen" (or "the Settings screen's Autostart section").

## Unresolved tensions

Clean — no findings. The local-first/no-login posture is stated consistently across both documents and not undercut by any claim found in this pass.

## Convention violations

- **C1** — README.md's new "Real loading/error feedback" bullet makes an absolute claim ("no silently-swallowed failures") that does not hold against the current code — an overclaim in the docs that mirrors exactly the kind of thing this project's own non-negotiable ("never fabricate, no silent guesses") warns against in the product's own behavior toward users.
  - Draft location: README.md lines 106-108 — `**Real loading/error feedback** — a shared toast for one-off events (sync/push results, delete failures, save confirmations), real loading states on every view, and no silently-swallowed failures.`
  - Convention: docs/ARCHITECTURE.md's "Data-integrity and security posture (non-negotiable)" section's "never fabricate, no silent guesses" principle — applied here to the docs' own claims about the product, not just the product's behavior.
  - Verified against the actual current code (`src/shell/index.html`) — six real remaining silent-failure spots (bare `console.error`, no `showToast`/visible message, same class of bug the `ui-feedback-states` epic's story 3 fixed three OTHER named instances of):
    1. Line ~1478 — Settings screen's Follow-up section load failure (falls back to default 30/14 silently)
    2. Line ~1539 — Settings screen's Appearance section load failure (falls back to defaults silently)
    3. Line ~1548 — Settings screen's Autostart section load failure (the whole section silently fails to render — indistinguishable from "not supported")
    4. Line ~1560 — Settings screen's Google-status load failure (falls back to "Not configured" silently, which could be actively misleading if the real status is "Signed in")
    5. Line ~1574 — Settings screen's Secrets-backend section load failure (whole section silently fails to render — indistinguishable from "Portunus unavailable")
    6. Line ~1603 — Contact detail view's interaction-history fetch failure
  - These are all *load* failures in code that mostly postdates the `ui-feedback-states` epic's own research pass (the Settings screen's internal sections were built in a separate, earlier epic) — story 3 fixed three specific, pre-identified *save*/count failures, not an exhaustive sweep of every fetch in the app. The gap is real, not a fabrication on grill's part, but README's claim is written as if the sweep were exhaustive.
  - Question for planner: Either (a) soften the README claim (e.g. "no silently-swallowed failures in the flows this covers" or just drop the absolute "no silently-swallowed failures" clause), or (b) treat this as a real follow-up story/epic (a natural "part 2" of `ui-feedback-states`, covering Settings' own section-load failures and the interaction-history fetch) before keeping the claim as-is.

## Posture mismatches

Clean — no findings. Nothing found that departs from the project's stated local-first/single-user/no-login/no-silent-guesses posture beyond the C1 finding above (which is a claim-accuracy issue, not a posture choice).

## Notes

- docs/ARCHITECTURE.md's "Owner note (Mathew)" section (bottom of file) only mentions "Sync now" (pull) as the way to get Google Contacts in, not Push — low-severity (informal personal note, not a claim to a third-party reader), but could be updated for completeness now that push is real.
- This grill pass did not have `.pHive/CONTEXT.md` or a research-brief's `inconsistency_risk_signals` to focus against (both absent in this repo) — the pass ran heuristically, cross-referencing README.md against docs/ARCHITECTURE.md and the actual current `src/` code directly, per this round's explicit instructions.

## Out of scope (this pass)

Grill does not propose solutions, score quality, gate work, or prioritize findings beyond the question attached to each one above. It does not fix docs/ARCHITECTURE.md or README.md itself — that's a separate, deliberate step after this record is reviewed.
