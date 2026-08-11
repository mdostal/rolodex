# Grill Record — standalone-app-foundation

**Source draft:** .pHive/epics/standalone-app-foundation/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** present
**round_number:** 1
**unresolved_count:** 5
**Generated:** 2026-08-11T00:00:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: 2 findings
- Posture mismatches: not applicable

## Vocabulary mismatches

Clean — draft terminology (Contact, Interaction, verdict, angle, nextStep, core/your-layer, Pantheon) matches CONTEXT.md definitions throughout, and the draft is careful to state "there is no UI of any kind" rather than conflating the profile's forward-looking `has_ui: true` classification with current state.

## Hidden assumptions

- **H1** — §3 claims "'0 contacts' is a real working state because it proves the UI is reading the actual SQLite store" — this assumes a way to list/count all contacts. `Store` (per research brief) exposes `get(id)`, `search(query)`, `upsert`, `needsFollowUp`, `setVerdict`, `setNextStep`, `logInteraction` — there is no list-all / count method anywhere in the current interface or anywhere in the draft's proposed changes.
  - Draft location: §3 "My Proposed Approach", step 1
  - Why this matters: the first vertical slice's "working state" claim depends on a `Store` method that doesn't exist and isn't mentioned in the file-manifest-level thinking anywhere else in the draft.
  - Question for planner: does the initial `Store` scope (§4/§6 Q5's "narrower scope") explicitly include a new list/count method, or is "0 contacts" the wrong first-slice proof and something else should anchor slice 1?

- **H2** — §3/§6 Q2 propose login as either "local PIN/password" or "the Google OAuth grant doubling as the gate," but nothing in the draft grounds how a session would be persisted or checked on subsequent app launches — there is no session/user table anywhere in the current schema (`contacts`, `interactions`, `contacts_fts` per the research brief), and the draft doesn't propose adding one.
  - Draft location: §3 step 3, §6 Q2
  - Why this matters: "login" is flagged in the research brief as 100% new surface; without a grounded session-persistence answer, the H/V slicing that follows this document could under-scope the login layer.
  - Question for planner: should this design decide (or explicitly defer as a follow-on open question) where session state lives — a new SQLite table via `Store`, an OS keychain/credential-store entry, or something else?

## Unresolved tensions

- **U1** — §5 states "this epic adds a second surface (UI) with zero automated guardrails unless we also stand up at least a lint/typecheck CI step alongside it" but never resolves whether standing up CI is actually in scope for this epic. §8's Scale Assessment file/subsystem list also does not mention CI/lint setup.
  - Draft location: §5 "Dependencies and Constraints", last bullet; §8 file list
  - Tension: the draft flags the guardrail gap as a real risk but leaves the decision of whether to close it inside this epic or defer it entirely unmade.
  - Question for planner: is minimal CI/lint setup in scope for this foundation epic, or an explicit fast-follow (and if deferred, should that be logged as an open question rather than a passive dependency-list caveat)?

## Convention violations

- **C1** — `docs/ARCHITECTURE.md`'s existing build-out roadmap explicitly ranks a UI as "Optional: a tiny read-only web/board view" — last on the list. The draft's proposed sequencing (§1, §3) inverts that ordering (UI-and-wizard-first, store/MCP implementation as enabling work underneath) but never states that this epic explicitly **supersedes** the existing roadmap ordering in `docs/ARCHITECTURE.md`. §4 acknowledges the docs "need rewriting" but frames it as a documentation-sync risk, not as an explicit decision to supersede the prior plan.
  - Draft location: §2 (roadmap conflict noted), §4 Medium risk bullet
  - Convention: `docs/ARCHITECTURE.md` → "Build-out roadmap" (checklist, UI listed last/optional)
  - Question for planner: should the design discussion state outright "this epic supersedes the existing build-out roadmap's ordering" (and have the doc-rewrite story make that explicit), rather than only listing the doc mismatch as a risk to manage?

- **C2** — CONTEXT.md's convention "No silent guesses: an agent leaves a field blank rather than inventing org/angle/verdict" is in tension with the deferred enrichment-on-add capability described in §6 Q4 ("auto-populate org/role/what-they-do/niche" from a public lookup). The draft correctly defers the feature, but doesn't flag that whoever designs it later must explicitly reconcile automated field-filling with this no-silent-guess convention.
  - Draft location: §6 Q4
  - Convention: `.pHive/CONTEXT.md` → Conventions → "No silent guesses"
  - Question for planner: should Q4's deferral note explicitly carry this convention-reconciliation requirement forward for whichever future epic picks it up, so it isn't lost between now and then?

## Posture mismatches

Not applicable — CONTEXT.md does not establish a composable-substrate/atomic-skill posture for the rolodex project itself (that posture belongs to plugin-hive, not the target codebase).

## Notes

The draft is well-grounded overall — every claim in §2-§5 cites a real file or a research-brief finding, and the biggest genuine risk (desktop shell choice) is already correctly surfaced as the epic's top open question rather than hidden. The findings above are gaps in what's *already been made explicit* (an unlisted required `Store` method, an ungrounded session model, an undecided CI-scope question, and an unstated roadmap-supersession + convention-carry-forward), not disagreements with the draft's overall direction.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize findings. Each finding ends with a question for the planner; the planner's job is to revise the draft (or document accepted deviations) before stories are written.
