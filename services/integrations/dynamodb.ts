import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';
import { NotFoundError, ConflictError } from '../shared/errors';
import { ulid } from 'ulid';

const logger = createLogger('DynamoDBService');

// Initialize DynamoDB client
const client = new DynamoDBClient({
  region: config.aws.region,
  ...(config.aws.dynamodbEndpoint && { endpoint: config.aws.dynamodbEndpoint }),
});

export const dynamodb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
});

/**
 * Base repository with common DynamoDB operations
 */
export class BaseRepository<T extends Record<string, any>> {
  constructor(
    protected tableName: string,
    protected entityType: string
  ) {}

  /**
   * Generate entity keys
   */
  protected getKeys(id: string): { PK: string; SK: string } {
    return {
      PK: `${this.entityType}#${id}`,
      SK: 'METADATA',
    };
  }

  /**
   * Put item with optimistic locking
   */
  async put(item: T): Promise<void> {
    const now = new Date().toISOString();
    const version = (item.version || 0) + 1;

    const keys = this.getKeys(item.id);
    const fullItem = {
      ...keys,
      ...item,
      EntityType: this.entityType,
      version,
      updatedAt: now,
      createdAt: item.createdAt || now,
    };

    try {
      await dynamodb.send(
        new PutCommand({
          TableName: this.tableName,
          Item: fullItem,
          ConditionExpression:
            item.version ? 'version = :expectedVersion' : 'attribute_not_exists(PK)',
          ExpressionAttributeValues: item.version ? { ':expectedVersion': item.version } : undefined,
        })
      );

      logger.debug('Item saved', { entityType: this.entityType, id: item.id, version });
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        throw new ConflictError('Item has been modified by another process', {
          id: item.id,
          expectedVersion: item.version,
        });
      }
      throw error;
    }
  }

  /**
   * Get item by ID
   */
  async get(id: string): Promise<T | null> {
    const keys = this.getKeys(id);

    const result = await dynamodb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: keys,
      })
    );

    if (!result.Item) {
      return null;
    }

    // Remove DynamoDB keys
    const { PK, SK, EntityType, ...item } = result.Item;
    return item as T;
  }

  /**
   * Get item by ID or throw
   */
  async getOrThrow(id: string): Promise<T> {
    const item = await this.get(id);
    if (!item) {
      throw new NotFoundError(this.entityType, id);
    }
    return item;
  }

  /**
   * Delete item
   */
  async delete(id: string): Promise<void> {
    const keys = this.getKeys(id);

    await dynamodb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: keys,
      })
    );

    logger.debug('Item deleted', { entityType: this.entityType, id });
  }

  /**
   * Query by status using GSI
   */
  async queryByStatus(status: string, limit?: number): Promise<T[]> {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-Status',
        KeyConditionExpression: 'EntityType = :entityType AND #status = :status',
        ExpressionAttributeNames: {
          '#status': 'Status',
        },
        ExpressionAttributeValues: {
          ':entityType': this.entityType,
          ':status': status,
        },
        Limit: limit,
      })
    );

    return (result.Items || []).map(item => {
      const { PK, SK, EntityType, ...cleaned } = item;
      return cleaned as T;
    });
  }

  /**
   * Query by user using GSI
   */
  async queryByUser(userId: string, limit?: number): Promise<T[]> {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-User',
        KeyConditionExpression: 'UserId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
        ScanIndexForward: false, // Most recent first
        Limit: limit,
      })
    );

    return (result.Items || []).map(item => {
      const { PK, SK, EntityType, ...cleaned } = item;
      return cleaned as T;
    });
  }

  /**
   * Query by geohash prefix using GSI
   */
  async queryByGeo(geohashPrefix: string, limit?: number): Promise<T[]> {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-Geo',
        KeyConditionExpression: 'begins_with(GeoHash, :prefix)',
        ExpressionAttributeValues: {
          ':prefix': geohashPrefix,
        },
        Limit: limit,
      })
    );

    return (result.Items || []).map(item => {
      const { PK, SK, EntityType, ...cleaned } = item;
      return cleaned as T;
    });
  }

  /**
   * Batch get items
   */
  async batchGet(ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];

    const keys = ids.map(id => this.getKeys(id));

    const result = await dynamodb.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            Keys: keys,
          },
        },
      })
    );

    const items = result.Responses?.[this.tableName] || [];
    return items.map(item => {
      const { PK, SK, EntityType, ...cleaned } = item;
      return cleaned as T;
    });
  }

  /**
   * Update specific fields
   */
  async updateFields(id: string, fields: Partial<T>, expectedVersion?: number): Promise<T> {
    const keys = this.getKeys(id);

    // Build update expression
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.entries(fields).forEach(([key, value], index) => {
      const nameKey = `#field${index}`;
      const valueKey = `:value${index}`;
      updateExpressions.push(`${nameKey} = ${valueKey}`);
      expressionAttributeNames[nameKey] = key;
      expressionAttributeValues[valueKey] = value;
    });

    // Add version and updatedAt
    updateExpressions.push('#version = #version + :inc', '#updatedAt = :now');
    expressionAttributeNames['#version'] = 'version';
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':inc'] = 1;
    expressionAttributeValues[':now'] = new Date().toISOString();

    try {
      const result = await dynamodb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys,
          UpdateExpression: `SET ${updateExpressions.join(', ')}`,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ConditionExpression: expectedVersion !== undefined ? 'version = :expectedVersion' : undefined,
          ReturnValues: 'ALL_NEW',
        })
      );

      const { PK, SK, EntityType, ...item } = result.Attributes!;
      return item as T;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        throw new ConflictError('Item has been modified by another process', {
          id,
          expectedVersion,
        });
      }
      throw error;
    }
  }
}

// Specific repositories
export const listingRepository = new BaseRepository(config.tables.entities, 'LISTING');
export const demandRepository = new BaseRepository(config.tables.entities, 'DEMAND');
export const matchRepository = new BaseRepository(config.tables.entities, 'MATCH');
export const taskRepository = new BaseRepository(config.tables.entities, 'TASK');
export const userRepository = new BaseRepository(config.tables.entities, 'USER');
export const routePlanRepository = new BaseRepository(config.tables.entities, 'ROUTE');
export const complianceCheckRepository = new BaseRepository(config.tables.entities, 'COMPLIANCE');
export const notificationRepository = new BaseRepository(config.tables.entities, 'NOTIFICATION');
