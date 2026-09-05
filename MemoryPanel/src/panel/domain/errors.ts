/** Domain error. The HTTP layer maps status codes based on this. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 'NOT_FOUND', 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(msg = 'forbidden') {
    super(msg, 'FORBIDDEN', 403);
  }
}

export class ConflictError extends DomainError {
  constructor(msg: string) {
    super(msg, 'CONFLICT', 409);
  }
}

/**
 * Unified mapping of upstream errors from Core. skill-client maps core business codes (40001/40301/40401/...)
 Translate into a local DomainError subclass, no need to check codes in service / route.
 */
export class CoreUpstreamError extends DomainError {
  constructor(
    code: string,
    httpStatus: number,
    message: string,
    /** core original business code, for troubleshooting; not returned directly to the frontend. */
    readonly upstreamCode?: number,
  ) {
    super(message, code, httpStatus);
    this.name = 'CoreUpstreamError';
  }
}
