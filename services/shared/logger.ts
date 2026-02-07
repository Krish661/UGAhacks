import { ulid } from 'ulid';
import { config } from './config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  userId?: string;
  operation?: string;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

class Logger {
  private requestId: string;
  private userId?: string;
  private operation?: string;

  constructor(operation?: string) {
    this.requestId = ulid();
    this.operation = operation;
  }

  setRequestId(requestId: string): void {
    this.requestId = requestId;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const configLevel = config.logging.level as LogLevel;
    return levels.indexOf(level) >= levels.indexOf(configLevel);
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      requestId: this.requestId,
      userId: this.userId,
      operation: this.operation,
      ...meta,
    };

    // Remove undefined fields
    Object.keys(entry).forEach(key => {
      if (entry[key] === undefined) {
        delete entry[key];
      }
    });

    const output = JSON.stringify(entry);

    switch (level) {
      case 'debug':
      case 'info':
        console.log(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const errorMeta = error
      ? {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        }
      : {};

    this.log('error', message, { ...errorMeta, ...meta });
  }

  getRequestId(): string {
    return this.requestId;
  }
}

export function createLogger(operation?: string): Logger {
  return new Logger(operation);
}
