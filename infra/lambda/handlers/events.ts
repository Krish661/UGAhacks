import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getUserEvents } from '../shared/repository';
import { successResponse, errorResponse, extractUserContext } from '../shared/utils';

// ============================================
// GET /v1/events - Poll for Status Updates
// ============================================

export async function getEvents(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    // Get query parameters
    const since = event.queryStringParameters?.since; // ISO timestamp of last poll
    const limit = parseInt(event.queryStringParameters?.limit || '100', 10);

    // Fetch events since last poll
    const events = await getUserEvents(user.userId, since, limit);

    return successResponse({
      events,
      count: events.length,
      polledAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error getting events:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to get events', 500, error.message);
  }
}
