import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { ZodSchema } from 'zod';
import { createLogger } from '../shared/logger';
import { SwarmAidError, ValidationError, AuthorizationError } from '../shared/errors';

const logger = createLogger('APIHelper');

export interface AuthContext {
  userId: string;
  email: string;
  roles: string[];
}

export interface HandlerContext extends AuthContext {
  requestId: string;
  event: APIGatewayProxyEventV2;
  lambdaContext: Context;
}

/**
 * Extract auth context from Lambda authorizer
 */
export function getAuthContext(event: APIGatewayProxyEventV2): AuthContext {
  const context = event.requestContext.authorizer?.lambda;

  if (!context?.userId) {
    throw new AuthorizationError('Missing authentication context');
  }

  return {
    userId: context.userId,
    email: context.email || '',
    roles: context.roles ? context.roles.split(',') : [],
  };
}

/**
 * Check if user has required role
 */
export function requireRole(context: AuthContext, ...allowedRoles: string[]): void {
  const hasRole = context.roles.some(role => 
    allowedRoles.includes(role) || role === 'admin'
  );

  if (!hasRole) {
    throw new AuthorizationError(`Required role: ${allowedRoles.join(' or ')}`);
  }
}

/**
 * Check if user can access resource (owner or privileged role)
 */
export function canAccessResource(
  context: AuthContext,
  ownerId: string,
  privilegedRoles: string[] = ['operator', 'admin']
): boolean {
  if (context.userId === ownerId) return true;
  return context.roles.some(role => privilegedRoles.includes(role) || role === 'admin');
}

/**
 * Parse and validate JSON body
 */
export function parseBody<T>(event: APIGatewayProxyEventV2, schema: ZodSchema<T>): T {
  if (!event.body) {
    throw new ValidationError('Request body is required');
  }

  try {
    const parsed = JSON.parse(event.body);
    return schema.parse(parsed);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      throw new ValidationError('Invalid request body', error.errors);
    }
    throw new ValidationError('Invalid JSON');
  }
}

/**
 * Parse query parameters
 */
export function getQueryParam(event: APIGatewayProxyEventV2, name: string, defaultValue?: string): string | undefined {
  return event.queryStringParameters?.[name] || defaultValue;
}

/**
 * Parse path parameters
 */
export function getPathParam(event: APIGatewayProxyEventV2, name: string): string {
  const value = event.pathParameters?.[name];
  if (!value) {
    throw new ValidationError(`Missing path parameter: ${name}`);
  }
  return value;
}

/**
 * Create success response
 */
export function successResponse(data: unknown, statusCode: number = 200): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}

/**
 * Create error response
 */
export function errorResponse(error: unknown, requestId: string): APIGatewayProxyResultV2 {
  if (error instanceof SwarmAidError) {
    return {
      statusCode: error.statusCode,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...error.toJSON(),
        requestId,
      }),
    };
  }

  // Unknown error
  logger.error('Unexpected error', error as Error, { requestId });

  return {
    statusCode: 500,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      errorCode: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId,
    }),
  };
}

/**
 * Wrapper for Lambda handlers with error handling and context
 */
export function wrapHandler(
  handler: (context: HandlerContext) => Promise<APIGatewayProxyResultV2>
) {
  return async (event: APIGatewayProxyEventV2, lambdaContext: Context): Promise<APIGatewayProxyResultV2> => {
    const requestId = lambdaContext.requestId;
    logger.setRequestId(requestId);

    try {
      const auth = getAuthContext(event);
      logger.setUserId(auth.userId);

      logger.info('Request received', {
        method: event.requestContext.http.method,
        path: event.requestContext.http.path,
        userId: auth.userId,
      });

      const context: HandlerContext = {
        ...auth,
        requestId,
        event,
        lambdaContext,
      };

      const result = await handler(context);

      // Add request ID to all responses
      result.headers = {
        ...result.headers,
        'X-Request-ID': requestId,
      };

      return result;
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
