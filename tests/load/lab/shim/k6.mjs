export const sleep = () => {};
export const check = (res, assertions) => { let ok = true; for (const f of Object.values(assertions)) { try { if (!f(res)) ok = false; } catch (e) { ok = false; globalThis.__LT.checkErrors.push(String(e.message)); } } return ok; };
export const fail = (m) => { throw new Error(`fail(): ${m}`); };
export const group = (n, fn) => fn();
