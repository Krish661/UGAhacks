import { APIGatewayProxyResult } from 'aws-lambda';
import { ErrorResponse, SuccessResponse } from './types';

// ============================================
// Response Helpers
// ============================================

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function successResponse<T>(data: T, statusCode = 200): APIGatewayProxyResult {
  const response: SuccessResponse<T> = {
    success: true,
    data,
  };

  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(response),
  };
}

export function errorResponse(error: string, message: string, statusCode = 400, details?: any): APIGatewayProxyResult {
  const response: ErrorResponse = {
    error,
    message,
    details,
  };

  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(response),
  };
}

// ============================================
// User Context Extraction
// ============================================

export interface UserContext {
  userId: string;
  email: string;
  groups: string[];
}

export function extractUserContext(event: any): UserContext | null {
  try {
    const claims = event.requestContext?.authorizer?.claims;
    if (!claims) return null;

    const userId = claims.sub;
    const email = claims.email;
    const groupsStr = claims['cognito:groups'];
    const groups = groupsStr ? groupsStr.split(',') : [];

    return { userId, email, groups };
  } catch (error) {
    console.error('Failed to extract user context:', error);
    return null;
  }
}

// ============================================
// Request Body Parsing
// ============================================

export function parseBody<T>(event: any): T | null {
  try {
    if (!event.body) return null;
    return JSON.parse(event.body) as T;
  } catch (error) {
    console.error('Failed to parse request body:', error);
    return null;
  }
}

// ============================================
// Validation Error Formatting
// ============================================

export function formatZodError(error: any): string {
  if (error.errors && Array.isArray(error.errors)) {
    return error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
  }
  return error.message || 'Validation failed';
}
