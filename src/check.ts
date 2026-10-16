import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getConfig, loadYaml } from './config.js';
import permissionTemplate from '../templates/claude-settings.json' with { type: 'json' };
import packageMetadata from '../package.json' with { type: 'json' };

const mermaidPin = packageMetadata.peerDependencies.mermaid;
const secretPattern =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|:\/\/[^/\s:]+:[^/\s@]+@)/;

function secretPaths(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    return secretPattern.test(value) ? [path] : [];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    secretPaths(child, path ? `${path}.${key}` : key),
  );
}

export function check(
  root: string,
  env: NodeJS.ProcessEnv = {},
): { code: number; messages: string[] } {
  const messages: string[] = [];
  let missing = false;
  for (const kind of ['vmethod', 'people', 'models'] as const) {
    try {
      const value =
        kind === 'vmethod' ? getConfig(root, env) : loadYaml(root, kind);
      if (kind === 'vmethod') {
        const secrets = secretPaths(value);
        for (const path of secrets)
          messages.push(`Secret-looking config value at ${path} (redacted)`);
        if (
          !secrets.length &&
          secretPattern.test(readFileSync(join(root, 'vmethod.yaml'), 'utf8'))
        )
          messages.push(
            'Secret-looking value in vmethod.yaml (redacted; environment overrides do not hide stored secrets)',
          );
      }
      if (kind === 'people') {
        const people = value as { id: number; login: string }[];
        if (
          new Set(people.map((person) => person.id)).size !== people.length ||
          new Set(people.map((person) => person.login.toLowerCase())).size !==
            people.length
        )
          messages.push('people.yaml: duplicate id or login');
      }
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  let peerPath: string | undefined;
  try {
    peerPath = createRequire(join(root, 'package.json')).resolve(
      'mermaid/package.json',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND')
      messages.push(`Cannot resolve mermaid: ${(error as Error).message}`);
    else {
      missing = true;
      messages.push(`Dependency missing: install mermaid@${mermaidPin}`);
    }
  }
  if (peerPath) {
    try {
      const peer = JSON.parse(readFileSync(peerPath, 'utf8')) as {
        version: string;
      };
      if (peer.version !== mermaidPin)
        messages.push(
          `mermaid must equal ${mermaidPin}; installed ${peer.version}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing = true;
        messages.push(`Dependency missing: install mermaid@${mermaidPin}`);
      } else
        messages.push(`Invalid mermaid metadata: ${(error as Error).message}`);
    }
  }
  try {
    const settings = JSON.parse(
      readFileSync(join(root, '.claude/settings.json'), 'utf8'),
    ) as { permissions?: { deny?: string[] } };
    for (const rule of permissionTemplate.permissions.deny)
      if (!settings.permissions?.deny?.includes(rule))
        messages.push(`Permission deny rule missing: ${rule}`);
  } catch {
    messages.push(
      'Install owner-approved .claude/settings.json from templates/claude-settings.json',
    );
  }
  return { code: missing ? 2 : messages.length ? 1 : 0, messages };
}
