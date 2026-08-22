import type { Request, Response, NextFunction } from 'express';

export function errorHandlerMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
}
