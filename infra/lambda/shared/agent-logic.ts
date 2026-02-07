import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  AgentSession,
  AgentRoleType,
  AgentIntentType,
  NextQuestion,
  SummaryCard,
  DONOR_LISTING_REQUIRED_FIELDS,
  RECEIVER_REQUEST_REQUIRED_FIELDS,
  FIELD_METADATA,
} from './agent-types';

const secretsClient = new SecretsManagerClient({});
const SECRET_NAME = '/swarmaid/gemini-api-key';

let cachedApiKey: string | null = null;

// ============================================
// Initialize Gemini API Key
// ============================================

async function getGeminiApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  const result = await secretsClient.send(new GetSecretValueCommand({
    SecretId: SECRET_NAME,
  }));
  cachedApiKey = result.SecretString!;
  return cachedApiKey;
}

// ============================================
// Call Gemini REST API
// ============================================

async function callGeminiAPI(prompt: string): Promise<string> {
  const apiKey = await getGeminiApiKey();
  
  // Try models in order of preference
  const models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
  
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 400,
          }
        })
      });

      if (!response.ok) {
        console.log(`Gemini model ${model} failed: ${response.status}`);
        continue;
      }

      const data = await response.json() as any;
      
      if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        console.log(`Gemini succeeded with model: ${model}`);
        return data.candidates[0].content.parts[0].text;
      }
      
      console.log(`Gemini model ${model} returned invalid structure`);
    } catch (error) {
      console.log(`Gemini model ${model} error:`, error instanceof Error ? error.message : 'unknown');
    }
  }
  
  throw new Error('All Gemini models failed');
}

// ============================================
// Intent Detection
// ============================================

export async function detectIntent(message: string): Promise<{
  role: AgentRoleType;
  intent: AgentIntentType;
  extractedFields: Record<string, any>;
  confidence: number;
}> {
  try {
    const prompt = `You are a food donation assistant. Extract structured data from user messages and return ONLY valid JSON (no markdown, no explanation).

User message: "${message}"

Return JSON with this exact schema:
{
  "role": "donor" | "receiver" | null,
  "intent": "create_listing" | "create_request" | "browse_deals" | null,
  "extractedFields": {
    "category": string | null,
    "quantity": number | null,
    "unit": string | null,
    "pickupWindowStart": string | null,
    "pickupWindowEnd": string | null,
    "storageConstraint": "none" | "refrigerated" | "frozen" | "hot" | null,
    "pickupBy": "donor" | "receiver" | null,
    "urgency": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null
  }
}

Rules:
- If user says "donate", "give", "have surplus" → role=donor, intent=create_listing
- If user says "need", "request", "looking for" → role=receiver, intent=create_request
- Map food items to categories: apples/produce→"produce", milk/cheese→"dairy", sandwiches/meals→"prepared-meals"
- Parse times like "today 2-6pm" to ISO timestamps (use current date)
- "refrigerated", "cold", "fridge" → storageConstraint="refrigerated"
- "receiver picks up", "they pick up" → pickupBy="receiver"
- "I will deliver", "we deliver" → pickupBy="donor"

Return ONLY the JSON object.`;

    const responseText = await callGeminiAPI(prompt);
    
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('Gemini returned non-JSON response, using fallback');
      return detectIntentFallback(message);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      role: parsed.role || 'unknown',
      intent: parsed.intent || 'unknown',
      extractedFields: parsed.extractedFields || {},
      confidence: 90,
    };
  } catch (error) {
    console.log('Gemini intent detection failed:', error instanceof Error ? error.message : 'unknown');
    return detectIntentFallback(message);
  }
}

