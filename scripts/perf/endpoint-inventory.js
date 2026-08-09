// T045 — mechanical route inventory + heuristic endpoint-class assignment.
// Deep code-reading (guard/service internals) is reserved for the named
// "heavy modules" per tasks.md T045; the other ~500 routes get a documented,
// transparent classification by path/module pattern + HTTP method, not by
// individually reading each controller's business logic.
const fs = require("fs");
const path = require("path");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".controller.ts")) out.push(full);
  }
}

const files = [];
walk(path.join(__dirname, "..", "..", "src"), files);

const METHOD_DECORATORS = ["Get", "Post", "Put", "Patch", "Delete"];

const HEAVY_MODULES = [
  "analytics", "scheduling", "crm", "conversations", "campaigns",
  "platform-finance", "platform-usage", "platform-support", "public-booking",
  "integration-platform",
];

function classify(fullPath, method, controllerFile) {
  const p = fullPath.toLowerCase();
  const isHeavyModule = HEAVY_MODULES.some((m) => controllerFile.includes(`\\${m}\\`) || controllerFile.includes(`/${m}/`));

  if (p.includes("public/") || p.includes("public-") || controllerFile.includes("public-discovery") || controllerFile.includes("guest-chat")) return { cls: "public unauthenticated", heavy: isHeavyModule };
  if (p.startsWith("auth") || p.includes("/auth/") || controllerFile.includes("auth.controller")) return { cls: "authentication", heavy: isHeavyModule };
  if (p.includes("permission") || p.includes("role") || p.includes("rbac")) return { cls: "authorization-heavy", heavy: isHeavyModule };
  if (p.includes("webhook")) return { cls: "webhooks", heavy: isHeavyModule };
  if (controllerFile.includes("\\integration\\") || controllerFile.includes("/integration/") || controllerFile.includes("integration-platform")) return { cls: "external integrations", heavy: isHeavyModule };
  if (p.includes("payment") || p.includes("invoice") || p.includes("refund") || p.includes("settlement") || p.includes("transaction") || p.includes("merchant-account") || p.includes("billing")) return { cls: "payment operations", heavy: isHeavyModule };
  if (p.startsWith("ai/") || p.includes("/ai/") || p.startsWith("ai-")) return { cls: "AI operations", heavy: isHeavyModule };
  if (p.includes("upload") || p.includes("files") || p.includes("attachment") || p.includes("training-file")) return { cls: "file/media operations", heavy: isHeavyModule };
  if (p.includes("dashboard")) return { cls: "dashboard aggregation", heavy: isHeavyModule };
  if (p.includes("report")) return { cls: "reports", heavy: isHeavyModule };
  if (p.includes("analytics") || p.includes("usage") || p.includes("monitoring")) return { cls: "analytics", heavy: isHeavyModule };
  if (p.includes("search") || p.includes("query")) return { cls: "search", heavy: isHeavyModule };

  if (method === "GET") {
    const hasParam = /:\w+/.test(fullPath);
    return { cls: hasParam ? "standard CRUD" : "fast reads", heavy: isHeavyModule };
  }
  return { cls: "standard CRUD", heavy: isHeavyModule };
}

const routes = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const relFile = path.relative(path.join(__dirname, "..", ".."), file).replace(/\\/g, "/");

  const controllerMatch = src.match(/@Controller\(\s*(['"`])([^'"`]*)\1\s*\)/) || src.match(/@Controller\(\)/);
  const prefix = controllerMatch && controllerMatch[2] !== undefined ? controllerMatch[2] : "";

  const methodRegex = new RegExp(`@(${METHOD_DECORATORS.join("|")})\\(\\s*(?:(['"\`])([^'"\`]*)\\2)?\\s*\\)\\s*\\n?\\s*(?:@\\w+\\([^)]*\\)\\s*\\n?\\s*)*\\s*(?:async\\s+)?(\\w+)\\s*\\(`, "g");
  let m;
  while ((m = methodRegex.exec(src)) !== null) {
    const httpMethod = m[1].toUpperCase() === "GET" ? "GET" : m[1].toUpperCase();
    const subPath = m[3] || "";
    const handlerName = m[4];
    const fullPath = "/" + [prefix, subPath].filter(Boolean).join("/").replace(/\/+/g, "/").replace(/\/$/, "");
    const isPublic = /@Public\(\)/.test(src.slice(Math.max(0, m.index - 300), m.index));
    const { cls, heavy } = classify(fullPath || "/", httpMethod, relFile);
    routes.push({
      method: httpMethod,
      path: fullPath || "/",
      handler: handlerName,
      controller: relFile,
      publicDecorator: isPublic,
      class: isPublic ? "public unauthenticated" : cls,
      heavyModule: heavy,
    });
  }
}

routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const byClass = {};
for (const r of routes) byClass[r.class] = (byClass[r.class] || 0) + 1;

const outDir = path.join(__dirname, "..", "..", "..", "specs", "006-platform-performance-audit", "reports");
fs.writeFileSync(path.join(outDir, "endpoint-inventory.json"), JSON.stringify(routes, null, 2));

console.log(`Total routes extracted: ${routes.length} across ${files.length} controllers`);
console.log("\nBy class:");
for (const [cls, count] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls.padEnd(28)} ${count}`);
}
