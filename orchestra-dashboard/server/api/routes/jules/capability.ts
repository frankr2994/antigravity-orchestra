import type { Response } from 'express';
import { hasJulesCapability, type JulesRolloutStage } from '../../../config.js';

export type JulesStageSource = JulesRolloutStage | (() => JulesRolloutStage);

export function currentJulesStage(source: JulesStageSource): JulesRolloutStage {
  return typeof source === 'function' ? source() : source;
}

export function requireJulesCapability(source: JulesStageSource, required: JulesRolloutStage, response: Response): boolean {
  const current = currentJulesStage(source);
  if (hasJulesCapability(current, required)) return true;
  response.status(501).json({
    error: `This Jules operation is unavailable at rollout stage '${current}'.`,
    code: 'JULES_CAPABILITY_UNAVAILABLE',
    requiredStage: required,
  });
  return false;
}
