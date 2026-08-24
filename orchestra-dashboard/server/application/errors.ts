export class ApplicationError extends Error {
  public readonly resolution?: string;
  public readonly nextAction?: string;
  public readonly retryable?: boolean;

  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    options?: ErrorOptions & { resolution?: string; nextAction?: string; retryable?: boolean },
  ) {
    super(message, options);
    this.name = 'ApplicationError';
    this.resolution = options?.resolution;
    this.nextAction = options?.nextAction;
    this.retryable = options?.retryable;
  }
}
