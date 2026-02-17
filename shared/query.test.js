import { describe, it, expect, vi } from "vitest";
import { buildWhereClause, buildSetClause, safeJsonParse } from "./query.js";

describe("buildWhereClause", () => {
  it("returns empty sql and params for empty input", () => {
    const result = buildWhereClause([]);
    expect(result).toEqual({ sql: "", params: [] });
  });

  it("returns empty sql and params for null/undefined", () => {
    expect(buildWhereClause(null)).toEqual({ sql: "", params: [] });
    expect(buildWhereClause(undefined)).toEqual({ sql: "", params: [] });
  });

  it("builds single filter with default op", () => {
    const result = buildWhereClause([{ column: "status", value: "active" }]);
    expect(result.sql).toBe("status = ?");
    expect(result.params).toEqual(["active"]);
  });

  it("builds multiple filters with AND", () => {
    const result = buildWhereClause([
      { column: "status", value: "active" },
      { column: "priority", value: 1 },
    ]);
    expect(result.sql).toBe("status = ? AND priority = ?");
    expect(result.params).toEqual(["active", 1]);
  });

  it("supports custom op like LIKE", () => {
    const result = buildWhereClause([
      { column: "content", value: "%foo%", op: "LIKE" },
    ]);
    expect(result.sql).toBe("content LIKE ?");
    expect(result.params).toEqual(["%foo%"]);
  });

  it("preserves param order matching column order", () => {
    const result = buildWhereClause([
      { column: "a", value: 1 },
      { column: "b", value: 2, op: ">=" },
      { column: "c", value: 3 },
    ]);
    expect(result.sql).toBe("a = ? AND b >= ? AND c = ?");
    expect(result.params).toEqual([1, 2, 3]);
  });

  it("passes when column is in allowedColumns", () => {
    const allowed = new Set(["status", "priority"]);
    const result = buildWhereClause(
      [{ column: "status", value: "active" }],
      { allowedColumns: allowed }
    );
    expect(result.sql).toBe("status = ?");
  });

  it("throws when column is not in allowedColumns", () => {
    const allowed = new Set(["status"]);
    expect(() =>
      buildWhereClause([{ column: "malicious", value: "x" }], { allowedColumns: allowed })
    ).toThrow("Invalid column: malicious");
  });

  it("skips validation when allowedColumns is not provided", () => {
    const result = buildWhereClause([{ column: "anything", value: 1 }]);
    expect(result.sql).toBe("anything = ?");
  });
});

describe("buildSetClause", () => {
  it("returns empty sql and params for empty object", () => {
    const result = buildSetClause({});
    expect(result).toEqual({ sql: "", params: [] });
  });

  it("returns empty sql and params for null/undefined", () => {
    expect(buildSetClause(null)).toEqual({ sql: "", params: [] });
    expect(buildSetClause(undefined)).toEqual({ sql: "", params: [] });
  });

  it("builds single column set", () => {
    const result = buildSetClause({ status: "done" });
    expect(result.sql).toBe("status = ?");
    expect(result.params).toEqual(["done"]);
  });

  it("builds multiple columns with comma separation", () => {
    const result = buildSetClause({ status: "done", updated_at: "2026-02-14" });
    expect(result.sql).toBe("status = ?, updated_at = ?");
    expect(result.params).toEqual(["done", "2026-02-14"]);
  });

  it("preserves insertion order of keys", () => {
    const result = buildSetClause({ z: 3, a: 1, m: 2 });
    expect(result.params).toEqual([3, 1, 2]);
  });

  it("passes when column is in allowedColumns", () => {
    const allowed = new Set(["status", "updated_at"]);
    const result = buildSetClause({ status: "done" }, { allowedColumns: allowed });
    expect(result.sql).toBe("status = ?");
  });

  it("throws when column is not in allowedColumns", () => {
    const allowed = new Set(["status"]);
    expect(() =>
      buildSetClause({ injected: "DROP TABLE" }, { allowedColumns: allowed })
    ).toThrow("Invalid column: injected");
  });

  it("skips validation when allowedColumns is not provided", () => {
    const result = buildSetClause({ anything: 1 });
    expect(result.sql).toBe("anything = ?");
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}', {}, "test")).toEqual({ a: 1 });
    expect(safeJsonParse("[1,2,3]", [], "test")).toEqual([1, 2, 3]);
  });

  it("returns defaultValue for invalid JSON and logs warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = safeJsonParse("{bad json", [], "test-ctx");
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[warn] test-ctx"));
    spy.mockRestore();
  });

  it("returns defaultValue for null/undefined input without logging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(safeJsonParse(null, [], "test")).toEqual([]);
    expect(safeJsonParse(undefined, {}, "test")).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns defaultValue for non-string input without logging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(safeJsonParse(42, [], "test")).toEqual([]);
    expect(safeJsonParse(true, "default", "test")).toBe("default");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns defaultValue on type mismatch when expecting array", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = safeJsonParse('"just a string"', [], "test-ctx");
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("expected array"));
    spy.mockRestore();
  });

  it("allows non-array when defaultValue is not array", () => {
    const result = safeJsonParse('"hello"', "", "test");
    expect(result).toBe("hello");
  });

  it("truncates long invalid JSON in warning message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const longStr = "x".repeat(200);
    safeJsonParse(longStr, [], "test");
    const msg = spy.mock.calls[0][0];
    expect(msg.length).toBeLessThan(200);
    spy.mockRestore();
  });
});
