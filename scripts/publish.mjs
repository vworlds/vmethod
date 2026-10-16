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
const latest = metadata?.['dist-tags']?.latest ?? '0.0.0';
if (!/^\d+\.\d+\.\d+$/.test(latest))
  throw new Error(`Invalid latest stable version: ${latest}`);
let hasPreviousTag = true;
try {
  execFileSync(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/tags/v${latest}`],
    { stdio: 'pipe', timeout: 10000 },
  );
} catch (error) {
  // show-ref returns 1 for an absent ref; other failures must not broaden a release.
  if (error.status !== 1) throw error;
  hasPreviousTag = false;
}
const paths = hasPreviousTag
  ? execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        '--diff-filter=A',
        `v${latest}..HEAD`,
        '--',
        'changes/unreleased',
      ],
      { encoding: 'utf8', timeout: 10000 },
    )
      .trim()
      .split('\n')
  : readdirSync('changes/unreleased').map(
      (file) => `changes/unreleased/${file}`,
    );
const fragments = paths
  .filter((file) => /^changes\/unreleased\/\d+\.md$/.test(file))
  .map((file) => readFileSync(file, 'utf8'));
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
