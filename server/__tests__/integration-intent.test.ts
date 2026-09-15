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
    'edit my Google Doc',
    'download a file from Google Drive',
    'draft this in Gmail',
    'draft an email in Gmail',
    'use the Google Drive API to upload this file',
    'upload this via the Google Drive API',
    'download the report through the Google Drive API',
    'copy a file via the Google Drive API',
    'write this using the Google Docs API',
    'use the Google Drive API to list files',
    "Don't edit the code, just search Gmail for Cat",
    'Fix the Gmail handler and then search Gmail for Cat',
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
    'explain the Google Drive API',
    'fix the Gmail API client',
    'write Google Drive API documentation',
    'copy the Google Drive API docs into this repository',
    'do not access Gmail',
    "don't search my email",
    'never search my email',
    'without accessing Google Drive',
    'do not ever access Gmail',
    'never again search my email',
    'without directly accessing Google Drive',
    'avoid accessing Gmail',
    'refrain from using Google Drive',
    'you must not access Gmail',
    'you should not access Gmail',
    'you cannot access Gmail',
    "you can't access Gmail",
    'do not search or access Gmail',
    "please don't search or open Gmail",
    'do not search Gmail or open Google Drive',
    'do not search Gmail then open Google Drive',
    'you must not search and then access Gmail',
  ])('does not grant account access for content or technical work in %j', (prompt) => {
    expect(requestedIntegrationProviders(prompt, grantable)).toEqual([]);
  });

  it.each([
    'do not search the repo; search Gmail for Cat',
    'do not search the repo; then search Gmail for Cat',
    'search Gmail for Cat but do not open Google Drive',
    'do not open Drive, but search Gmail for Cat',
  ])('keeps affirmative access intent in a different clause for %j', (prompt) => {
    expect(requestedIntegrationProviders(prompt, grantable)).toEqual(['google-workspace']);
  });

  it('never returns a provider that is not configured as grantable', () => {
    expect(requestedIntegrationProviders('search Gmail', [])).toEqual([]);
  });
});
