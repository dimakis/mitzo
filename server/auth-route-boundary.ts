import type { RequestHandler } from 'express';

/** Express 4 does not consume rejected async route promises. Authentication
 * failures must settle the response without disclosing tokens or store paths.
 */
export function authenticationRoute(
  handler: RequestHandler,
  options: { warn: (message: string) => void; logoutCookie?: string },
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(() => {
        options.warn('Authentication request failed');
        if (res.headersSent) {
          next(new Error('Authentication request failed'));
          return;
        }
        if (options.logoutCookie)
          res.clearCookie(options.logoutCookie, { httpOnly: true, sameSite: 'strict' });
        res.status(503).json({
          error: options.logoutCookie
            ? 'Logout revocation could not be confirmed. Try again.'
            : 'Authentication service unavailable. Try again.',
        });
      });
  };
}
