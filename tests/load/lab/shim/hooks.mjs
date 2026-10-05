export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'k6' || specifier.startsWith('k6/')) {
    const name = specifier.replace(/\//g, '_');
    return { url: new URL(`./${name}.mjs`, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