function detectIntentFallback(message: string): {
  role: AgentRoleType;
  intent: AgentIntentType;
  extractedFields: Record<string, any>;
  confidence: number;
} {
  const lower = message.toLowerCase();

  // Role detection
  let role: AgentRoleType = 'unknown';
  if (lower.match(/\b(donat|give|have|surplus|extra|offer)\b/)) {
    role = 'donor';
  } else if (lower.match(/\b(need|want|look|request|food bank|shelter)\b/)) {
    role = 'receiver';
  }

  // Intent detection - default to create flow if role detected
  let intent: AgentIntentType = 'unknown';
  if (lower.match(/\b(accept|take|claim)\b.*\b(match|offer|deal)\b/)) {
    intent = 'accept_match';
  } else if (lower.match(/\b(cancel|delete|remove)\b.*\b(listing|post|donation)\b/)) {
    intent = 'cancel_listing';
  } else if (lower.match(/\b(change|update|modify)\b.*\b(time|pickup|window)\b/)) {
    intent = 'update_pickup_time';
  } else if (role === 'donor') {
    intent = 'create_listing';
  } else if (role === 'receiver' && lower.match(/\b(browse|see|view|deals|available)\b/)) {
    intent = 'browse_deals';
  } else if (role === 'receiver') {
    intent = 'create_request';
  } else if (lower.match(/\b(status|check|my|history)\b/)) {
    intent = 'check_status';
  } else {
    intent = 'general_query';
  }

  // Extract fields
  const extractedFields: Record<string, any> = {};
  
  // Extract quantity and unit
  const quantityMatch = lower.match(/(\d+)\s*(lbs?|pounds?|kg|kilograms?|meals?|servings?|boxes?|items?)/);
  if (quantityMatch) {
    extractedFields.quantity = parseInt(quantityMatch[1]);
    let unit = quantityMatch[2].toLowerCase();
    // Normalize units
    if (unit.match(/^(lb|lbs|pound|pounds)$/)) unit = 'lbs';
    else if (unit.match(/^(kg|kilogram|kilograms)$/)) unit = 'kg';
    else if (unit.match(/^(meal|meals)$/)) unit = 'meals';
    else if (unit.match(/^(serving|servings)$/)) unit = 'servings';
    else if (unit.match(/^(box|boxes)$/)) unit = 'boxes';
    else if (unit.match(/^(item|items)$/)) unit = 'items';
    extractedFields.unit = unit;
  }

  // Extract category from food keywords
  if (lower.match(/\b(apple|banana|orange|fruit|vegetable|produce|carrot|lettuce|tomato)\b/)) {
    extractedFields.category = 'produce';
  } else if (lower.match(/\b(bread|pastry|bakery|muffin|bagel|donut)\b/)) {
    extractedFields.category = 'baked-goods';
  } else if (lower.match(/\b(meal|cooked|prepared|sandwich|tray|plate)\b/)) {
    extractedFields.category = 'prepared-meals';
  } else if (lower.match(/\b(milk|cheese|dairy|yogurt|butter|cream)\b/)) {
    extractedFields.category = 'dairy';
  } else if (lower.match(/\b(meat|chicken|beef|pork|fish|turkey)\b/)) {
    extractedFields.category = 'meat';
  } else if (lower.match(/\b(can|canned|jar|jarred|non-perishable)\b/)) {
    extractedFields.category = 'canned-goods';
  }

  // Extract pickupBy
  if (lower.match(/\b(receiver|they|them|recipient)\s+(pick|pickup|picks|will pick)/)) {
    extractedFields.pickupBy = 'receiver';
  } else if (lower.match(/\b(receiver|buyer|recipient)\s+should\s+pick/)) {
    extractedFields.pickupBy = 'receiver';
  } else if (lower.match(/\b(i|we|donor)\s+(will\s+)?(deliver|drop\s*off|bring)/)) {
    extractedFields.pickupBy = 'donor';
  } else if (lower.match(/\b(deliver|delivery|drop\s*off)\b/) && !lower.match(/no\s+deliver/)) {
    extractedFields.pickupBy = 'donor';
  }

  // Extract description
  // Look for labeled format first: "description: ..."
  const descLabelMatch = message.match(/description\s*:\s*([^\n]+)/i);
  if (descLabelMatch) {
    extractedFields.description = descLabelMatch[1].trim();
  } else {
    // Fallback: Look for food-related content
    const foodMatch = message.match(/(?:fresh|about|roughly|approximately)?\s*\d+\s*(?:lbs?|kg|pounds?)(?:\s+of)?\s+([a-z ]+)/i);
    if (foodMatch) {
      // Extract food item and surrounding context
      extractedFields.description = message.trim();
    } else if (message.length > 10 && message.length < 500) {
      // Use trimmed message as description if reasonable length
      extractedFields.description = message.trim();
    }
  }

  // Extract storageConstraint
  // Check for labeled formats first
  const storageLabelMatch = message.match(/(?:storage\s*(?:requirement|constraint)?|storageConstraint)\s*:\s*(\w+)/i);
  if (storageLabelMatch) {
    const storageValue = storageLabelMatch[1].toLowerCase();
    if (storageValue.match(/refrigerat|fridge|cold|chill/)) {
      extractedFields.storageConstraint = 'refrigerated';
    } else if (storageValue.match(/frozen|freezer/)) {
      extractedFields.storageConstraint = 'frozen';
    } else if (storageValue.match(/room|none|shelf/)) {
      extractedFields.storageConstraint = 'none';
    } else if (storageValue.match(/hot|warm|heated/)) {
      extractedFields.storageConstraint = 'hot';
    }
  } else {
    // Fallback to pattern matching
    if (lower.match(/\b(refrigerat|fridge|cold|chill|keep\s+cold)\b/) && !lower.match(/no\s+(refrigerat|fridge)/)) {
      extractedFields.storageConstraint = 'refrigerated';
    } else if (lower.match(/\b(frozen|freezer|ice)\b/)) {
      extractedFields.storageConstraint = 'frozen';
    } else if (lower.match(/\b(hot|warm|keep\s+warm|heated)\b/)) {
      extractedFields.storageConstraint = 'hot';
    } else if (lower.match(/\b(no\s+(refrigerat|fridge)|room\s+temp|shelf\s+stable)\b/)) {
      extractedFields.storageConstraint = 'none';
    }
  }

  // Extract pickup times
  const timeResult = extractPickupTimes(message);
  if (timeResult.pickupWindowStart) {
    extractedFields.pickupWindowStart = timeResult.pickupWindowStart;
  }
  if (timeResult.pickupWindowEnd) {
    extractedFields.pickupWindowEnd = timeResult.pickupWindowEnd;
  }

  // Extract urgency
  if (lower.match(/\b(urgent|asap|immediately|critical|emergency|expires?\s+(soon|today))\b/)) {
    extractedFields.urgency = 'CRITICAL';
  } else if (lower.match(/\b(high|important|soon|priority)\b/)) {
    extractedFields.urgency = 'HIGH';
  } else if (lower.match(/\b(low|whenever|no\s+rush)\b/)) {
    extractedFields.urgency = 'LOW';
  }

  return { role, intent, extractedFields, confidence: 60 };
}

