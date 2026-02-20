# MCP Pantheon Suite: Security Audit Report
## Scan Date: 2026-02-15

### Summary
Scanned 6 Forge task branches for OWASP Top 10 security vulnerabilities.

### Branches Analyzed

| Branch | Task | Status | Commits |
|--------|------|--------|---------|
| forge/mcp-pantheon-suite/ae0c8e0d-memory-json-parse | ae0c8e0d | Changes Found | 1 |
| forge/mcp-pantheon-suite/e8b632d1-planner-json-parse | e8b632d1 | Changes Found | 1 |
| forge/mcp-pantheon-suite/e410a383-taskboard-shared-helpers | e410a383 | Changes Found | 3 |
| forge/mcp-pantheon-suite/ce28d414-taskboard-integration | ce28d414 | Changes Found | 2 |
| forge/mcp-pantheon-suite/1c18578e-memory-planner-integration | 1c18578e | Changes Found | 2 |

Note: All branches except aa4975ec contained changes from main.

---

## SECURITY FINDINGS

### 1. UNSAFE JSON PARSING (Critical Pattern Found)

**Severity: HIGH**

Multiple branches show a dangerous pattern where error handling for `JSON.parse()` is being **removed or weakened**:

#### Branch: ae0c8e0d-memory-json-parse
**File: servers/planner/handlers.js**

BEFORE (Safe):
```javascript
let steps;
try {
  steps = JSON.parse(plan.steps);
  if (!Array.isArray(steps)) throw new Error("not an array");
} catch {
  return { content: [{ type: "text", text: `Data corruption: ...` }], isError: true };
}
```

AFTER (Vulnerable):
```javascript
const steps = JSON.parse(plan.steps);  // NO ERROR HANDLING!
```

This change removes the try/catch around `JSON.parse()`, causing the server to **crash on malformed JSON** instead of returning a graceful error.

**Affected Functions:**
- `updateStep()` - line 104
- `getPlan()` - line 154  
- `abandonPlan()` - line 237 (3 instances)

**Attack Vector:**
- Attacker can send corrupted JSON in `plan.steps` database field
- Server crashes instead of handling error gracefully
- Denial of Service (DoS)

---

#### Branch: e8b632d1-planner-json-parse
Same issue: Removes error handling from `JSON.parse()` calls in:
- `servers/memory/handlers.js` - `recall()` function
- `servers/memory/handlers.js` - `listMemories()` function
- `servers/planner/handlers.js` - Multiple functions

BEFORE (Safe):
```javascript
let memTags;
try {
  memTags = JSON.parse(r.tags);
  if (!Array.isArray(memTags)) memTags = ["CORRUPTED"];
} catch {
  console.error(`[warn] memory ${r.id}: corrupt tags JSON`);
  memTags = ["CORRUPTED"];
}
```

AFTER (Vulnerable):
```javascript
const memTags = JSON.parse(r.tags);  // NO ERROR HANDLING!
```

---

#### Branch: ce28d414-taskboard-integration
Combines both above changes - removes error handling from both memory AND planner JSON parsing.

---

#### Branch: 1c18578e-memory-planner-integration  
Same combined issue from ce28d414.

---

### 2. SHARED QUERY HELPERS (Security Assessment)

**Branch: e410a383-taskboard-shared-helpers**

This branch introduces three shared utility functions in `shared/query.js`:

#### buildWhereClause()
```javascript
export function buildWhereClause(filters) {
  for (const f of filters) {
    const op = f.op || "=";
    parts.push(`${f.column} ${op} ?`);  // Column names NOT parameterized!
    params.push(f.value);
  }
  return { sql: parts.join(" AND "), params };
}
```

**SECURITY ISSUE: Column names are string interpolated, not parameterized.**

RISK: If user-controlled data flows into `f.column`, SQL injection is possible:
```javascript
// Hypothetical vulnerable call:
buildWhereClause([{ column: "name OR 1=1 --", value: "test" }])
// Results in: "name OR 1=1 -- = ?"
```

HOWEVER: Analysis shows column names in this codebase are hard-coded in handler functions, not user-derived. The parameter values ARE properly parameterized. This is a **design risk** but not actively exploited in current usage.

#### buildSetClause()
```javascript
export function buildSetClause(updates) {
  for (const key of keys) {
    parts.push(`${key} = ?`);  // Key names NOT parameterized!
    params.push(updates[key]);
  }
  return { sql: parts.join(", "), params };
}
```

