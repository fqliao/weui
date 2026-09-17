import { z } from 'zod';
import {
  uiTargetSchema,
  uiConditionSchema,
  structuredAssertionSchema,
  keySchema,
  parametersSchema,
  mapStrings,
  expandParameters,
} from './static-ui.ts';
const text = z.string().trim().min(1).max(2000);
export const webStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('act'), text }),
  z.object({ kind: z.literal('tap'), text, target: uiTargetSchema.optional() }),
  z.object({
    kind: z.literal('input'),
    text,
    value: z.string().max(4000),
    target: uiTargetSchema.optional(),
  }),
  z.object({
    kind: z.literal('select'),
    text,
    value: z.string().max(4000),
    selectBy: z.enum(['label', 'value']).default('label'),
    target: uiTargetSchema.optional(),
  }),
  z.object({ kind: z.literal('check'), text, checked: z.boolean(), target: uiTargetSchema.optional() }),
  z.object({ kind: z.literal('hover'), text, target: uiTargetSchema.optional() }),
  z.object({ kind: z.literal('press'), text, key: keySchema, target: uiTargetSchema.optional() }),
  z.object({
    kind: z.literal('wait'),
    text,
    condition: uiConditionSchema.optional(),
    timeoutMs: z.number().int().min(100).max(30000).optional(),
  }),
]);
export const webCaseSchema = z
  .object({
    title: z.string().trim().min(2).max(120),
    startPath: z.string().trim().min(1).max(2000).default('/'),
    sessionId: z.string().nullable().default(null),
    verifySessionOnly: z.boolean().default(false),
    cachePolicy: z.enum(['auto', 'realtime']).optional(),
    preconditions: z.string().max(4000).default(''),
    steps: z.array(webStepSchema).max(30),
    assertions: z
      .array(z.union([text, structuredAssertionSchema]))
      .min(1)
      .max(15),
    parameters: parametersSchema.optional(),
    cleanup: z.array(webStepSchema).max(10).default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    try {
      for (const value of Object.values(c.parameters ?? {})) expandParameters(value, 'run', 'case');
      mapStrings({ ...c, parameters: undefined }, (v) => expandParameters(v, 'run', 'case', c.parameters));
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message, path: ['parameters'] });
    }
  });
export type WebCaseInput = z.infer<typeof webCaseSchema>;
export type WebStep = z.infer<typeof webStepSchema>;
export type BrowserCase = WebCaseInput & {
  revision: number;
  featureId: string;
  featureRevision: number;
  sessionRevision: number | null;
};
export const loginConfigSchema = z.object({
  loginPath: z.string().min(1).max(2000).default('/login'),
  usernameField: z.string().max(500).default('用户名输入框'),
  passwordField: z.string().max(500).default('密码输入框'),
  submitInstruction: z.string().max(1000).default('点击登录按钮'),
  successAssertion: z.union([text, structuredAssertionSchema]),
});
export const storageStateSchema = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        value: z.string().max(16000),
        domain: z.string().min(1).max(253),
        path: z.string().startsWith('/').default('/'),
        expires: z.number().default(-1),
        httpOnly: z.boolean().default(false),
        secure: z.boolean().default(false),
        sameSite: z.enum(['Strict', 'Lax', 'None']).default('Lax'),
      }),
    )
    .max(100)
    .default([]),
  origins: z
    .array(
      z.object({
        origin: z.string().url(),
        localStorage: z
          .array(
            z.object({
              name: z.string().max(300),
              value: z.string().max(16000),
            }),
          )
          .max(100),
      }),
    )
    .max(10)
    .default([]),
});
export type StorageState = z.infer<typeof storageStateSchema>;