// ============================================
// Time Parsing Helper
// ============================================

function extractPickupTimes(message: string): {
  pickupWindowStart: string | null;
  pickupWindowEnd: string | null;
} {
  const lower = message.toLowerCase();
  
  // America/New_York is EST (UTC-5) during standard time, EDT (UTC-4) during daylight time
  // For simplicity, using EST offset. To convert ET → UTC: add 5 hours
  const EST_TO_UTC_OFFSET_HOURS = 5;
  
  // Get current date in Eastern Time
  // Lambda runs in UTC, so calculate ET by subtracting offset
  const now = new Date();
  const nowETMillis = now.getTime() - (EST_TO_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const nowET = new Date(nowETMillis);
  
  // Extract date components for "today" in ET
  let year = nowET.getUTCFullYear();
  let month = nowET.getUTCMonth();
  let day = nowET.getUTCDate();
  
  // Check for tomorrow
  if (lower.match(/\btomorrow\b/)) {
    const tomorrow = new Date(Date.UTC(year, month, day + 1));
    year = tomorrow.getUTCFullYear();
    month = tomorrow.getUTCMonth();
    day = tomorrow.getUTCDate();
  }
  
  // Extract time patterns
  // Pattern: "2pm to 6pm", "2-6pm", "2:00pm-6:00pm", "14:00-18:00"
  const timeRangeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*(?:to|-|until|–)\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/);
  
  if (timeRangeMatch) {
    const [_, startHourStr, startMinStr, startMeridiem, endHourStr, endMinStr, endMeridiem] = timeRangeMatch;
    
    // Parse start time in ET
    let startH = parseInt(startHourStr);
    const meridiem = startMeridiem || endMeridiem; // Inherit from end if start missing
    if (meridiem === 'pm' && startH !== 12) startH += 12;
    if (meridiem === 'am' && startH === 12) startH = 0;
    const startM = startMinStr ? parseInt(startMinStr) : 0;
    
    // Parse end time in ET
    let endH = parseInt(endHourStr);
    if (endMeridiem === 'pm' && endH !== 12) endH += 12;
    if (endMeridiem === 'am' && endH === 12) endH = 0;
    const endM = endMinStr ? parseInt(endMinStr) : 0;
    
    // Create UTC timestamps: ET hour + offset = UTC hour
    // Example: 2pm ET (14:00) + 5 hours = 19:00 UTC
    let startUTC = Date.UTC(year, month, day, startH + EST_TO_UTC_OFFSET_HOURS, startM);
    let endUTC = Date.UTC(year, month, day, endH + EST_TO_UTC_OFFSET_HOURS, endM);
    
    // Ensure start <= end (swap if necessary)
    if (startUTC > endUTC) {
      [startUTC, endUTC] = [endUTC, startUTC];
    }
    
    return {
      pickupWindowStart: new Date(startUTC).toISOString(),
      pickupWindowEnd: new Date(endUTC).toISOString(),
    };
  }
  
  // Single time pattern: "2pm", "14:00"
  const singleTimeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/);
  if (singleTimeMatch) {
    const [_, hourStr, minStr, meridiem] = singleTimeMatch;
    let h = parseInt(hourStr);
    if (meridiem === 'pm' && h !== 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    const m = minStr ? parseInt(minStr) : 0;
    
    const startUTC = Date.UTC(year, month, day, h + EST_TO_UTC_OFFSET_HOURS, m);
    
    return {
      pickupWindowStart: new Date(startUTC).toISOString(),
      pickupWindowEnd: null,
    };
  }
  
  return {
    pickupWindowStart: null,
    pickupWindowEnd: null,
  };
}

