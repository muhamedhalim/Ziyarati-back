const names = new Set();
export class SharedArray {
  constructor(name, fn) {
    if (names.has(name)) throw new Error(`SharedArray "${name}" created twice`);
    names.add(name);
    const arr = fn();
    if (!Array.isArray(arr)) throw new Error(`SharedArray "${name}" init did not return an array`);
    return arr;
  }
}
