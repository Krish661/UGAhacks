import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from './dynamodb';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';
import { ulid } from 'ulid';
import { AuditEvent } from '../shared/schemas';

const logger = createLogger('AuditService');

export interface AuditEventInput {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete' | 'state_transition' | 'compliance_decision' | 'override';
  actor: string;
  actorRole: string;
  requestId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  justification?: string;
  metadata?: Record<string, unknown>;
}

class AuditService {
  /**
   * Write an audit event
   */
  async writeEvent(input: AuditEventInput): Promise<void> {
    const timestamp = new Date().toISOString();
    const id = ulid();

    // Calculate diff if before and after are provided
    let diff: Array<{ field: string; oldValue: unknown; newValue: unknown }> | undefined;
    if (input.before && input.after) {
      diff = this.calculateDiff(input.before, input.after);
    }

    const auditEvent: AuditEvent = {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actor: input.actor,
      actorRole: input.actorRole,
      requestId: input.requestId,
      before: input.before,
      after: input.after,
      diff,
      justification: input.justification,
      metadata: input.metadata,
      timestamp,
      // TTL: 2 years from now (for compliance retention)
      ttl: Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60,
    };

    try {
      await dynamodb.send(
        new PutCommand({
          TableName: config.tables.audit,
          Item: {
            EntityId: input.entityId,
            Timestamp: timestamp,
            Actor: input.actor,
            ...auditEvent,
          },
        })
      );

      // Also log to CloudWatch for centralized search
      logger.info('Audit event written', {
        eventId: id,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actor: input.actor,
      });
    } catch (error) {
      logger.error('Failed to write audit event', error as Error, { input });
      // Don't throw - audit failures shouldn't block operations
    }
  }

  /**
   * Query audit events for an entity
   */
  async getEntityHistory(
    entityId: string,
    options?: {
      from?: string;
      to?: string;
      limit?: number;
    }
  ): Promise<AuditEvent[]> {
    const params: any = {
      TableName: config.tables.audit,
      KeyConditionExpression: 'EntityId = :entityId',
      ExpressionAttributeValues: {
        ':entityId': entityId,
      },
      ScanIndexForward: false, // Most recent first
      Limit: options?.limit || 100,
    };

    // Add timestamp filters
    if (options?.from || options?.to) {
      const conditions: string[] = ['EntityId = :entityId'];
      if (options.from && options.to) {
        params.KeyConditionExpression += ' AND #ts BETWEEN :from AND :to';
        params.ExpressionAttributeNames = { '#ts': 'Timestamp' };
        params.ExpressionAttributeValues[':from'] = options.from;
        params.ExpressionAttributeValues[':to'] = options.to;
      } else if (options.from) {
        params.KeyConditionExpression += ' AND #ts >= :from';
        params.ExpressionAttributeNames = { '#ts': 'Timestamp' };
        params.ExpressionAttributeValues[':from'] = options.from;
      } else if (options.to) {
        params.KeyConditionExpression += ' AND #ts <= :to';
        params.ExpressionAttributeNames = { '#ts': 'Timestamp' };
        params.ExpressionAttributeValues[':to'] = options.to;
      }
    }

    const result = await dynamodb.send(new QueryCommand(params));

    return (result.Items || []) as AuditEvent[];
  }

  /**
   * Query audit events by actor using GSI
   */
  async getActorHistory(
    actor: string,
    options?: {
      from?: string;
      to?: string;
      limit?: number;
    }
  ): Promise<AuditEvent[]> {
    const params: any = {
      TableName: config.tables.audit,
      IndexName: 'GSI-Actor',
      KeyConditionExpression: 'Actor = :actor',
      ExpressionAttributeValues: {
        ':actor': actor,
      },
      ScanIndexForward: false, // Most recent first
      Limit: options?.limit || 100,
    };

    // Add timestamp filters
    if (options?.from || options?.to) {
      if (options.from && options.to) {
        params.KeyConditionExpression += ' AND #ts BETWEEN :from AND :to';
        params.ExpressionAttributeNames = { '#ts': 'Timestamp' };
        params.ExpressionAttributeValues[':from'] = options.from;
        params.ExpressionAttributeValues[':to'] = options.to;
      } else if (options.from) {
        params.KeyConditionExpression += ' AND #ts >= :from';
        params.ExpressionAttributeNames = { '#ts': 'Timestamp' };
        params.ExpressionAttributeValues[':from'] = options.from;
      } else if (options.to) {
        params.KeyConditionExpression += ' AND #ts <= :to';
        params.ExpressionAttributeNames = { '#ts': 'Timestamp' };
        params.ExpressionAttributeValues[':to'] = options.to;
      }
    }

    const result = await dynamodb.send(new QueryCommand(params));

    return (result.Items || []) as AuditEvent[];
  }

  /**
   * Calculate diff between two objects
   */
  private calculateDiff(
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): Array<{ field: string; oldValue: unknown; newValue: unknown }> {
    const diff: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];

    // Find changed and new fields
    for (const [key, newValue] of Object.entries(after)) {
      const oldValue = before[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        diff.push({ field: key, oldValue, newValue });
      }
    }

    // Find deleted fields
    for (const [key, oldValue] of Object.entries(before)) {
      if (!(key in after)) {
        diff.push({ field: key, oldValue, newValue: undefined });
      }
    }

    return diff;
  }

  /**
   * Export audit events to S3 for a date range
   */
  async exportToS3(
    from: string,
    to: string,
    s3Service: any // S3Service would be injected
  ): Promise<string> {
    // This would be implemented by ops handler
    // For now, return a placeholder
    const exportKey = `audit-export-${from}-to-${to}-${ulid()}.json`;

    logger.info('Audit export requested', { from, to, exportKey });

    return exportKey;
  }
}

// Singleton instance
export const auditService = new AuditService();
