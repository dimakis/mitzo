import { join } from 'path';
import pino from 'pino';
import type { DestinationStream, LoggerOptions, TransportTargetOptions } from 'pino';
import { trace, context } from '@opentelemetry/api';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const VALID_LEVELS: Record<string, boolean> = { debug: true, info: true, warn: true, error: true };

function resolveLevel(): LogLevel {
  const env = process.env.LOG_LEVEL;
  return env && VALID_LEVELS[env] ? (env as LogLevel) : 'info';
}

function otelMixin(): Record<string, unknown> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function isPinoPrettyAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function buildProductionDestination(level: LogLevel): DestinationStream {
  const logDir = join(process.cwd(), 'logs');
  const logFile = process.env.LOG_FILE_PATH ?? join(logDir, 'server.log');

  const usePretty = process.env.NODE_ENV === 'development' && isPinoPrettyAvailable();

  const targets: TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      options: {
        file: logFile,
        frequency: 'daily',
        mkdir: true,
        dateFormat: 'yyyy-MM-dd',
      },
      level,
    },
    {
      target: usePretty ? 'pino-pretty' : 'pino/file',
      options: usePretty ? { colorize: true } : { destination: 1 },
      level,
    },
  ];

  // pino-loki's `host` option is the base URL (e.g. http://localhost:3200);
  // the library appends /loki/api/v1/push internally.
  const lokiHost = process.env.LOKI_HOST;
  if (lokiHost) {
    targets.push({
      target: 'pino-loki',
      options: {
        host: lokiHost,
        labels: { app: 'mitzo' },
        propsToLabels: ['module'],
        batching: true,
        interval: 5,
      },
      level,
    });
  }

  return pino.transport({ targets });
}

/**
 * Build a Pino root logger. Exported for testing — production code uses the
 * module-level `rootLogger` singleton.
 */
export function _buildLogger(dest?: DestinationStream) {
  const level = resolveLevel();
  const opts: LoggerOptions = {
    level,
    mixin: otelMixin,
    serializers: { err: pino.stdSerializers.err },
  };

  if (dest) return pino(opts, dest);

  if (process.env.LOGGER_SYNC === '1' && process.env.LOG_FILE_PATH) {
    return pino(
      opts,
      pino.destination({ dest: process.env.LOG_FILE_PATH, sync: true, mkdir: true }),
    );
  }

  return pino(opts, buildProductionDestination(level));
}

let rootLogger: pino.Logger | null = null;

function getRootLogger(): pino.Logger {
  if (!rootLogger) {
    rootLogger = _buildLogger();
  }
  return rootLogger;
}

export interface Logger {
  debug: (message: string, ctx?: Record<string, unknown>) => void;
  info: (message: string, ctx?: Record<string, unknown>) => void;
  warn: (message: string, ctx?: Record<string, unknown>) => void;
  error: (message: string, ctx?: Record<string, unknown>) => void;
}

export function createLogger(module: string): Logger {
  const child = getRootLogger().child({ module });
  return {
    debug: (message: string, ctx?: Record<string, unknown>) => child.debug(ctx ?? {}, message),
    info: (message: string, ctx?: Record<string, unknown>) => child.info(ctx ?? {}, message),
    warn: (message: string, ctx?: Record<string, unknown>) => child.warn(ctx ?? {}, message),
    error: (message: string, ctx?: Record<string, unknown>) => child.error(ctx ?? {}, message),
  };
}