// ============================================
// Field Extraction
// ============================================

export async function extractFields(
  message: string,
  missingFields: string[]
): Promise<{
  extractedFields: Record<string, any>;
  confidence: number;
}> {
  if (missingFields.length === 0) {
    return { extractedFields: {}, confidence: 100 };
  }

  // Always run deterministic fallback first
  const fallback = detectIntentFallback(message);
  let extractedFields = fallback.extractedFields;
  let confidence = 60;

  // Try Gemini enhancement
  try {
    const prompt = `You are a food donation assistant. Extract ONLY the specified fields from the user's message. Return ONLY valid JSON.

User message: "${message}"

Fields needed: ${missingFields.join(', ')}

Return JSON:
{
  "extractedFields": {
    "category": string | null,
    "quantity": number | null,
    "unit": string | null,
    "pickupWindowStart": string | null,
    "pickupWindowEnd": string | null,
    "storageConstraint": "none" | "refrigerated" | "frozen" | "hot" | null,
    "pickupBy": "donor" | "receiver" | null,
    "urgency": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null
  }
}

Only include fields that are mentioned in the message. Parse times to ISO format. Return ONLY the JSON.`;

    const responseText = await callGeminiAPI(prompt);

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const geminiFields = parsed.extractedFields || {};
      
      // Merge: prefer Gemini's non-null values, but keep fallback values if Gemini returns null
      extractedFields = { ...extractedFields };
      for (const key in geminiFields) {
        if (geminiFields[key] !== null && geminiFields[key] !== undefined) {
          extractedFields[key] = geminiFields[key];
        }
      }
      
      confidence = 90;
    } else {
      console.log('Gemini field extraction returned non-JSON, using fallback only');
    }
  } catch (error) {
    console.log('Gemini field extraction failed:', error instanceof Error ? error.message : 'unknown');
    // Fallback already set above
  }

  return { extractedFields, confidence };
}

// ============================================
// Question Generation (Deterministic)
// ============================================

