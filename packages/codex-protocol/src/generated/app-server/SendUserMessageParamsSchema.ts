// GENERATED FILE. DO NOT EDIT.
// Source: vendor/codex-app-server-schema/stable/json/v1/SendUserMessageParams.json
import { z } from "zod"

export const SendUserMessageParamsSchema = z.object({ "conversationId": z.string(), "items": z.array(z.any().superRefine((x, ctx) => {
    const schemas = [z.object({ "data": z.object({ "text": z.string(), "text_elements": z.array(z.object({ "byteRange": z.object({ "end": z.number().int().gte(0).describe("End byte offset (exclusive) within the UTF-8 text buffer."), "start": z.number().int().gte(0).describe("Start byte offset (inclusive) within the UTF-8 text buffer.") }).describe("Byte range in the parent `text` buffer that this element occupies."), "placeholder": z.union([z.string().describe("Optional human-readable placeholder for the element, displayed in the UI."), z.null().describe("Optional human-readable placeholder for the element, displayed in the UI.")]).describe("Optional human-readable placeholder for the element, displayed in the UI.").optional() })).describe("UI-defined spans within `text` used to render or persist special elements.").default([]) }), "type": z.literal("text") }), z.object({ "data": z.object({ "image_url": z.string() }), "type": z.literal("image") }), z.object({ "data": z.object({ "path": z.string() }), "type": z.literal("localImage") })];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  })) })
