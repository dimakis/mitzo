import { describe, expect, it } from 'vitest';
import { requestedIntegrationProviders } from '../integration-intent.js';

describe('requestedIntegrationProviders', () => {
  const grantable = ['google-workspace'];

  it.each([
    'look through my emails and Google Docs',
    'find the email Cat sent about my OKRs',
    'search Gmail for the launch note',
    'check my calendar for tomorrow',
    'use gws to list Drive files',
    'grant Google Workspace access',
  ])('recognizes Google Workspace data access in %j', (prompt) => {
    expect(requestedIntegrationProviders(prompt, grantable)).toEqual(['google-workspace']);
  });

  it.each([
    'draft an email to Cat',
    'explain how Google Docs permissions work',
    'fix the calendar UI',
    'write documentation for our email parser',
  ])('does not grant account access for content-only work in %j', (prompt) => {
    expect(requestedIntegrationProviders(prompt, grantable)).toEqual([]);
  });

  it('never returns a provider that is not configured as grantable', () => {
    expect(requestedIntegrationProviders('search Gmail', [])).toEqual([]);
  });
});
