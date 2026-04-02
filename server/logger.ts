type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry): void {
  const { level, module, message, ...context } = entry;
  const prefix = `[${module}]`;
  const hasContext = Object.keys(context).length > 0;

  if (level === 'error') {
    console.error(prefix, message, ...(hasContext ? [context] : []));
  } else if (level === 'warn') {
    console.warn(prefix, message, ...(hasContext ? [context] : []));
  } else {
    console.log(prefix, message, ...(hasContext ? [context] : []));
  }
}

export function createLogger(module: string) {
  return {
    debug: (message: string, context?: Record<string, unknown>) =>
      emit({ level: 'debug', module, message, ...context }),
    info: (message: string, context?: Record<string, unknown>) =>
      emit({ level: 'info', module, message, ...context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      emit({ level: 'warn', module, message, ...context }),
    error: (message: string, context?: Record<string, unknown>) =>
      emit({ level: 'error', module, message, ...context }),
  };
}
