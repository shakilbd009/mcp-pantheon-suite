# Design: Fix Unsafe JSON Parsing — Fail Loudly on Corruption

## Overview
Fix all JSON.parse call sites across 3 MCP servers in mcp-pantheon-suite. Replace silent empty-catch blocks with descriptive error responses, and wrap unprotected JSON.parse calls to prevent crashes. Goal: make corruption visible, not silent.

## Architecture

### Call Site Inventory (verified against codebase)

**Taskboard (servers/taskboard/handlers.js):**
1. **Line 324** — `JSON.parse(task.criteria || "[]")` with empty catch → silent `[]` default. **Fix: isError response naming task ID + field.**
2. **Line 341** — `JSON.parse(r.categories)` in review display — no try-catch but inside outer catch block. **Fix: wrap with safeJsonParse, default `[]`.**
3. **Line 806** — `JSON.parse(i.participating_agents || "[]")` in listInitiatives with empty catch → silent `[]`. **Fix: log warning, keep default (non-critical display field).**
4. **Line 825** — `JSON.parse(initiative.participating_agents || "[]")` in getInitiative with empty catch. **Fix: log warning, keep default.**
5. **Line 826** — `JSON.parse(initiative.success_criteria || "[]")` in getInitiative with empty catch. **Fix: isError response (criteria is core data).**

**Memory (servers/memory/handlers.js):**
6. **Line 101** — `JSON.parse(r.tags)` in recall results map — **no try-catch, will crash.** Fix: wrap, substitute `["CORRUPTED"]`, append warning line.
7. **Line 132** — `JSON.parse(r.tags)` in listMemories results map — **no try-catch, will crash.** Fix: same treatment.

**Planner (servers/planner/handlers.js):**
8. **Line 107** — `JSON.parse(plan.steps)` in updateStep — **no try-catch, will crash.** Fix: isError response naming plan ID.
9. **Line 157** — `JSON.parse(plan.steps)` in getPlan — **no try-catch, will crash.** Fix: isError response.
10. **Line 240** — `JSON.parse(plan.steps)` in abandonPlan — **no try-catch, will crash.** Fix: isError response, but still allow abandon to proceed.

### Error Strategy (Context-Dependent)

Not all JSON.parse failures deserve the same response:

| Site | Field | Strategy | Rationale |
|------|-------|----------|-----------|
| Taskboard criteria (324) | criteria | `isError: true` | Core data for task management |
| Taskboard categories (341) | categories | Default `[]` + console.warn | Display-only, non-blocking |
| Taskboard agents (806, 825) | participating_agents | Default `[]` + console.warn | Display-only, listed alongside other data |
| Taskboard criteria (826) | success_criteria | `isError: true` | Core initiative data |
| Memory tags (101, 132) | tags | `["CORRUPTED"]` + warning in response | Don't lose the whole memory, but flag the issue |
| Planner steps (107, 157) | steps | `isError: true` | Plan is unusable without valid steps |
| Planner steps (240) | steps | Attempt parse → if fail, still abandon | Plan is being discarded anyway |

### Implementation Pattern

Use a local `safeJsonParse` utility (or inline try-catch where the error response is custom):

```javascript
function safeJsonParse(str, defaultValue, context) {
  try {
    const result = JSON.parse(str);
    if (defaultValue !== undefined && Array.isArray(defaultValue) && !Array.isArray(result)) {
      console.error(`[warn] ${context}: expected array, got ${typeof result}`);
      return defaultValue;
    }
    return result;
  } catch (err) {
    console.error(`[warn] ${context}: JSON parse failed: ${err.message}`);
    return defaultValue;
  }
}
```

For `isError` sites, use explicit try-catch with custom error messages rather than the utility.

## Technical Decisions

### DECISION: safeJsonParse utility vs inline try-catch everywhere
**Chosen:** Use `safeJsonParse` for display-only fields (agents, categories, tags in list views). Use explicit try-catch with `isError: true` return for critical data fields (criteria, steps).

**Rationale:** The utility simplifies the common case (parse with fallback + warning). But for critical fields where the handler must abort, the explicit try-catch with a custom `isError` return is clearer than a callback or sentinel value.

**Rejected:** Single unified approach — either all utility (loses context-specific error responses) or all inline (duplicates the warning+default pattern 5 times).

### DECISION: Type validation (Array check)
**Chosen:** For fields expected to be arrays, validate that `JSON.parse` returns an array. Non-array results treated as corruption.

**Rationale:** `JSON.parse('"hello"')` returns a string. If a field is supposed to be an array but parses as a string/number, that's data corruption and should be flagged.

### DECISION: Where does safeJsonParse live?
**Chosen:** Define locally in each handler file that needs it (taskboard/handlers.js and memory/handlers.js). Not in shared/ — that's a separate task (e249b3da).

**Rationale:** The shared query helpers task (e249b3da) will create `shared/query.js` with a `safeJsonParse`. But that task depends on this one (you need the correct error behavior first, then extract). If we put it in shared/ now, e249b3da becomes partially done.

**Alternative approach:** If e249b3da is completed first, this task uses the shared utility. Order flexibility is fine — the spec doesn't mandate either order.

## Considered Alternatives

**Alternative 1: Throw and let outer catch handle it.** Rejected — the outer catch produces generic "Error: ..." messages without the specific field/record context needed for debugging.

**Alternative 2: Auto-repair corrupted data in the DB.** Rejected — out of scope per spec. We make corruption visible, not auto-repaired. Repair is a human decision.

**Alternative 3: Ignore type validation.** Rejected — `JSON.parse('"hello"')` succeeding silently when we expect an array would cause `array.map is not a function` errors downstream, which are harder to debug than a clear corruption message.

## Implementation Plan

### Task 1 (P1): Fix taskboard JSON.parse sites (5 locations)
- Line 324: Replace empty catch with isError response: `"Data corruption: task ${task.id} has invalid JSON in criteria field"`
- Line 341: Wrap `JSON.parse(r.categories)` with try-catch, default `[]`, console.warn
- Line 806: Replace empty catch with console.warn, keep `[]` default
- Line 825: Replace empty catch with console.warn, keep `[]` default
- Line 826: Replace empty catch with isError response for success_criteria

For all array fields, add type check: `if (!Array.isArray(parsed)) { /* treat as corruption */ }`

### Task 2 (P2): Fix memory JSON.parse sites (2 locations)
- Line 101 (recall): Wrap `JSON.parse(r.tags)` in try-catch. On failure: set tags to `["CORRUPTED"]`, append warning line to response text
- Line 132 (listMemories): Same treatment
- Add array type validation for both

### Task 3 (P3): Fix planner JSON.parse sites (3 locations)
- Line 107 (updateStep): Wrap in try-catch, return `isError: true` with `"Data corruption: plan ${plan.id} has invalid JSON in steps field. Plan cannot be updated."`
- Line 157 (getPlan): Same pattern
- Line 240 (abandonPlan): Wrap in try-catch. On failure: still set status to 'abandoned' (skip the steps append), return success with warning: `"Plan abandoned. Warning: steps data was corrupted — abandonment note could not be appended."`

## Dependencies
None — pure code changes within existing handler files.

## Risks
1. **Surfacing existing corruption** — This fix may reveal corruption that's been silently hidden. That's intentional — better to know than to lose data silently.
2. **Breaking agents that expect consistent response format** — `isError: true` responses change behavior for corrupted data only. Agents should already handle `isError` responses gracefully.
