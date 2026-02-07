import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { wrapHandler, HandlerContext, successResponse, getQueryParam } from '../helpers';
import { notificationRepository } from '../../integrations/dynamodb';

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  const since = getQueryParam(context.event, 'since');
  const limit = parseInt(getQueryParam(context.event, 'limit', '50'));

  // Get user's notifications
  const allNotifications = await notificationRepository.queryByUser(context.userId, limit * 2);

  let filtered = allNotifications;

  if (since) {
    filtered = allNotifications.filter((n: any) => n.createdAt > since);
  }

  // Sort by created date descending
  const sorted = filtered.sort((a: any, b: any) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }).slice(0, limit);

  return successResponse({ events: sorted, count: sorted.length });
});
