import type { Response } from 'express';

export function writeEvent<T extends { id: number; type: string }>(res: Response, event: T) {
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
