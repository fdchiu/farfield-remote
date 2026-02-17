export class AppServerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AppServerError";
  }
}

export class AppServerTransportError extends AppServerError {
  public constructor(message: string) {
    super(message);
    this.name = "AppServerTransportError";
  }
}

export class AppServerRpcError extends AppServerError {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(`app-server error ${code}: ${message}`);
    this.name = "AppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

export class DesktopIpcError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DesktopIpcError";
  }
}
