## Behavioral Guidelines

Guidelines to reduce common LLM coding mistakes. Merge with project-specific
instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

5. **Goal-Conflict Disclosure (mandatory)**

When an instruction conflicts with, undermines, or constrains the stated
goal, say so immediately — before acting — and propose an alternative.
Never silently comply with an instruction whose side effects work against
the objective. A follow-up order does not authorize related decisions:
each consequential choice comes back to the owner as a question, not as
an applied default.

6. **No Assumed Approvals for Merges**

Do not merge pull requests into any branch based on assumed approval.

7. **PLANS.md Is a Team Deliverable**

PLANS.md is submitted to the team as written. Record verification evidence,
execution summaries, and work logs in the commit message — keep PLANS.md
itself to the plan document.

## Mobile UI verification

- Default mobile UI end-to-end verification to the iPhone simulator. One iOS
  simulator run is sufficient; do not repeat the same journey on Android or a
  second device unless the user explicitly requests that additional coverage.
  If the iPhone simulator is unavailable, report the blocker before choosing a
  different platform.
- Prefer stable widget keys or accessibility identifiers and semantic labels for
  targeting controls. Inspect the current UI hierarchy before interacting; do
  not guess coordinates or reuse bounds from an earlier layout.
- If coordinate input is unavoidable, derive the target from the current UI
  hierarchy or screenshot. Re-inspect after scrolling, navigation, keyboard
  changes, or dialogs before the next interaction.
- Before typing, verify that the intended field has focus. Replace its contents
  using the available field-editing API, then verify the resulting value before
  submitting. Do not blindly send repeated delete keys to an unverified field.
- Wait for an observable screen or request outcome with a bounded timeout rather
  than relying on fixed sleeps. After a missed interaction, inspect focus,
  keyboard visibility, overlays, and the foreground app before retrying. If the
  next attempt also misses, change the targeting method instead of continuing
  coordinate trial and error.
- Distinguish automation/navigation mistakes from application failures using
  screenshots, device logs, and API evidence before changing product code.
  Simulator checks do not establish physical-device haptic behavior.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
