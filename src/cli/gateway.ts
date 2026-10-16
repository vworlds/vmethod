import type { Transport } from '../gateway/transport.js';
import type { ReadInput } from '../gateway/server.js';

export async function gatewayVerb(
  transport: Transport,
  verb: string,
  args: string[],
): Promise<string> {
  switch (verb) {
    case 'read': {
      const [kind, ref, option] = args;
      if (
        !['pr', 'issue', 'comment', 'checks', 'registry'].includes(kind) ||
        !ref ||
        args.length > 3 ||
        (option !== undefined &&
          !['--files', '--diff', '--reviews', '--checks'].includes(option)) ||
        (option !== undefined && kind !== 'pr')
      )
        throw new Error(
          'Usage: vmethod read pr|issue|comment|checks|registry <ref> [--files|--diff|--reviews|--checks]',
        );
      return transport.call('read', { kind, ref, option } as ReadInput);
    }
    case 'post':
      if (args.length !== 2)
        throw new Error('Usage: vmethod post <ref> <file>');
      return transport.call('post', { ref: args[0], file: args[1] });
    case 'gh-read':
      if (args.length !== 1)
        throw new Error('Usage: vmethod gh-read <endpoint|file.graphql>');
      return transport.call('ghRead', { source: args[0] });
    case 'dropped':
      if (args.length && (args.length !== 2 || args[0] !== '--since'))
        throw new Error('Usage: vmethod dropped [--since <date>]');
      return transport.call('dropped', { since: args[1] });
    default:
      throw new Error('Unknown gateway verb');
  }
}
