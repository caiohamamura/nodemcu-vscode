export interface CompileProblem {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "note";
  message: string;
  source: string;
}

const GCC_DIAG = /^(?:\s*)?(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+?)$/;
const MSVC_DIAG = /^(.+?)\((\d+)\):\s*(fatal error|error|warning)\s+([A-Z0-9]+):\s*(.+)$/;
const CMAKE_ERROR = /^CMake Error(?:\s+at\s+(.+?))?:\s*(.+)$/;

export function parseProblems(output: string): CompileProblem[] {
  const problems: CompileProblem[] = [];
  for (const line of output.split(/\r?\n/)) {
    let m = GCC_DIAG.exec(line);
    if (m) {
      problems.push({
        file: m[1].trim(),
        line: Number(m[2]),
        column: m[3] ? Number(m[3]) : 0,
        severity: m[4] as "error" | "warning" | "note",
        message: m[5].trim(),
        source: "gcc",
      });
      continue;
    }
    m = MSVC_DIAG.exec(line);
    if (m) {
      const isError = m[3].includes("error");
      problems.push({
        file: m[1].trim(),
        line: Number(m[2]),
        column: 0,
        severity: isError ? "error" : "warning",
        message: `[${m[4]}] ${m[5].trim()}`,
        source: "msvc",
      });
      continue;
    }
    m = CMAKE_ERROR.exec(line);
    if (m) {
      problems.push({
        file: (m[1] ?? "CMakeLists.txt").trim(),
        line: 0,
        column: 0,
        severity: "error",
        message: m[2].trim(),
        source: "cmake",
      });
    }
  }
  return problems;
}

export function summarize(problems: CompileProblem[]): string {
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;
  return `${errors} error(s), ${warnings} warning(s)`;
}

export function extractModuleBuildSummary(output: string): Map<string, "built" | "skipped" | "failed"> {
  const result = new Map<string, "built" | "skipped" | "failed">();
  const reBuilt = /Selected optional module:\s*(\S+)/g;
  const reFailed = /Cannot find source file\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = reBuilt.exec(output)) !== null) {
    result.set(m[1].toLowerCase().replace(/\.c$/, ""), "built");
  }
  while ((m = reFailed.exec(output)) !== null) {
    result.set(m[1].toLowerCase().replace(/\.c$/, ""), "failed");
  }
  return result;
}
