// CI-equivalent deploy (infra/docs/DEPLOYMENT.md §2): latest ACTIVE revision -> replace ONLY the image -> register.
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const TAG = process.argv[2]; const R = 'eu-central-1';
const IMAGE = `270370109141.dkr.ecr.${R}.amazonaws.com/ziyaratech/backend:${TAG}`;
const aws = (args, input) => execFileSync('aws', [...args, '--region', R], { encoding: 'utf8', input, env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 1 << 26 }).trim();
const sp = process.env.SP;
function register(family) {
  const d = JSON.parse(aws(['ecs', 'describe-task-definition', '--task-definition', family, '--include', 'TAGS', '--output', 'json']));
  const td = d.taskDefinition; const tags = d.tags || [];
  const keep = ['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions', 'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform', 'ephemeralStorage', 'proxyConfiguration', 'pidMode', 'ipcMode'];
  const out = {}; for (const k of keep) if (td[k] !== undefined && td[k] !== null) out[k] = td[k];
  let n = 0;
  for (const c of out.containerDefinitions) if (/ziyaratech\/backend:/.test(c.image)) { c.image = IMAGE; n++; }
  if (!n) throw new Error('no backend image in ' + family);
  if (tags.length) out.tags = tags;
  const f = path.join(sp, `td-${family}.json`); fs.writeFileSync(f, JSON.stringify(out));
  const arn = aws(['ecs', 'register-task-definition', '--cli-input-json', 'file://' + f.replace(/\\/g, '/'), '--query', 'taskDefinition.taskDefinitionArn', '--output', 'text']);
  fs.unlinkSync(f); return arn;
}
const mode = process.argv[3];
if (mode === 'register') {
  const arns = {}; for (const fam of ['zt-production-migrate', 'zt-production-api', 'zt-production-worker']) { arns[fam] = register(fam); console.log('registered', arns[fam].split('/').pop()); }
  fs.writeFileSync(path.join(sp, 'deploy-arns.json'), JSON.stringify(arns));
}
