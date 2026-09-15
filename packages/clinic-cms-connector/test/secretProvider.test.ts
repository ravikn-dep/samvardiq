import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConnectorConfigurationError } from '../src/errors.js';
import { EnvConnectorSecretProvider } from '../src/secretProvider.js';

test('resolves a secret from the referenced environment variable', async () => {
  const provider = new EnvConnectorSecretProvider({ CLINIC_ACME_SECRET: 'super-secret-value' });
  const secret = await provider.getSecret('env:CLINIC_ACME_SECRET');
  assert.equal(secret, 'super-secret-value');
});

test('M/L: an unconfigured secret reference fails closed, never returns an empty/placeholder secret', async () => {
  const provider = new EnvConnectorSecretProvider({});
  await assert.rejects(() => provider.getSecret('env:MISSING_VAR'), ConnectorConfigurationError);
});

test('rejects a secret-reference format it does not understand, rather than guessing', async () => {
  const provider = new EnvConnectorSecretProvider({ SOME_VAR: 'x' });
  await assert.rejects(() => provider.getSecret('vault:some/path'), ConnectorConfigurationError);
});
