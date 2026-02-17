import { ZodError } from "zod";

function formatIssuePath(path: (string | number)[]): string {
  if (path.length === 0) {
    return "<root>";
  }

  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : segment))
    .join(".")
    .replace(".[", "[");
}

export class ProtocolValidationError extends Error {
  public readonly issues: string[];

  public constructor(message: string, issues: string[]) {
    super(message);
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }

  public static fromZod(context: string, error: ZodError): ProtocolValidationError {
    const issues = error.issues.map((issue) => {
      const path = formatIssuePath(issue.path as (string | number)[]);
      return `${path}: ${issue.message}`;
    });

    return new ProtocolValidationError(
      `${context} did not match expected schema. ${issues.join("; ")}`,
      issues
    );
  }
}
