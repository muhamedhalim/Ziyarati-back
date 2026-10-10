'use strict';
// Renders the organisation service control policies (modules/org-guardrails/policies)
// without a provider, a credential or any state: read-only `terraform console`.
//
//   node infra/scripts/scp-render.cjs --vars vars.json [--out dir]
//
// vars.json holds the module's inputs, e.g.
//   { "approved_regions": ["xx-north-1"], "us_east_1_health_check_exception": true,
//     "audit_exempt_principal_arns": ["arn:aws:iam::123456789012:role/zt-tf-apply"] }
//
// Prints { "<policy-name>": <policy document> } as JSON, or writes one
// <policy-name>.json file per policy into --out (used by scp-validate.sh and by
// infra/scripts/tests/scp-semantics.test.cjs, which imports render()).

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_DIR = path.resolve(__dirname, '../terraform/modules/org-guardrails/policies');

function terraformAvailable() {
  return spawnSync('terraform', ['version'], { encoding: 'utf8' }).status === 0;
}

/** @param {Record<string, unknown>} vars module inputs as plain JSON values */
function render(vars) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-render-'));
  const env = { ...process.env, TF_DATA_DIR: dataDir, TF_IN_AUTOMATION: '1' };
  for (const [k, v] of Object.entries(vars)) env[`TF_VAR_${k}`] = JSON.stringify(v);
  try {
    const init = spawnSync('terraform', ['-chdir=' + MODULE_DIR, 'init', '-backend=false', '-input=false', '-no-color'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, `terraform init failed:\n${init.stdout}\n${init.stderr}`);
    const run = spawnSync('terraform', ['-chdir=' + MODULE_DIR, 'console', '-no-color'], {
      env,
      input: 'jsonencode(local.documents)\n',
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `terraform console failed:\n${run.stdout}\n${run.stderr}`);
    // console prints the string as an HCL literal; its escapes are JSON-compatible here.
    const literal = run.stdout.trim().split('\n').pop();
    const documents = JSON.parse(JSON.parse(literal));
    return Object.fromEntries(Object.entries(documents).map(([name, text]) => [name, JSON.parse(text)]));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

module.exports = { render, terraformAvailable, MODULE_DIR };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const varsFile = opt('--vars');
  if (!varsFile) {
    console.error('usage: scp-render.cjs --vars vars.json [--out dir]');
    process.exit(2);
  }
  const documents = render(JSON.parse(fs.readFileSync(varsFile, 'utf8')));
  const out = opt('--out');
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    for (const [name, doc] of Object.entries(documents)) {
      // minified: the character count is what the 5,120 limit applies to
      fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(doc));
    }
    console.log(`wrote ${Object.keys(documents).length} policies to ${out}`);
  } else {
    console.log(JSON.stringify(documents, null, 2));
  }
}
