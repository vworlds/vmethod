import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { check } from '../check.js';
import { configValue, getConfig } from '../config.js';
import { init } from '../init.js';
import { verbs } from '../registry.js';

declare const __VERSION__: string;
declare const __BOARD_VERSION__: number;

const [verb, ...args] = process.argv.slice(2);
const root = process.cwd();
try {
  switch (verb) {
    case 'version':
      console.log(
        `vmethod ${__VERSION__}\nboard ${__BOARD_VERSION__}\nNode ${process.version}`,
      );
      break;
    case 'config': {
      if (args.length !== 2 || args[0] !== 'get')
        throw new Error('Usage: vmethod config get <key>');
      const value = configValue(getConfig(root, process.env), args[1]);
      console.log(
        typeof value === 'object' ? stringify(value).trimEnd() : String(value),
      );
      break;
    }
    case 'check': {
      if (args.length) throw new Error('Usage: vmethod check (offline)');
      const result = check(root, process.env);
      console.log(
        result.messages.length
          ? result.messages.join('\n')
          : 'vmethod check: ok',
      );
      process.exitCode = result.code;
      break;
    }
    case 'init': {
      if (args.length && (args.length !== 1 || args[0] !== '--dry-run'))
        throw new Error('Usage: vmethod init [--dry-run]');
      const templates = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../templates',
      );
      console.log(
        init(root, templates, args.includes('--dry-run')).join('\n') ||
          'Already initialized',
      );
      console.log(
        'Owner: install templates/claude-settings.json from @vworlds/vmethod as .claude/settings.json.',
      );
      break;
    }
    default:
      throw new Error(
        `Usage: vmethod <${verbs.map((entry) => entry.name).join('|')}>`,
      );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
