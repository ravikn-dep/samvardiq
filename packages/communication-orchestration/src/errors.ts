/**
 * Domain errors for the communication boundary. Every message is fixed and
 * generic — never the raw webhook payload, signature, or secret.
 */
abstract class CommunicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Section 9/32.A/B: the webhook signature did not verify. */
export class InvalidWebhookSignatureError extends CommunicationError {
  constructor() {
    super('The webhook signature could not be verified.');
  }
}

/** Section 32.C: the payload's phone_number_id does not match any configured channel. */
export class UnknownChannelError extends CommunicationError {
  constructor() {
    super('No channel is configured for this provider event.');
  }
}

/** Section 32.D: the channel exists but is administratively disabled. */
export class ChannelDisabledError extends CommunicationError {
  constructor() {
    super('This communication channel is disabled.');
  }
}

/** Section 13/32.U/V: the same provider event was already processed. */
export class DuplicateProviderEventError extends CommunicationError {
  constructor() {
    super('This provider event has already been processed.');
  }
}

/** Section 34: the raw payload could not be parsed as a supported event shape. */
export class MalformedProviderPayloadError extends CommunicationError {
  constructor() {
    super('The provider payload could not be parsed.');
  }
}

/** Section 24/31: the outcome of an outbound send could not be confirmed. */
export class OutboundSendFailedError extends CommunicationError {
  constructor(public readonly retryable: boolean) {
    super('The outbound message could not be delivered.');
  }
}
