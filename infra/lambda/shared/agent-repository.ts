import { DynamoDBClient, PutItemCommand, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { AgentSession, AgentKeyPatterns } from './agent-types';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

// ============================================
// Agent Session Operations
// ============================================

export async function saveAgentSession(session: AgentSession): Promise<void> {
  const keys = AgentKeyPatterns.session(session.userId, session.sessionId);
  const item = {
    ...keys,
    ...session,
    entityType: 'AGENT_SESSION',
  };

  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall(item, { removeUndefinedValues: true }),
  }));
}

export async function getAgentSession(userId: string, sessionId: string): Promise<AgentSession | null> {
  const keys = AgentKeyPatterns.session(userId, sessionId);
  
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: marshall(keys),
  }));

  if (!result.Item) return null;
  return unmarshall(result.Item) as AgentSession;
}

export async function getUserSessions(userId: string, limit = 10): Promise<AgentSession[]> {
  const keyPattern = AgentKeyPatterns.userSessions(userId);
  
  const result = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: marshall({
      ':pk': keyPattern.pk,
      ':sk': keyPattern.sk,
    }),
    Limit: limit,
    ScanIndexForward: false, // Most recent first
  }));

  if (!result.Items || result.Items.length === 0) return [];
  return result.Items.map(item => unmarshall(item) as AgentSession);
}

export async function getLatestSession(userId: string): Promise<AgentSession | null> {
  const sessions = await getUserSessions(userId, 1);
  return sessions.length > 0 ? sessions[0] : null;
}
