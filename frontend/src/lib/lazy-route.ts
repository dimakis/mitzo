import { lazy } from 'react';

export class RouteLoadError extends Error {
  constructor(cause: unknown) {
    super('This page could not be downloaded. Check your connection and try again.', { cause });
    this.name = 'RouteLoadError';
  }
}

/** Identify download failures so retry can clear React and browser module caches. */
export const lazyRoute: typeof lazy = (load) =>
  lazy(async () => {
    try {
      return await load();
    } catch (error) {
      throw new RouteLoadError(error);
    }
  });
