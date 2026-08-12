# Grill Record — followups-view

**Source draft:** .pHive/epics/followups-view/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** present
**round_number:** 1
**unresolved_count:** 3
**Generated:** 2026-08-11T22:30:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: clean
- Posture mismatches: not applicable

## Vocabulary mismatches

Clean — draft terminology (verdict, nextStep, interaction, needsFollowUp) matches CONTEXT.md and prior-epic usage throughout.

## Hidden assumptions

- **H1** — §3 step 1 says results should be ordered "most overdue first (oldest last-interaction, or no interaction at all, sorted to the top)" but doesn't specify how a never-touched contact (no interaction row at all) sorts relative to a contact touched, say, 29 days ago (just under the 30-day window it wouldn't even qualify, but consider a contact touched 31 days ago vs. never touched — which is "more overdue"?). This is an implementation-relevant assumption (NULL/no-interaction as the sentinel "oldest possible" value) left implicit.
  - Draft location: §3, step 1
  - Why this matters: the SQL query's `ORDER BY` needs a concrete answer to write correctly; left implicit, an implementer could reasonably pick either ordering.
  - Question for planner: should never-touched contacts always sort above (more urgent than) any contact with a real last-interaction date, regardless of how old that date is?

- **H2** — §3 step 3 justifies the filter-toggle approach partly as avoiding being "the app's first precedent for a whole new nav pattern," but a filter toggle is itself new, unprecedented UI on the list view (the only existing control there is the search box — a text input, not a toggle/filter control). The claim slightly overstates how "precedent-free" this choice actually is.
  - Draft location: §3, step 3
  - Why this matters: doesn't change the decision, but the stated rationale is a little stronger than what's actually true — worth being precise about what's genuinely being avoided (a second route/nav-level surface) vs. what isn't (a new UI control type).
  - Question for planner: reword the rationale to claim only what's true (avoids a second-level route, not "no new UI pattern at all"), or is the current phrasing acceptable as shorthand?

## Unresolved tensions

- **U1** — §3 step 1 makes an explicit decision resolving the research brief's open question #2 (zero-interaction contacts count as needing follow-up: "yes, they count"), but §6 open question #1 (freshly-added-contact noise) re-raises what is substantially the same underlying tension — a brand-new contact with a next step and zero interactions — without acknowledging it's connected to the decision already made two sections earlier. As written, a reader could reasonably wonder whether the §3 decision is actually settled or still up for grabs given §6 reopens adjacent territory.
  - Draft location: §3 step 1 (decision) vs. §6 Q1 (reopened concern)
  - Tension: has the "zero-interaction / newly-added" case been decided (§3) or is it still open (§6)?
  - Question for planner: either merge these into one open question (the §3 decision stands, but the *noise* question — should there be a minimum-age grace period — is the genuinely separate, still-open piece), or explicitly state why both a decision and a related open question coexist.

## Convention violations

Clean — no violations of CONTEXT.md conventions or `docs/ARCHITECTURE.md`'s stated posture found.

## Posture mismatches

Not applicable — no composable-substrate/atomic-skill posture is established for the rolodex project itself.

## Notes

Small, well-grounded draft overall — every claim traces to a real file or the research brief. The three findings above are about precision (an implicit sort-order assumption, an overstated precedent-avoidance claim, and two sections that talk past each other on the same underlying question) rather than disagreement with the proposed approach.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize findings. Each finding ends with a question for the planner; the planner's job is to revise the draft (or document accepted deviations) before stories are written.
