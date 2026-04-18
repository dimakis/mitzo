import pino from 'pino';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const VALID_LEVELS: Record<string, boolean> = { debug: true, info: true, warn: true, error: true };

const configuredLevel: LogLevel =
  process.env.LOG_LEVEL && VALID_LEVELS[process.env.LOG_LEVEL]
    ? (process.env.LOG_LEVEL as LogLevel)
    : 'info';

const rootLogger = pino({
  level: configuredLevel,
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export function createLogger(module: string) {
  const child = rootLogger.child({ module });
  return {
    debug: (message: string, ctx?: Record<string, unknown>) => child.debug(ctx ?? {}, message),
    info: (message: string, ctx?: Record<string, unknown>) => child.info(ctx ?? {}, message),
    warn: (message: string, ctx?: Record<string, unknown>) => child.warn(ctx ?? {}, message),
    error: (message: string, ctx?: Record<string, unknown>) => child.error(ctx ?? {}, message),
  };
}
