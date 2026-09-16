import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryIdentityProviderLinkRepository, InMemoryIdentityRepository, InMemoryMembershipRepository } from '@samvardiq/identity-access';

import { InMemoryCommunicationChannelRepository } from '../src/channelRepository.js';
import { provisionCommunicationChannel } from '../src/provisioning.js';

function buildDeps() {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const channels = new InMemoryCommunicationChannelRepository();
  return { identities, providerLinks, memberships, channels };
}

test('O/BS: provisioning creates a service identity, provider link, ACTIVE membership with no approverRole, and the channel row', async () => {
  const deps = buildDeps();
  const channel = await provisionCommunicationChannel(deps, {
    channelId: 'chan-1',
    organizationId: 'org-A',
    externalChannelId: 'phone-1',
    displayPhoneNumber: '+911234567890',
    timezone: 'Asia/Kolkata',
    accessTokenReference: 'env:TOKEN',
  });

  const identity = await deps.identities.get(channel.serviceIdentityId);
  assert.equal(identity?.principalType, 'service');
  assert.equal(identity?.status, 'active');

  const membership = await deps.memberships.get('org-A', channel.serviceIdentityId);
  assert.equal(membership?.role, 'MEMBER');
  assert.equal(membership?.approverRole, undefined);
  assert.equal(membership?.status, 'ACTIVE');

  const linkedIdentityId = await deps.providerLinks.findIdentityId('whatsapp-channel', 'chan-1');
  assert.equal(linkedIdentityId, channel.serviceIdentityId);
});

test('provisioning is collision-safe: re-running with the same channelId/organizationId fails rather than silently duplicating', async () => {
  const deps = buildDeps();
  const input = { channelId: 'chan-1', organizationId: 'org-A', externalChannelId: 'phone-1', displayPhoneNumber: '+911234567890', timezone: 'Asia/Kolkata', accessTokenReference: 'env:TOKEN' };
  await provisionCommunicationChannel(deps, input);
  await assert.rejects(provisionCommunicationChannel(deps, input));
});

test('BS: provisioning takes no webhook/request input — its signature accepts only operator-supplied configuration', () => {
  assert.equal(provisionCommunicationChannel.length, 2); // (deps, input) — no request/webhook parameter exists to accept one
});
