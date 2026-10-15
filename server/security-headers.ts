import helmet from 'helmet';

/** Shared with offline fixtures so they exercise the deployed application's CSP. */
export function createAppSecurityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        upgradeInsecureRequests: null,
      },
    },
  });
}
