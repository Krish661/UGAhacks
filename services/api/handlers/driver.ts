import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { wrapHandler, HandlerContext, successResponse, requireRole, parseBody, getPathParam } from '../helpers';
import { taskRepository } from '../../integrations/dynamodb';
import { stateMachine } from '../../domain/state-machine';
import { auditService } from '../../integrations/audit';
import { eventService } from '../../integrations/events';
import { updateStatusRequestSchema, updateLocationRequestSchema } from '../../shared/schemas';

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  requireRole(context, 'driver', 'operator', 'admin');

  const { event } = context;
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  if (method === 'GET' && path === '/v1/driver/tasks') {
    const tasks = await taskRepository.queryByUser(context.userId, 100);
    const activeTasks = tasks.filter((t: any) => ['scheduled', 'en_route', 'picked_up'].includes(t.status));
    return successResponse({ tasks: activeTasks });
  }

  if (method === 'POST' && path.match(/^\/v1\/driver\/tasks\/.+\/status$/)) {
    const id = getPathParam(context.event, 'id');
    const task = await taskRepository.getOrThrow(id);

    if ((task as any).driverId !== context.userId && !context.roles.includes('operator') && !context.roles.includes('admin')) {
      return successResponse({ error: 'Forbidden' }, 403);
    }

    const input = parseBody(context.event, updateStatusRequestSchema);
    await stateMachine.transition((task as any).status, input.status as any, 'driver', { justification: input.reason });

    const updates: any = { status: input.status };
    if (input.status === 'picked_up') updates.actualPickupTime = new Date().toISOString();
    if (input.status === 'delivered') updates.actualDeliveryTime = new Date().toISOString();

    const before = { ...task };
    const updated = await taskRepository.updateFields(id, updates, (task as any).version);

    await auditService.writeEvent({
      entityType: 'TASK',
      entityId: id,
      action: 'state_transition',
      actor: context.userId,
      actorRole: context.roles.join(','),
      requestId: context.requestId,
      before,
      after: updated,
      justification: input.reason,
    });

    await eventService.publish({
      type: `task.${input.status}` as any,
      entityType: 'task',
      entityId: id,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      data: { taskId: id, status: input.status },
    });

    return successResponse({ task: updated });
  }

  if (method === 'POST' && path.match(/^\/v1\/driver\/tasks\/.+\/location$/)) {
    const id = getPathParam(context.event, 'id');
    const task = await taskRepository.getOrThrow(id);

    if ((task as any).driverId !== context.userId && !context.roles.includes('operator') && !context.roles.includes('admin')) {
      return successResponse({ error: 'Forbidden' }, 403);
    }

    const input = parseBody(context.event, updateLocationRequestSchema);

    const updated = await taskRepository.updateFields(id, {
      currentLocation: input.coordinates,
      lastLocationUpdate: input.timestamp || new Date().toISOString(),
    } as any, (task as any).version);

    return successResponse({ task: updated });
  }

  return successResponse({ error: 'Not found' }, 404);
});
