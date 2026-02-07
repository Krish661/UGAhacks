import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { wrapHandler, HandlerContext, successResponse, requireRole, getQueryParam, parseBody, getPathParam } from '../helpers';
import { taskRepository, listingRepository, demandRepository, matchRepository } from '../../integrations/dynamodb';
import { auditService } from '../../integrations/audit';
import { stateMachine } from '../../domain/state-machine';
import { overrideTaskRequestSchema } from '../../shared/schemas';

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  requireRole(context, 'operator', 'admin');

  const { event } = context;
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  if (method === 'GET' && path === '/v1/ops/dashboard') {
    const [listings, demands, matches, tasks] = await Promise.all([
      listingRepository.queryByStatus('posted', 10),
      demandRepository.queryByStatus('posted', 10),
      matchRepository.queryByStatus('pending', 10),
      taskRepository.queryByStatus('scheduled', 10),
    ]);

    const summary = {
      listings: { posted: listings.length },
      demands: { posted: demands.length },
      matches: { pending: matches.length },
      tasks: { scheduled: tasks.length },
    };

    return successResponse({ summary, recentListings: listings.slice(0, 5), recentDemands: demands.slice(0, 5), recentTasks: tasks.slice(0, 5) });
  }

  if (method === 'GET' && path === '/v1/ops/stuck') {
    const tasks = await taskRepository.queryByStatus('scheduled', 100);
    const now = new Date();
    const stuck = tasks.filter((t: any) => {
      const scheduled = new Date(t.scheduledPickupTime);
      const hoursPast = (now.getTime() - scheduled.getTime()) / (1000 * 60 * 60);
      return hoursPast > 2; // Stuck if 2+ hours past scheduled pickup
    });

    return successResponse({ stuck, count: stuck.length });
  }

  if (method === 'POST' && path.match(/^\/v1\/ops\/tasks\/.+\/override$/)) {
    const id = getPathParam(context.event, 'id');
    const task = await taskRepository.getOrThrow(id);
    const input = parseBody(context.event, overrideTaskRequestSchema);

    const before = { ...task };
    let updated: any;

    switch (input.action) {
      case 'force_schedule':
        updated = await taskRepository.updateFields(id, { status: 'scheduled' } as any, (task as any).version);
        break;
      case 'reassign_driver':
        if (!input.newDriverId) throw new Error('newDriverId required for reassign_driver');
        updated = await taskRepository.updateFields(id, { driverId: input.newDriverId } as any, (task as any).version);
        break;
      case 'cancel':
        await stateMachine.transition((task as any).status, 'canceled', 'operator', { justification: input.justification });
        updated = await taskRepository.updateFields(id, { status: 'canceled', cancellationReason: input.justification } as any, (task as any).version);
        break;
    }

    await auditService.writeEvent({
      entityType: 'TASK',
      entityId: id,
      action: 'override',
      actor: context.userId,
      actorRole: context.roles.join(','),
      requestId: context.requestId,
      before,
      after: updated,
      justification: input.justification,
    });

    return successResponse({ task: updated });
  }

  if (method === 'GET' && path === '/v1/ops/audit/export') {
    const from = getQueryParam(context.event, 'from') || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = getQueryParam(context.event, 'to') || new Date().toISOString();

    // In production, this would trigger an async job to export to S3
    const exportId = `audit-export-${Date.now()}`;

    return successResponse({ exportId, from, to, status: 'pending', message: 'Export will be available in S3 bucket shortly' });
  }

  return successResponse({ error: 'Not found' }, 404);
});