export function determineNextQuestion(
  session: AgentSession
): NextQuestion | null {
  const requiredFields = session.intent === 'create_listing'
    ? DONOR_LISTING_REQUIRED_FIELDS
    : session.intent === 'create_request'
    ? RECEIVER_REQUEST_REQUIRED_FIELDS
    : [];

  if (requiredFields.length === 0) return null;

  // Find first missing field that hasn't been asked yet
  const missingNotAsked = session.missingFields.filter(
    field => !session.askedFields.includes(field)
  );

  if (missingNotAsked.length === 0) return null;

  const nextField = missingNotAsked[0];
  const metadata = FIELD_METADATA[nextField];

  if (!metadata) {
    console.warn(`No metadata for field: ${nextField}`);
    return null;
  }

  return {
    field: nextField,
    prompt: metadata.prompt,
    choices: metadata.choices,
    fieldType: metadata.fieldType,
  };
}

// ============================================
// Generate Conversational Response
// ============================================

export async function generateResponse(
  session: AgentSession,
  nextQuestion: NextQuestion | null
): Promise<string> {
  if (!nextQuestion) {
    return "Great! I have all the information I need. Ready to confirm?";
  }

  try {
    const prompt = `You are a friendly food donation assistant. Generate a natural conversational question.

Context:
- User role: ${session.role}
- Intent: ${session.intent}
- Fields collected so far: ${JSON.stringify(session.collectedFields)}

Next field needed: ${nextQuestion.field}
Default question: "${nextQuestion.prompt}"

Generate a friendly, conversational version of this question. Keep it brief (1-2 sentences). Return ONLY the question text as a JSON object:
{
  "message": "your question here"
}`;

    const responseText = await callGeminiAPI(prompt);

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('Gemini response generation returned non-JSON, using default');
      return nextQuestion.prompt;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.message || nextQuestion.prompt;
  } catch (error) {
    console.log('Gemini response generation failed:', error instanceof Error ? error.message : 'unknown');
    // Fallback to direct prompt
    return nextQuestion.prompt;
  }
}

// ============================================
// Update Session with New Fields
// ============================================

export function updateSessionFields(
  session: AgentSession,
  newFields: Record<string, any>
): AgentSession {
  // Merge new fields, but never overwrite non-null values with null
  const updatedFields = { ...session.collectedFields };
  
  for (const key in newFields) {
    const newValue = newFields[key];
    const existingValue = updatedFields[key];
    
    // Only update if new value is non-null, or if no existing value
    if (newValue !== null && newValue !== undefined && newValue !== '') {
      updatedFields[key] = newValue;
    } else if (existingValue === undefined || existingValue === null || existingValue === '') {
      // Only overwrite if existing is also empty
      updatedFields[key] = newValue;
    }
    // Otherwise, keep existing non-null value
  }

  // Determine required fields based on intent
  const requiredFields = session.intent === 'create_listing'
    ? DONOR_LISTING_REQUIRED_FIELDS
    : session.intent === 'create_request'
    ? RECEIVER_REQUEST_REQUIRED_FIELDS
    : [];

  // Calculate missing fields
  const missingFields = requiredFields.filter(
    field => !updatedFields[field] || updatedFields[field] === ''
  );

  return {
    ...session,
    collectedFields: updatedFields,
    missingFields,
    updatedAt: new Date().toISOString(),
  };
}

// ============================================
// Generate Summary Card
// ============================================

export function generateSummaryCard(session: AgentSession): SummaryCard {
  const requiredFields = session.intent === 'create_listing'
    ? DONOR_LISTING_REQUIRED_FIELDS
    : session.intent === 'create_request'
    ? RECEIVER_REQUEST_REQUIRED_FIELDS
    : [];

  const fields = requiredFields.map(fieldKey => {
    const metadata = FIELD_METADATA[fieldKey] || { label: fieldKey };
    const value = session.collectedFields[fieldKey];
    const confirmed = value !== undefined && value !== '';

    return {
      label: metadata.label,
      value: confirmed ? String(value) : '(pending)',
      confirmed,
    };
  });

  const confirmedCount = fields.filter(f => f.confirmed).length;
  const progress = requiredFields.length > 0
    ? Math.round((confirmedCount / requiredFields.length) * 100)
    : 0;

  const title = session.intent === 'create_listing'
    ? 'Food Donation Listing'
    : session.intent === 'create_request'
    ? 'Food Request'
    : 'Summary';

  return {
    title,
    fields,
    progress,
  };
}
