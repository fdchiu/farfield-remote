// GENERATED FILE. DO NOT EDIT.
// Source: vendor/codex-app-server-schema/stable/json/ToolRequestUserInputResponse.json
import { z } from "zod"

export const ToolRequestUserInputResponseSchema = z.object({ "answers": z.record(z.object({ "answers": z.array(z.string()) }).describe("EXPERIMENTAL. Captures a user's answer to a request_user_input question.")) }).describe("EXPERIMENTAL. Response payload mapping question ids to answers.")
