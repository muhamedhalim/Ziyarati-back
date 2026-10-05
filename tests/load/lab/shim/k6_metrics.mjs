// Validates what real k6 validates at init: name format, and no name registered twice with a different type.
const R = globalThis.__LT.metrics;
const RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
function reg(kind, name) {
  if (!RE.test(name)) throw new Error(`invalid k6 metric name: "${name}"`);
  const prev = R.get(name);
  if (prev && prev.kind !== kind) throw new Error(`metric "${name}" registered as ${prev.kind} and ${kind}`);
  const m = prev || { kind, adds: 0 };
  R.set(name, m);
  return m;
}
class Base { constructor(name) { this.name = name; this.m = reg(this.kind, name); } add(v, tags) { this.m.adds++; if (tags) for (const [k, t] of Object.entries(tags)) if (t === undefined || t === null) globalThis.__LT.checkErrors.push(`metric ${this.name} tag ${k} is ${t}`); } }
export class Counter extends Base { get kind() { return 'counter'; } }
export class Rate extends Base { get kind() { return 'rate'; } }
export class Trend extends Base { get kind() { return 'trend'; } }
export class Gauge extends Base { get kind() { return 'gauge'; } }
