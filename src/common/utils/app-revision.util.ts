/**
 * Build identity of the running process.
 *
 * Set `APP_REVISION` to the git commit SHA at image-build / deploy time (a
 * deployment concern — nothing here reads git or the filesystem). The value is
 * validated as a 7–40 character hex SHA before it is ever emitted, so neither a
 * misconfigured variable nor a hostile one can put arbitrary text (a secret, a
 * URL, a banner) into a public response header. Anything else yields `unknown`.
 *
 * It exposes ONLY the commit identifier — no branch, build host, dependency or
 * environment information.
 */
const REVISION_RE = /^[0-9a-f]{7,40}$/;

export function getAppRevision(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.APP_REVISION ?? '').trim().toLowerCase();
  return REVISION_RE.test(raw) ? raw : 'unknown';
}
