import { expect, it } from 'vitest';
import type { Page, Request, Response } from '@playwright/test';
import { observeMockedServiceHealth } from '../service-health-navigation.js';

function fixture() {
  let receive!: (response: Response) => void;
  let request!: (value: Request) => void;
  const main = {};
  const page = {
    mainFrame: () => main,
    on: (event: string, listener: (value: never) => void) => {
      if (event === 'response') receive = listener as typeof receive;
      else if (event === 'request') request = listener as typeof request;
      else throw Error('Unexpected listener: ' + event);
    },
  } as unknown as Page;
  const health = observeMockedServiceHealth(page, 'https://mitzo-ui.test');
  const respond = (
    url = 'https://mitzo-ui.test/api/service-health',
    status = 200,
    headersPending = false,
  ) => {
    let finish!: (error: Error | null) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<Error | null>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    const admitted = { url: () => url, isNavigationRequest: () => false } as Request;
    request(admitted);
    const headers = () =>
      receive({
        url: () => url,
        status: () => status,
        request: () => admitted,
        finished: () => completed,
      } as Response);
    if (!headersPending) headers();
    return { finish, reject, completed, headers };
  };
  const navigate = (mainDocument = true, navigation = true) =>
    request({
      url: () => 'https://mitzo-ui.test/next',
      isNavigationRequest: () => navigation,
      frame: () => (mainDocument ? main : {}),
    } as unknown as Request);
  return { health, respond, navigate };
}

it('requires actual completion, and retains a completed response admitted before the navigation check', async () => {
  const { health, respond } = fixture();
  const response = respond();
  expect(health.completion()).toBeUndefined();
  response.finish(null);
  await response.completed;
  expect(health.completion()).toEqual({ status: 200, failure: null });
});
it('does not treat a response from another origin or endpoint as readiness', async () => {
  const { health, respond } = fixture();
  for (const url of [
    'https://other.test/api/service-health',
    'https://mitzo-ui.test/api/accounts',
  ]) {
    const response = respond(url);
    response.finish(null);
    await response.completed;
  }
  expect(health.completion()).toBeUndefined();
});
it('retains a non-200 response as failure evidence for the unchanged readiness assertion', async () => {
  const { health, respond } = fixture();
  const response = respond(undefined, 503);
  response.finish(null);
  await response.completed;
  expect(health.completion()).toEqual({ status: 503, failure: null });
});
it('retains an aborted response rather than declaring it complete', async () => {
  const { health, respond } = fixture();
  const response = respond();
  response.finish(Error('aborted navigation'));
  await response.completed;
  expect(health.completion()).toEqual({ status: 200, failure: 'aborted navigation' });
});
it('handles a rejected completion without throwing from an async event listener', async () => {
  const { health, respond } = fixture();
  const response = respond();
  response.reject(Error('transport closed'));
  await response.completed.catch(() => {});
  expect(health.completion()).toEqual({ status: 200, failure: 'Error: transport closed' });
});
it('does not let a previous document completion satisfy the next document navigation', async () => {
  const { health, respond, navigate } = fixture();
  const previous = respond();
  navigate();
  previous.finish(null);
  await previous.completed;
  expect(health.completion()).toBeUndefined();
  const current = respond();
  current.finish(null);
  await current.completed;
  expect(health.completion()).toEqual({ status: 200, failure: null });
  navigate();
  expect(health.completion()).toBeUndefined();
});

it('retains readiness through SPA and subframe requests in the same document', async () => {
  const { health, respond, navigate } = fixture();
  const response = respond();
  response.finish(null);
  await response.completed;
  navigate(true, false);
  navigate(false, true);
  expect(health.completion()).toEqual({ status: 200, failure: null });
});

it('ignores an old document request whose response headers arrive after navigation', async () => {
  const { health, respond, navigate } = fixture();
  const previous = respond(undefined, 200, true);
  navigate();
  previous.headers();
  previous.finish(null);
  await previous.completed;
  expect(health.completion()).toBeUndefined();
});
