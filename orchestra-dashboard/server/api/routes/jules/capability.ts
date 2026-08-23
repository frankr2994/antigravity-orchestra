import type { Response } from 'express';
import { hasJulesCapability, type JulesRolloutStage } from '../../../config.js';

export function requireJulesCapability(current: JulesRolloutStage, required: JulesRolloutStage, response: Response): boolean {
  if (hasJulesCapability(current, required)) return true;
  response.status(501).json({
    error: `This Jules operation is unavailable at rollout stage '${current}'.`,
    code: 'JULES_CAPABILITY_UNAVAILABLE',
    requiredStage: required,
  });
  return false;
}
