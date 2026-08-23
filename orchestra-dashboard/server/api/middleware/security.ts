import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config.js';

export const allowedHosts = new Set([
  `127.0.0.1:${config.port}`,
  `localhost:${config.port}`,
  '127.0.0.1:5173',
  'localhost:5173',
]);

export function hostValidationMiddleware(req: Request, res: Response, next: NextFunction) {
  const host = req.headers.host || '';
  if (!allowedHosts.has(host)) {
    res.status(403).json({ error: 'Invalid host.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (!allowedHosts.has(new URL(origin).host)) {
          res.status(403).json({ error: 'Invalid request origin.' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Invalid request origin.' });
        return;
      }
    }
    if (req.headers['x-orchestra-token'] !== config.uiToken) {
      res.status(403).json({ error: 'Invalid dashboard token.' });
      return;
    }
  }
  next();
}

export function dashboardTokenMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin) {
    try { if (!allowedHosts.has(new URL(origin).host)) return void res.status(403).json({ error: 'Invalid request origin.' }); }
    catch { return void res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  if (req.headers['x-orchestra-token'] !== config.uiToken) return void res.status(403).json({ error: 'Invalid dashboard token.' });
  next();
}
