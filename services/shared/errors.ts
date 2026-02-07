// Base error class
export class SwarmAidError extends Error {
  constructor(
    message: string,
    public errorCode: string,
    public statusCode: number = 500,
    public details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      errorCode: this.errorCode,
      message: this.message,
      details: this.details,
    };
  }
}

// Client errors (4xx)
export class ValidationError extends SwarmAidError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class AuthenticationError extends SwarmAidError {
  constructor(message: string = 'Authentication required') {
    super(message, 'AUTHENTICATION_ERROR', 401);
  }
}

export class AuthorizationError extends SwarmAidError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 'AUTHORIZATION_ERROR', 403);
  }
}

export class NotFoundError extends SwarmAidError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id ${id} not found` : `${resource} not found`;
    super(message, 'NOT_FOUND', 404);
  }
}

export class ConflictError extends SwarmAidError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFLICT', 409, details);
  }
}

// Server errors (5xx)
export class InternalError extends SwarmAidError {
  constructor(message: string = 'Internal server error', details?: unknown) {
    super(message, 'INTERNAL_ERROR', 500, details);
  }
}

export class ServiceUnavailableError extends SwarmAidError {
  constructor(service: string) {
    super(`${service} is currently unavailable`, 'SERVICE_UNAVAILABLE', 503);
  }
}

// Domain-specific errors
export class StateTransitionError extends SwarmAidError {
  constructor(from: string, to: string, reason?: string) {
    const message = reason
      ? `Cannot transition from ${from} to ${to}: ${reason}`
      : `Invalid transition from ${from} to ${to}`;
    super(message, 'INVALID_STATE_TRANSITION', 400);
  }
}

export class ComplianceError extends SwarmAidError {
  constructor(message: string, ruleId: string) {
    super(message, 'COMPLIANCE_VIOLATION', 400, { ruleId });
  }
}

export class IdempotencyError extends SwarmAidError {
  constructor(message: string = 'Duplicate operation detected') {
    super(message, 'IDEMPOTENCY_VIOLATION', 409);
  }
}
