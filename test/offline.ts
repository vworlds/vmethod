// Fail closed if a test accidentally forgets to inject its strict fake transport.
globalThis.fetch = async () => {
  throw new Error('Real network disabled in tests: inject a fake fetch');
};
