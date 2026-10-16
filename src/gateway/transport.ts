export interface Operations {
  read: {
    input: {
      kind: 'pr' | 'issue' | 'comment' | 'checks' | 'registry';
      ref: string;
      option?: '--files' | '--diff' | '--reviews' | '--checks';
    };
    output: string;
  };
  post: { input: { ref: string; file: string }; output: string };
  ghRead: { input: { source: string }; output: string };
  dropped: { input: { since?: string }; output: string };
  ownerApproved: { input: { ref: string }; output: boolean | 'unknown' };
}

export interface Transport {
  call<K extends keyof Operations>(
    operation: K,
    input: Operations[K]['input'],
  ): Promise<Operations[K]['output']>;
}

export type Handlers = {
  [K in keyof Operations]: (
    input: Operations[K]['input'],
  ) => Promise<Operations[K]['output']>;
};

export function inProcess(handlers: Handlers): Transport {
  return {
    call<K extends keyof Operations>(
      operation: K,
      input: Operations[K]['input'],
    ): Promise<Operations[K]['output']> {
      return (
        handlers[operation] as (
          input: Operations[K]['input'],
        ) => Promise<Operations[K]['output']>
      )(input);
    },
  };
}
