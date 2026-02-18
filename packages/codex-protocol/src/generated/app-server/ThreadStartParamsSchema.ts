// GENERATED FILE. DO NOT EDIT.
// Source: vendor/codex-app-server-schema/stable/json/v2/ThreadStartParams.json
import { z } from "zod"

export const ThreadStartParamsSchema = z.object({ "approvalPolicy": z.union([z.enum(["untrusted","on-failure","on-request","never"]), z.null()]).optional(), "baseInstructions": z.union([z.string(), z.null()]).optional(), "config": z.union([z.record(z.any()), z.null()]).optional(), "cwd": z.union([z.string(), z.null()]).optional(), "developerInstructions": z.union([z.string(), z.null()]).optional(), "modelProvider": z.union([z.string(), z.null()]).optional(), "ephemeral": z.union([z.boolean(), z.null()]).optional(), "sandbox": z.union([z.enum(["read-only","workspace-write","danger-full-access"]), z.null()]).optional(), "personality": z.union([z.enum(["none","friendly","pragmatic"]), z.null()]).optional(), "model": z.union([z.string(), z.null()]).optional() })
