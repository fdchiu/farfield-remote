import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "./common.js";
import { ProtocolValidationError } from "./errors.js";
import { ThreadStreamStateChangedParamsSchema } from "./thread.js";

export const IpcInitializeFrameSchema = z
  .object({
    type: z.literal("initialize"),
    requestId: NonNegativeIntSchema.optional(),
    method: NonEmptyStringSchema.optional(),
    params: z.unknown().optional(),
    clientId: NonEmptyStringSchema.optional(),
    version: NonNegativeIntSchema.optional()
  })
  .strict();

export const IpcRequestFrameSchema = z
  .object({
    type: z.literal("request"),
    requestId: NonNegativeIntSchema,
    method: NonEmptyStringSchema,
    params: z.unknown().optional(),
    targetClientId: NonEmptyStringSchema.optional(),
    sourceClientId: NonEmptyStringSchema.optional(),
    version: NonNegativeIntSchema.optional()
  })
  .strict();

export const IpcResponseFrameSchema = z
  .object({
    type: z.literal("response"),
    requestId: NonNegativeIntSchema,
    success: z.boolean().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional()
  })
  .strict();

export const IpcBroadcastFrameSchema = z
  .object({
    type: z.literal("broadcast"),
    method: NonEmptyStringSchema,
    params: z.unknown().optional(),
    sourceClientId: NonEmptyStringSchema.optional(),
    targetClientId: NonEmptyStringSchema.optional(),
    version: NonNegativeIntSchema.optional()
  })
  .strict();

export const IpcFrameSchema = z.union([
  IpcInitializeFrameSchema,
  IpcRequestFrameSchema,
  IpcResponseFrameSchema,
  IpcBroadcastFrameSchema
]);

export const ThreadStreamStateChangedBroadcastSchema = z
  .object({
    type: z.literal("broadcast"),
    method: z.literal("thread-stream-state-changed"),
    sourceClientId: NonEmptyStringSchema,
    params: ThreadStreamStateChangedParamsSchema,
    version: NonNegativeIntSchema
  })
  .strict();

export type IpcFrame = z.infer<typeof IpcFrameSchema>;
export type IpcRequestFrame = z.infer<typeof IpcRequestFrameSchema>;
export type IpcResponseFrame = z.infer<typeof IpcResponseFrameSchema>;
export type IpcBroadcastFrame = z.infer<typeof IpcBroadcastFrameSchema>;
export type ThreadStreamStateChangedBroadcast = z.infer<
  typeof ThreadStreamStateChangedBroadcastSchema
>;

export function parseIpcFrame(value: unknown): IpcFrame {
  const result = IpcFrameSchema.safeParse(value);
  if (!result.success) {
    throw ProtocolValidationError.fromZod("IpcFrame", result.error);
  }
  return result.data;
}

export function parseThreadStreamStateChangedBroadcast(
  value: unknown
): ThreadStreamStateChangedBroadcast {
  const result = ThreadStreamStateChangedBroadcastSchema.safeParse(value);
  if (!result.success) {
    throw ProtocolValidationError.fromZod(
      "ThreadStreamStateChangedBroadcast",
      result.error
    );
  }
  return result.data;
}
