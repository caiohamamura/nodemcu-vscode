import { describe, it, expect } from "vitest";
import { parseProblems, summarize, extractModuleBuildSummary } from "../../src/build/outputParser";

describe("parseProblems", () => {
  it("parses gcc-style diagnostics", () => {
    const output = `
/home/user/app/main.c:42:15: error: 'foo' undeclared
/home/user/app/main.c:43:1: warning: implicit declaration
    `;
    const problems = parseProblems(output);
    expect(problems).toHaveLength(2);
    expect(problems[0].file).toBe("/home/user/app/main.c");
    expect(problems[0].line).toBe(42);
    expect(problems[0].column).toBe(15);
    expect(problems[0].severity).toBe("error");
    expect(problems[0].message).toBe("'foo' undeclared");
    expect(problems[1].severity).toBe("warning");
  });

  it("parses CMake errors", () => {
    const output = `CMake Error at CMakeLists.txt:5 (message):\n  Missing required variable`;
    const problems = parseProblems(output);
    expect(problems).toHaveLength(1);
    expect(problems[0].source).toBe("cmake");
    expect(problems[0].severity).toBe("error");
  });

  it("returns empty array for clean output", () => {
    const problems = parseProblems("Built target app.elf\n[100%] Built");
    expect(problems).toEqual([]);
  });

  it("ignores non-diagnostic lines", () => {
    const output = `[ 50%] Building C object app/CMakeFiles/app.dir/main.c.obj\n[100%] Linking`;
    const problems = parseProblems(output);
    expect(problems).toEqual([]);
  });
});

describe("summarize", () => {
  it("counts errors and warnings", () => {
    const problems = parseProblems(`
a.c:1:1: error: e1
a.c:2:1: error: e2
a.c:3:1: warning: w1
`);
    expect(summarize(problems)).toBe("2 error(s), 1 warning(s)");
  });
});

describe("extractModuleBuildSummary", () => {
  it("extracts selected optional modules", () => {
    const output = `
-- Selected optional module: coap
-- Selected optional module: websocket
-- Cannot find source file foo.c
`;
    const summary = extractModuleBuildSummary(output);
    expect(summary.get("coap")).toBe("built");
    expect(summary.get("websocket")).toBe("built");
    expect(summary.get("foo")).toBe("failed");
  });
});