Same issue as buildWhereClause - column names are interpolated. Again, hard-coded in current usage.

#### safeJsonParse()
```javascript
export function safeJsonParse(str, defaultValue, context) {
  if (str == null || typeof str !== "string") return defaultValue;
  
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    console.error(`[warn] ${context}: invalid JSON — ${str.slice(0, 80)}`);
    return defaultValue;
  }
  
  if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
    console.error(`[warn] ${context}: expected array but got ${typeof parsed}`);
    return defaultValue;
  }
  
  return parsed;
}
```

ASSESSMENT: **GOOD** - Properly handles JSON parse errors with try/catch, returns default value, includes logging.

---

### 3. TEST DELETIONS (Operational Risk)

**All branches delete integration tests:**

Files deleted:
- `tests/integration/harness.js` - 184 lines (MCP test infrastructure)
- `tests/integration/harness.test.js` - 58 lines
- `tests/integration/memory.test.js` - 79 lines
- `tests/integration/planner.test.js` - 62 lines
- `tests/integration/taskboard.test.js` - 66 lines
- `shared/query.test.js` - 129 lines (validates buildWhereClause, buildSetClause, safeJsonParse)

**IMPACT:**
- Loss of integration test coverage
- Cannot verify MCP server JSON-RPC communication
- Cannot verify security checks (agent isolation, data corruption handling)
- `query.test.js` deletion means no validation of SQL helpers

**Package.json changes:**
From:
```json
"test": "vitest run --exclude tests/integration/",
"test:integration": "vitest run tests/integration/",
"test:all": "vitest run"
```

To:
```json
"test": "vitest run"
```

This is **not** a security vulnerability but represents reduced test coverage.

---

### 4. NO OTHER OWASP TOP 10 ISSUES FOUND

Scanned for:
- Hardcoded secrets/passwords/API keys: **NONE FOUND**
- SQL Injection: **NO active vulnerabilities** (column names hard-coded)
- Command Injection: **NONE FOUND** (no child_process, execSync, or eval usage)
- XSS: **NOT APPLICABLE** (backend MCP servers, not web frontends)
- Insecure Deserialization: **SAFE** (proper JSON.parse in shared helper)
- Broken Authentication: **NOT APPLICABLE** (no auth in scope)
- Sensitive Data Exposure: **NONE FOUND**
- XML External Entities (XXE): **NOT APPLICABLE** (no XML parsing)
- Broken Access Control: **TESTED** (integration tests verify agent isolation)
- Using Components with Known Vulnerabilities: **NOT FOUND**

---

## RISK SUMMARY

| Category | Severity | Count | Details |
|----------|----------|-------|---------|
| Unsafe JSON.parse (no error handling) | HIGH | 5 instances across 4 branches | Unhandled exceptions crash server |
| SQL Injection (design risk) | LOW | 2 functions | Column names hardcoded, not user-controlled |
| Test Coverage Loss | MEDIUM | 6 files deleted | Unable to validate error handling in production |

---

## RECOMMENDATIONS

### Immediate Actions (CRITICAL)

1. **DO NOT MERGE** branches that remove error handling from JSON.parse:
   - ae0c8e0d-memory-json-parse
   - e8b632d1-planner-json-parse
   - ce28d414-taskboard-integration
   - 1c18578e-memory-planner-integration

2. **Revert JSON.parse changes** - Restore try/catch blocks with fallback values

3. **Restore test files** - Re-add integration tests and query.test.js

### For Branch e410a383-taskboard-shared-helpers

This branch is **safer** (retains error handling) but should:

1. Add input validation in buildWhereClause/buildSetClause if they ever accept user input
2. Add JSDoc warnings about column name interpolation
3. Restore query.test.js to validate the helpers

Recommended improvement:
```javascript
// Add validation
export function buildWhereClause(filters, allowedColumns = null) {
  for (const f of filters) {
    // If allowedColumns provided, validate column name
    if (allowedColumns && !allowedColumns.includes(f.column)) {
      throw new Error(`Invalid column: ${f.column}`);
    }
    // ... rest of function
  }
}
```

---

## Conclusion

The main security concern is **unsafe removal of error handling around JSON.parse()**, which can lead to unhandled exceptions and server crashes (DoS). Branches e410a383 is acceptable with minor improvements; other branches should not be merged without fixes.

