import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';

const logger = createLogger('EventService');

const client = new EventBridgeClient({
  region: config.aws.region,
  ...(config.aws.awsEndpoint && { endpoint: config.aws.awsEndpoint }),
});

export type EventType =
  | 'listing.created'
  | 'listing.updated'
  | 'listing.canceled'
  | 'demand.created'
  | 'demand.updated'
  | 'demand.closed'
  | 'match.proposed'
  | 'match.accepted'
  | 'match.rejected'
  | 'match.scheduled'
  | 'task.created'
  | 'task.picked_up'
  | 'task.delivered'
  | 'task.canceled'
  | 'task.failed'
  | 'compliance.blocked'
  | 'compliance.approved';

export interface SwarmAidEvent {
  type: EventType;
  entityType: string;
  entityId: string;
  userId?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

class EventService {
  /**
   * Publish an event to EventBridge
   */
  async publish(event: SwarmAidEvent): Promise<void> {
    try {
      await client.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: 'swarmaid',
              DetailType: event.type,
              Detail: JSON.stringify({
                ...event,
                eventId: `${event.entityId}-${Date.now()}`,
              }),
              EventBusName: config.eventBridge.eventBusName,
              Time: new Date(event.timestamp),
            },
          ],
        })
      );

      logger.info('Event published', {
        type: event.type,
        entityType: event.entityType,
        entityId: event.entityId,
      });
    } catch (error) {
      logger.error('Failed to publish event', error as Error, { event });
      // Don't throw - event publishing failures shouldn't block operations
    }
  }

  /**
   * Publish multiple events in batch
   */
  async publishBatch(events: SwarmAidEvent[]): Promise<void> {
    if (events.length === 0) return;

    try {
      // EventBridge supports up to 10 events per PutEvents call
      const batches: SwarmAidEvent[][] = [];
      for (let i = 0; i < events.length; i += 10) {
        batches.push(events.slice(i, i + 10));
      }

      for (const batch of batches) {
        await client.send(
          new PutEventsCommand({
            Entries: batch.map(event => ({
              Source: 'swarmaid',
              DetailType: event.type,
              Detail: JSON.stringify({
                ...event,
                eventId: `${event.entityId}-${Date.now()}`,
              }),
              EventBusName: config.eventBridge.eventBusName,
              Time: new Date(event.timestamp),
            })),
          })
        );
      }

      logger.info('Events published in batch', { count: events.length });
    } catch (error) {
      logger.error('Failed to publish events batch', error as Error, { count: events.length });
    }
  }
}

// Singleton instance
export const eventService = new EventService();
