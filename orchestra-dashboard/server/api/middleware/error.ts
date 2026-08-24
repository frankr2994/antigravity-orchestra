import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../application/errors.js';
import { redactSecrets } from '../../infrastructure/security/redaction.js';

export function errorHandlerMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ApplicationError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.resolution ? { resolution: error.resolution } : {}),
      ...(error.nextAction ? { nextAction: error.nextAction } : {}),
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    });
    return;
  }
  const correlationId = randomUUID();
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  console.error(`[${correlationId}] ${message}`);
  res.status(500).json({ error: 'An internal server error occurred.', code: 'INTERNAL_ERROR', correlationId });
}
