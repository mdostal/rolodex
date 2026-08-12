# Grill Record — mcp-tool-bodies

**Source draft:** .pHive/epics/mcp-tool-bodies/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** present
**round_number:** 1
**unresolved_count:** 2
**Generated:** 2026-08-12T01:00:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: clean
- Convention violations: clean
- Posture mismatches: not applicable

## Vocabulary mismatches

Clean — terminology matches CONTEXT.md and prior-epic usage throughout.

## Hidden assumptions

- **H1** — §3 step 5 assumes `applyPullToStore`/`mergeLocalOnlyFields` (from `google-sync.ts`, currently consumed internally by the shell's sync route) can simply be "imported/reused," calling this "not a redesign, a visibility change." The research brief itself flagged this as needing confirmation during implementation, but the design discussion states it as settled without actually checking whether these functions are exported.
  - Draft location: §3 step 5, §5
  - Why this matters: if they're not currently exported, this is still a small, low-risk change — but the draft should say "confirm and export if needed" rather than implying it's already known to just work.
  - Question for planner: soften the language to explicitly flag this as a to-confirm-during-implementation item, or actually check now?

- **H2** — §4 identifies "none of the 5 handlers has a try/catch" as a Medium risk needing "explicit handling, not just reuse the store methods and hope," but §3 (the actual proposed approach) never specifies a concrete error-handling mechanism — what should an MCP tool handler return on a thrown error? Does the `@modelcontextprotocol/sdk` have a standard error-response shape (e.g., an `isError` field), or does this need custom handling?
  - Draft location: §3 (silent on this), §4 (names the risk but doesn't resolve it)
  - Why this matters: a risk that's named but not resolved in the approach section is exactly the kind of gap that turns into an implementation-time surprise or an inconsistent per-tool answer.
  - Question for planner: research the MCP SDK's actual error-response contract and state the concrete pattern in §3, not just flag it as a risk in §4.

## Unresolved tensions

Clean — both of the draft's own open questions were resolved within the same document, no leftover tension found.

## Convention violations

Clean.

## Posture mismatches

Not applicable.

## Notes

Small, well-grounded draft — every claim about existing Store/GoogleSync methods traces to real, already-implemented code from prior epics. Both findings are about tightening things the draft already gestures at (an assumption to verify, a risk to actually resolve) rather than disagreement with the approach.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize findings. Each finding ends with a question for the planner; the planner's job is to revise the draft (or document accepted deviations) before stories are written.
