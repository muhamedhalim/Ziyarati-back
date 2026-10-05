// Registers the resolve hook that maps `k6` / `k6/*` imports to the Node shims in this folder.
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
