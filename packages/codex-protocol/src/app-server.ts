import { z } from "zod";
import {
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  NullableNonEmptyStringSchema
} from "./common.js";
import { ProtocolValidationError } from "./errors.js";
import { CollaborationModeSchema, ThreadConversationStateSchema } from "./thread.js";

export const AppServerThreadListItemSchema = z
  .object({
    id: NonEmptyStringSchema,
    preview: z.string(),
    modelProvider: z.string().optional(),
    createdAt: NonNegativeIntSchema,
    updatedAt: NonNegativeIntSchema,
    path: z.string().optional(),
    cwd: z.string().optional(),
    cliVersion: z.string().optional(),
    source: z.string().optional(),
    gitInfo: z.unknown().nullable().optional(),
    turns: z.array(z.unknown()).optional()
  })
  .strict();

export const AppServerListThreadsResponseSchema = z
  .object({
    data: z.array(AppServerThreadListItemSchema),
    nextCursor: z.string().nullable().optional(),
    pages: NonNegativeIntSchema.optional(),
    truncated: z.boolean().optional()
  })
  .strict();

export const AppServerReadThreadResponseSchema = z
  .object({
    thread: ThreadConversationStateSchema
  })
  .strict();

export const AppServerModelSchema = z
  .object({
    id: NonEmptyStringSchema,
    displayName: z.string().optional(),
    providerId: z.string().optional(),
    providerName: z.string().optional(),
    contextWindow: NonNegativeIntSchema.optional(),
    maxOutputTokens: NonNegativeIntSchema.optional()
  })
  .strict();

export const AppServerListModelsResponseSchema = z
  .object({
    data: z.array(AppServerModelSchema)
  })
  .strict();

export const AppServerCollaborationModeListItemSchema = z
  .object({
    name: z.string(),
    mode: NonEmptyStringSchema,
    model: NullableNonEmptyStringSchema,
    reasoning_effort: NullableNonEmptyStringSchema,
    developer_instructions: z.union([z.string(), z.null()])
  })
  .strict();

export const AppServerCollaborationModeListResponseSchema = z
  .object({
    data: z.array(AppServerCollaborationModeListItemSchema)
  })
  .strict();

export const AppServerStartThreadRequestSchema = z
  .object({
    cwd: z.string(),
    model: z.string().optional(),
    modelProvider: z.string().optional(),
    personality: z.string().optional(),
    sandbox: z.string().optional(),
    approvalPolicy: z.string().optional(),
    ephemeral: z.boolean().optional()
  })
  .strict();

export const AppServerSetModeRequestSchema = z
  .object({
    conversationId: NonEmptyStringSchema,
    collaborationMode: CollaborationModeSchema
  })
  .strict();

export type AppServerListThreadsResponse = z.infer<typeof AppServerListThreadsResponseSchema>;
export type AppServerReadThreadResponse = z.infer<typeof AppServerReadThreadResponseSchema>;
export type AppServerListModelsResponse = z.infer<typeof AppServerListModelsResponseSchema>;
export type AppServerCollaborationModeListResponse = z.infer<
  typeof AppServerCollaborationModeListResponseSchema
>;

export function parseAppServerListThreadsResponse(
  value: unknown
): AppServerListThreadsResponse {
  const result = AppServerListThreadsResponseSchema.safeParse(value);
  if (!result.success) {
    throw ProtocolValidationError.fromZod("AppServerListThreadsResponse", result.error);
  }
  return result.data;
}

export function parseAppServerReadThreadResponse(value: unknown): AppServerReadThreadResponse {
  const result = AppServerReadThreadResponseSchema.safeParse(value);
  if (!result.success) {
    throw ProtocolValidationError.fromZod("AppServerReadThreadResponse", result.error);
  }
  return result.data;
}

export function parseAppServerListModelsResponse(value: unknown): AppServerListModelsResponse {
  const result = AppServerListModelsResponseSchema.safeParse(value);
  if (!result.success) {
    throw ProtocolValidationError.fromZod("AppServerListModelsResponse", result.error);
  }
  return result.data;
}

export function parseAppServerCollaborationModeListResponse(
  value: unknown
): AppServerCollaborationModeListResponse {
  const result = AppServerCollaborationModeListResponseSchema.safeParse(value);
  if (!result.success) {
    throw ProtocolValidationError.fromZod(
      "AppServerCollaborationModeListResponse",
      result.error
    );
  }
  return result.data;
}
