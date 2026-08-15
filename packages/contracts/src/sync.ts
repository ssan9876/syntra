import { z } from 'zod';

export const createSourceRequest = z.object({
  name: z.string().min(1).max(256),
  config: z.record(z.unknown()),
  bindPassword: z.string().min(1).max(1024),
  schedule: z.string().max(128).optional(),
  autoApply: z.boolean().optional(),
  deactivationThresholdPercent: z.number().int().min(0).max(100).optional(),
});

export const mappingRule = z.object({
  objectType: z.enum(['user', 'group', 'orgUnit']),
  sourceAttribute: z.string().min(1).max(128),
  targetField: z.string().min(1).max(128),
  transform: z.enum(['none', 'trim', 'lowercase']),
  isCorrelation: z.boolean(),
});

export const setMappingsRequest = z.object({
  rules: z.array(mappingRule).min(1),
});

export const applyRunRequest = z.object({
  only: z.array(z.string().uuid()).optional(),
});
