import { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  wrapHandler,
  HandlerContext,
  successResponse,
  getQueryParam,
  parseBody,
} from '../helpers';
import { userRepository } from '../../integrations/dynamodb';
import { notificationPreferencesSchema } from '../../shared/schemas';

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  const { event } = context;
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  // GET /v1/me
  if (method === 'GET' && path === '/v1/me') {
    const user = await userRepository.get(context.userId);

    if (!user) {
      // Create user profile on first access
      const newUser = {
        id: context.userId,
        userId: context.userId,
        email: context.email,
        name: context.email.split('@')[0],
        roles: context.roles,
        reliabilityScore: 100,
        completedDeliveries: 0,
        canceledDeliveries: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await userRepository.put(newUser);
      return successResponse({ user: newUser });
    }

    return successResponse({ user });
  }

  // PUT /v1/me/notifications
  if (method === 'PUT' && path === '/v1/me/notifications') {
    const preferences = parseBody(context.event, notificationPreferencesSchema);

    const user = await userRepository.getOrThrow(context.userId);

    const updated = await userRepository.updateFields(
      context.userId,
      { notificationPreferences: preferences } as any,
      (user as any).version
    );

    return successResponse({ user: updated });
  }

  return successResponse({ error: 'Not found' }, 404);
});
