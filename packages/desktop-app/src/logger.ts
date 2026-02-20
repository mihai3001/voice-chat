import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// Create logs directory
const logsDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for better readability
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    if (stack) {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`;
    }
    return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  })
);

// Daily rotating file transport
const fileTransport = new DailyRotateFile({
  dirname: logsDir,
  filename: 'voicelink-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',
  maxFiles: '7d', // Keep logs for 7 days
  format: logFormat
});

// Console transport for development
const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level}: ${message}`;
    })
  )
});

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports: [
    fileTransport,
    consoleTransport
  ]
});

// Log uncaught exceptions and unhandled rejections
logger.exceptions.handle(
  new DailyRotateFile({
    dirname: logsDir,
    filename: 'exceptions-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '10m',
    maxFiles: '7d',
    format: logFormat
  })
);

process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled Promise Rejection:', reason);
});

// Helper to get logs directory path
export function getLogsDirectory(): string {
  return logsDir;
}

// Helper to get recent log files
export function getRecentLogFiles(): string[] {
  try {
    const files = fs.readdirSync(logsDir);
    return files
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 3); // Get last 3 log files
  } catch (err) {
    logger.error('Failed to read log files:', err);
    return [];
  }
}

logger.info('Logger initialized');
logger.info(`Logs directory: ${logsDir}`);
