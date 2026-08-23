export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApplicationError';
  }
}
