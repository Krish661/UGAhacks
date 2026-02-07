import { z } from 'zod';

// ============================================
// Agent Session Types
// ============================================

export const AgentRole = z.enum(['donor', 'receiver', 'unknown']);
export type AgentRoleType = z.infer<typeof AgentRole>;

export const AgentIntent = z.enum([
  'create_listing',
  'browse_deals',
  'create_request',
  'check_status',
  'accept_match',
  'cancel_listing',
  'update_pickup_time',
  'general_query',
  'unknown',
]);
export type AgentIntentType = z.infer<typeof AgentIntent>;

// Agent Session Schema
export const AgentSessionSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  role: AgentRole,
  intent: AgentIntent,
  collectedFields: z.record(z.any()), // Dynamic fields based on intent
  missingFields: z.array(z.string()),
  askedFields: z.array(z.string()), // Track what we've already asked
  lastQuestion: z.string().optional(),
  draftListingId: z.string().optional(),
  draftRequestId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  conversationHistory: z.array(z.object({
    timestamp: z.string(),
    userMessage: z.string(),
    agentResponse: z.string(),
  })).optional(),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

// ============================================
// Agent Message Request/Response
// ============================================

export const AgentMessageRequestSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
});

export type AgentMessageRequest = z.infer<typeof AgentMessageRequestSchema>;

export interface NextQuestion {
  field: string;
  prompt: string;
  choices?: string[];
  fieldType: 'text' | 'number' | 'datetime' | 'choice';
}

export interface SummaryCard {
  title: string;
  fields: Array<{
    label: string;
    value: string;
    confirmed: boolean;
  }>;
  progress: number; // 0-100
}

export interface AgentMessageResponse {
  sessionId: string;
  role: AgentRoleType;
  intent: AgentIntentType;
  message: string; // Agent's conversational response
  proposedFields: Record<string, any>;
  missingFields: string[];
  nextQuestion?: NextQuestion;
  summaryCard?: SummaryCard;
  isComplete: boolean; // All required fields collected
}

// ============================================
// Agent Confirm Request/Response
// ============================================

export const AgentConfirmRequestSchema = z.object({
  sessionId: z.string(),
  finalEdits: z.record(z.any()).optional(), // Last-minute field updates
});

export type AgentConfirmRequest = z.infer<typeof AgentConfirmRequestSchema>;

export interface AgentConfirmResponse {
  entityId: string; // listingId or requestId
  entityType: 'listing' | 'request' | 'query';
  status: string; // DRAFT, POSTED, ACTIVE
  summary: string;
}

// ============================================
// DynamoDB Key Patterns
// ============================================

export const AgentKeyPatterns = {
  session: (userId: string, sessionId: string) => ({
    pk: `AGENTSESSION#${userId}`,
    sk: `SESSION#${sessionId}`,
  }),
  userSessions: (userId: string) => ({
    pk: `AGENTSESSION#${userId}`,
    sk: 'SESSION#',
  }),
};

// ============================================
// Field Requirements (Deterministic)
// ============================================

export const DONOR_LISTING_REQUIRED_FIELDS = [
  'category',
  'description',
  'quantity',
  'unit',
  'pickupWindowStart',
  'pickupWindowEnd',
  'storageConstraint',
  'pickupBy',
];

export const RECEIVER_REQUEST_REQUIRED_FIELDS = [
  'category',
  'quantity',
  'unit',
];

