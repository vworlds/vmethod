import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { releasePlan } from './release-plan.mjs';

const candidate = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
const requiredRef = candidate ? 'refs/heads/dev' : 'refs/heads/master';
if (process.env.GITHUB_REF !== requiredRef)
  throw new Error(`Publishing requires ${requiredRef}`);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let metadata;
try {
  metadata = JSON.parse(
    execFileSync('npm', ['view', pkg.name, '--json'], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch (error) {
  // A package's first publication has no metadata; all other lookup failures are fatal.
  const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  if (!text.includes('E404')) throw error;
  metadata = { versions: [], 'dist-tags': {} };
}
const fragments = readdirSync('changes/unreleased')
  .filter((file) => /^\d+\.md$/.test(file))
  .map((file) => readFileSync(`changes/unreleased/${file}`, 'utf8'));
const plan = releasePlan(metadata, fragments, candidate);
pkg.version = plan.version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
execFileSync('npm', ['run', 'build'], { stdio: 'inherit', timeout: 120000 });
try {
  execFileSync(
    'npm',
    ['publish', '--provenance', '--access', 'public', '--tag', plan.tag],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 },
  );
} catch (error) {
  const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  if (/ENEEDAUTH|E401|E403|E404|EOTP|trusted publish|OIDC/i.test(text)) {
    console.error(
      'trusted publisher not configured: owner must configure npm OIDC trusted publishing for this repository and publish.yml',
    );
  }
  console.error(text);
  process.exit(1);
}
// No bump commit: the immutable tag is the published source of truth.
const tag = `v${plan.version}`;
execFileSync('git', ['tag', tag], { stdio: 'inherit', timeout: 10000 });
execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], {
  stdio: 'inherit',
  timeout: 60000,
});
console.log(
  `Published ${pkg.name}@${plan.version} (${plan.tag}), tagged ${tag}`,
);
