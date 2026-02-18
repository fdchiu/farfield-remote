import { z } from "zod";
import { ProtocolValidationError } from "./errors.js";
import { CollaborationModeSchema, ThreadConversationStateSchema } from "./thread.js";
import {
  CollaborationModeListResponseSchema as GeneratedCollaborationModeListResponseSchema,
  ModelListResponseSchema as GeneratedModelListResponseSchema,
  SendUserMessageParamsSchema as GeneratedSendUserMessageParamsSchema,
  SendUserMessageResponseSchema as GeneratedSendUserMessageResponseSchema,
  ThreadListResponseSchema as GeneratedThreadListResponseSchema,
  ThreadReadResponseSchema as GeneratedThreadReadResponseSchema,
  ThreadStartParamsSchema as GeneratedThreadStartParamsSchema,
  ThreadStartResponseSchema as GeneratedThreadStartResponseSchema
} from "./generated/app-server/index.js";

const AppServerThreadListResponseBaseSchema = GeneratedThreadListResponseSchema.passthrough();
const AppServerThreadReadResponseBaseSchema = GeneratedThreadReadResponseSchema.passthrough();
const AppServerModelListResponseBaseSchema = GeneratedModelListResponseSchema.passthrough();
const AppServerCollaborationModeListResponseBaseSchema =
  GeneratedCollaborationModeListResponseSchema.passthrough();
const AppServerStartThreadRequestBaseSchema = GeneratedThreadStartParamsSchema.passthrough();
const AppServerStartThreadResponseBaseSchema = GeneratedThreadStartResponseSchema.passthrough();
const AppServerSendUserMessageRequestBaseSchema = GeneratedSendUserMessageParamsSchema.passthrough();
const AppServerSendUserMessageResponseBaseSchema = GeneratedSendUserMessageResponseSchema;

export const AppServerThreadListItemSchema = AppServerThreadListResponseBaseSchema.shape.data.element;

export const AppServerListThreadsResponseSchema = AppServerThreadListResponseBaseSchema
  .extend({
    pages: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional()
  })
  .passthrough();

export const AppServerReadThreadResponseSchema: z.ZodObject<
  {
    thread: typeof ThreadConversationStateSchema;
  },
  "passthrough"
> = z
  .object({
    thread: ThreadConversationStateSchema
  })
  .passthrough();

export const AppServerModelSchema = AppServerModelListResponseBaseSchema.shape.data.element;

export const AppServerModelReasoningEffortSchema =
  AppServerModelSchema.shape.supportedReasoningEfforts.element;

export const AppServerListModelsResponseSchema = AppServerModelListResponseBaseSchema;

export const AppServerCollaborationModeListItemSchema =
  AppServerCollaborationModeListResponseBaseSchema.shape.data.element;

export const AppServerCollaborationModeListResponseSchema =
  AppServerCollaborationModeListResponseBaseSchema;

export const AppServerStartThreadRequestSchema = AppServerStartThreadRequestBaseSchema;

export const AppServerStartThreadResponseSchema = AppServerStartThreadResponseBaseSchema;

export const AppServerSendUserMessageRequestSchema = AppServerSendUserMessageRequestBaseSchema;

export const AppServerSendUserMessageResponseSchema = AppServerSendUserMessageResponseBaseSchema;

export const AppServerSetModeRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    collaborationMode: CollaborationModeSchema
  })
  .passthrough();

export type AppServerListThreadsResponse = z.infer<typeof AppServerListThreadsResponseSchema>;
export type AppServerReadThreadResponse = z.infer<typeof AppServerReadThreadResponseSchema>;
export type AppServerListModelsResponse = z.infer<typeof AppServerListModelsResponseSchema>;
export type AppServerCollaborationModeListResponse = z.infer<
  typeof AppServerCollaborationModeListResponseSchema
>;
export type AppServerStartThreadResponse = z.infer<typeof AppServerStartThreadResponseSchema>;

function parseWithSchema<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: z.input<Schema>,
  context: string
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ProtocolValidationError.fromZod(context, result.error);
  }
  return result.data;
}

export function parseAppServerListThreadsResponse(
  value: z.input<typeof AppServerListThreadsResponseSchema>
): AppServerListThreadsResponse {
  return parseWithSchema(AppServerListThreadsResponseSchema, value, "AppServerListThreadsResponse");
}

export function parseAppServerReadThreadResponse(
  value: z.input<typeof AppServerThreadReadResponseBaseSchema>
): AppServerReadThreadResponse {
  const parsed = parseWithSchema(
    AppServerThreadReadResponseBaseSchema,
    value,
    "GeneratedAppServerReadThreadResponse"
  );
  return {
    thread: parseWithSchema(
      ThreadConversationStateSchema,
      parsed.thread,
      "AppServerReadThreadResponse.thread"
    )
  };
}

export function parseAppServerListModelsResponse(
  value: z.input<typeof AppServerListModelsResponseSchema>
): AppServerListModelsResponse {
  return parseWithSchema(AppServerListModelsResponseSchema, value, "AppServerListModelsResponse");
}

export function parseAppServerCollaborationModeListResponse(
  value: z.input<typeof AppServerCollaborationModeListResponseSchema>
): AppServerCollaborationModeListResponse {
  return parseWithSchema(
    AppServerCollaborationModeListResponseSchema,
    value,
    "AppServerCollaborationModeListResponse"
  );
}

export function parseAppServerStartThreadResponse(
  value: z.input<typeof AppServerStartThreadResponseSchema>
): AppServerStartThreadResponse {
  return parseWithSchema(AppServerStartThreadResponseSchema, value, "AppServerStartThreadResponse");
}