export const FIELD_METADATA: Record<string, {
  label: string;
  fieldType: 'text' | 'number' | 'datetime' | 'choice';
  choices?: string[];
  prompt: string;
}> = {
  category: {
    label: 'Food Category',
    fieldType: 'choice',
    choices: ['produce', 'bakery', 'prepared-meals', 'dairy', 'meat', 'pantry-staples', 'beverages', 'other'],
    prompt: 'What category of food is this?',
  },
  description: {
    label: 'Description',
    fieldType: 'text',
    prompt: 'Please describe the food items you\'re donating.',
  },
  quantity: {
    label: 'Quantity',
    fieldType: 'number',
    prompt: 'How much food do you have?',
  },
  unit: {
    label: 'Unit',
    fieldType: 'choice',
    choices: ['lbs', 'kg', 'meals', 'servings', 'boxes', 'items', 'gallons', 'liters'],
    prompt: 'What unit of measurement?',
  },
  pickupWindowStart: {
    label: 'Pickup Window Start',
    fieldType: 'datetime',
    prompt: 'When can someone start picking this up? (provide date and time)',
  },
  pickupWindowEnd: {
    label: 'Pickup Window End',
    fieldType: 'datetime',
    prompt: 'When is the latest pickup time? (provide date and time)',
  },
  storageConstraint: {
    label: 'Storage Requirement',
    fieldType: 'choice',
    choices: ['none', 'refrigerated', 'frozen', 'hot'],
    prompt: 'Does this food require refrigeration or special storage?',
  },
  pickupBy: {
    label: 'Who Handles Pickup',
    fieldType: 'choice',
    choices: ['donor', 'receiver'],
    prompt: 'Will you deliver, or should the receiver pick it up?',
  },
  urgency: {
    label: 'Urgency',
    fieldType: 'choice',
    choices: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    prompt: 'How urgent is this donation?',
  },
  restrictions: {
    label: 'Dietary Restrictions',
    fieldType: 'text',
    prompt: 'Any dietary restrictions or requirements? (e.g., kosher, halal, no nuts)',
  },
};

// ============================================
// Gemini Prompt Templates
// ============================================

export const GEMINI_PROMPTS = {
  intentDetection: (message: string) => `
Analyze this user message and determine their role and intent.

User message: "${message}"

Respond with ONLY valid JSON in this exact format:
{
  "role": "donor" | "receiver" | "unknown",
  "intent": "create_listing" | "browse_deals" | "create_request" | "check_status" | "general_query" | "unknown",
  "extractedFields": {
    // Any fields you can extract (category, quantity, description, etc.)
  },
  "confidence": 0-100
}

Role detection:
- "donor" if they mention: donating, giving away, have food, surplus, extra food
- "receiver" if they mention: need food, looking for, requesting, food bank, shelter

Intent detection:
- "create_listing" if donor wants to post available food
- "browse_deals" if receiver wants to see available food
- "create_request" if receiver wants to request specific food
- "check_status" if asking about existing listings/requests
- "general_query" for questions about the service

Extract any structured fields mentioned (category, quantity, time, location hints, etc.).
`,

  fieldExtraction: (message: string, missingFields: string[]) => `
Extract structured data from this user message. Focus only on these missing fields: ${missingFields.join(', ')}

User message: "${message}"

Respond with ONLY valid JSON in this exact format:
{
  "extractedFields": {
    // Only include fields you found in the message
  },
  "confidence": 0-100,
  "needsClarification": ["field1", "field2"] // fields that are ambiguous
}

Field extraction rules:
- category: produce, bakery, prepared-meals, dairy, meat, pantry-staples, beverages, other
- quantity: numeric value only
- unit: lbs, kg, meals, servings, boxes, items, gallons, liters
- description: brief summary of the food
- pickupWindowStart/End: parse dates/times, convert to ISO format if possible
- storageConstraint: none, refrigerated, frozen, hot
- pickupBy: donor (if they say "I'll deliver") or receiver (if they say "pickup")
- urgency: LOW, MEDIUM, HIGH, CRITICAL

Do not make up information. Only extract what is explicitly stated.
`,

  generateResponse: (role: string, intent: string, collectedFields: any, nextQuestion: string) => `
Generate a friendly, concise conversational response for a food donation assistant.

Context:
- User role: ${role}
- Current intent: ${intent}
- Already collected: ${JSON.stringify(collectedFields)}
- Next question to ask: ${nextQuestion}

Respond with ONLY valid JSON:
{
  "message": "A natural, conversational response that includes the next question",
  "tone": "friendly" | "urgent" | "clarifying"
}

Keep responses under 50 words. Be warm but efficient.
Examples:
- "Great! I understand you have produce to donate. How much do you have?"
- "Perfect. When would be the earliest time for pickup?"
- "Got it. Does this food need to stay refrigerated, or is it shelf-stable?"
`,
};
