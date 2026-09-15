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
    'send this via Gmail',
    'upload this to Google Drive',
    'create an event in Google Calendar',
    'reply to the email from Morgan',
    'search the Google Sheets budget',
    'open Google Docs',
    'In Gmail, find the message from Cat',
    'Google Calendar: create an event',
    'search Gmail for the API migration email',
    'find the parser incident email in Gmail',
    'allow Google Workspace access',
    'use Google Drive to inspect the budget',
    'schedule a meeting in Google Calendar',
  ])('recognizes Google Workspace access intent in %j', (prompt) => {
    expect(requestedIntegrationProviders(prompt, grantable)).toEqual(['google-workspace']);
  });

  it.each([
    'draft an email to Cat',
    'explain how Google Docs permissions work',
    'find the email parser bug',
    'inspect and fix the calendar UI',
    'write documentation for our email parser',
    'search the codebase; Google Drive is mentioned in the README',
    'summarize the Google Drive documentation and search the source code',
    'find the Gmail handler bug, then write a regression test',
    'Google Calendar API docs explain how to create an event',
    'search the repository for the Google Sheets component',
  ])('does not grant account access for content or technical work in %j', (prompt) => {
    expect(requestedIntegrationProviders(prompt, grantable)).toEqual([]);
  });

  it('never returns a provider that is not configured as grantable', () => {
    expect(requestedIntegrationProviders('search Gmail', [])).toEqual([]);
  });
});
