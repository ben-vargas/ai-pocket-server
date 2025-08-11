/**
 * Simple logger utility
 */

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: keyof typeof LogLevel): void {
    this.level = LogLevel[level];
  }

  private log(level: LogLevel, category: string, message: string, data?: any): void {
    if (level < this.level) return;

    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const logMessage = `[${timestamp}] [${levelStr}] [${category}] ${message}`;

    if (data) {
      console.log(logMessage, data);
    } else {
      console.log(logMessage);
    }
  }

  debug(category: string, message: string, data?: any): void {
    this.log(LogLevel.DEBUG, category, message, data);
  }

  info(category: string, message: string, data?: any): void {
    this.log(LogLevel.INFO, category, message, data);
  }

  warn(category: string, message: string, data?: any): void {
    this.log(LogLevel.WARN, category, message, data);
  }

  error(category: string, message: string, data?: any): void {
    this.log(LogLevel.ERROR, category, message, data);
  }

  // Specialized loggers
  http(method: string, path: string, status: number, duration?: number): void {
    const durationStr = duration ? ` (${duration}ms)` : '';
    this.info('HTTP', `${method} ${path} ${status}${durationStr}`);
  }

  websocket(event: string, clientId: string, data?: any): void {
    this.info('WebSocket', `${event} - Client: ${clientId}`, data);
  }

  terminal(event: string, sessionId: string, data?: any): void {
    this.info('Terminal', `${event} - Session: ${sessionId}`, data);
  }

  agent(event: string, sessionId: string, data?: any): void {
    this.info('Agent', `${event} - Session: ${sessionId}`, data);
  }
}

export const logger = new Logger();