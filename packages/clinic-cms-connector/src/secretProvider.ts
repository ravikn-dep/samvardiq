import { ConnectorConfigurationError } from './errors.js';

/**
 * Narrow secret-resolution boundary (section 9). `ClinicCmsConnection`
 * never carries the raw HMAC secret — only a `secretReference`, an opaque
 * pointer this interface resolves at the point of use. Production
 * secret-store selection is explicitly deferred (CLINIC-W1B status audit,
 * section 12, item 4) — this interface is the seam a real secret-store
 * implementation plugs into later without touching any connector code.
 */
export interface ConnectorSecretProvider {
  getSecret(secretReference: string): Promise<string>;
}

/**
 * Development/test-only implementation: resolves a `secretReference` of the
 * form `env:VAR_NAME` from `process.env`. Never used with a production
 * secret store — that is a separate, deferred infrastructure decision, not
 * this session's scope. Never logs the resolved secret value.
 */
export class EnvConnectorSecretProvider implements ConnectorSecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSecret(secretReference: string): Promise<string> {
    if (!secretReference.startsWith('env:')) {
      throw new ConnectorConfigurationError('Unsupported secret reference format.');
    }
    const varName = secretReference.slice('env:'.length);
    const value = this.env[varName];
    if (!value) {
      throw new ConnectorConfigurationError('The referenced clinic connection secret is not configured.');
    }
    return value;
  }
}
