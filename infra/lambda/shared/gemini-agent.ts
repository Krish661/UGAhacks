import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { DraftListingInput, Listing, AgentDraftResponse } from './types';

const secretsClient = new SecretsManagerClient({});
const SECRET_NAME = '/swarmaid/gemini-api-key';

let cachedApiKey: string | null = null;
let genAI: GoogleGenerativeAI | null = null;

// ============================================
// Initialize Gemini API
// ============================================

async function initializeGemini(): Promise<GoogleGenerativeAI> {
  if (genAI) return genAI;

  if (!cachedApiKey) {
    const result = await secretsClient.send(new GetSecretValueCommand({
      SecretId: SECRET_NAME,
    }));
    cachedApiKey = result.SecretString!;
  }

  genAI = new GoogleGenerativeAI(cachedApiKey);
  return genAI;
}

// ============================================
// Agent: Analyze Draft Listing
// ============================================

export async function analyzeDraftListing(
  input: DraftListingInput,
  donorId: string
): Promise<AgentDraftResponse> {
  const ai = await initializeGemini();
  const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Build prompt for Gemini
  const prompt = buildAnalysisPrompt(input);

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // Parse Gemini's structured response
    const parsed = parseGeminiResponse(responseText);
    
    // Merge with user input
    const suggestedFields = {
      ...parsed.suggestedFields,
      ...filterDefinedFields(input),
    };

    // Determine missing required fields
    const missingFields = findMissingFields(suggestedFields);

    return {
      listingId: `LISTING#${Date.now()}-${donorId.substring(0, 8)}`,
      status: 'DRAFT',
      proposedSummary: parsed.summary,
      suggestedFields: suggestedFields as Partial<Listing>,
      missingFields,
      confidence: parsed.confidence,
    };
  } catch (error) {
    console.error('Gemini API error:', error);
    // Fallback: basic field extraction
    return createFallbackResponse(input, donorId);
  }
}

// ============================================
// Prompt Engineering
// ============================================

function buildAnalysisPrompt(input: DraftListingInput): string {
  return `You are a food surplus donation assistant. A donor wants to donate food and has provided the following information:

${input.freeText ? `Free-form description: "${input.freeText}"` : ''}
${input.category ? `Category: ${input.category}` : ''}
${input.description ? `Description: ${input.description}` : ''}
${input.quantity ? `Quantity: ${input.quantity} ${input.unit || ''}` : ''}
${input.pickupWindowStart ? `Pickup starts: ${input.pickupWindowStart}` : ''}
${input.pickupWindowEnd ? `Pickup ends: ${input.pickupWindowEnd}` : ''}
${input.urgency ? `Urgency: ${input.urgency}` : ''}
${input.storageConstraint ? `Storage: ${input.storageConstraint}` : ''}

Your task:
1. Extract and normalize the following fields:
   - category: Food category (e.g., "produce", "bakery", "prepared-meals", "dairy", "meat", "pantry-staples")
   - description: Clear, concise description
   - quantity: Numeric value
   - unit: Unit of measurement ("lbs", "meals", "items", "servings", "boxes")
   - urgency: LOW, MEDIUM, HIGH, or CRITICAL
   - storageConstraint: REFRIGERATED, FROZEN, SHELF_STABLE, or HOT
   - pickupWindowStart: ISO 8601 timestamp (infer from text if possible)
   - pickupWindowEnd: ISO 8601 timestamp (infer from text if possible)

2. Provide a confidence score (0-100) for your extraction.

3. Write a one-sentence summary of the donation suitable for receivers to see.

Respond ONLY with valid JSON in this exact format:
{
  "category": "...",
  "description": "...",
  "quantity": 10,
  "unit": "...",
  "urgency": "MEDIUM",
  "storageConstraint": "REFRIGERATED",
  "pickupWindowStart": "2024-01-15T10:00:00Z",
  "pickupWindowEnd": "2024-01-15T18:00:00Z",
  "summary": "...",
  "confidence": 85
}

If a field cannot be determined, omit it from the JSON. Do not include any text before or after the JSON object.`;
}

// ============================================
// Response Parsing
// ============================================

interface GeminiParsedResponse {
  suggestedFields: Partial<Listing>;
  summary: string;
  confidence: number;
}

function parseGeminiResponse(text: string): GeminiParsedResponse {
  try {
    // Extract JSON from response (handle code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      suggestedFields: {
        category: parsed.category,
        description: parsed.description,
        quantity: parsed.quantity,
        unit: parsed.unit,
        urgency: parsed.urgency,
        storageConstraint: parsed.storageConstraint,
        pickupWindowStart: parsed.pickupWindowStart,
        pickupWindowEnd: parsed.pickupWindowEnd,
      },
      summary: parsed.summary || 'Food donation available for pickup',
      confidence: parsed.confidence || 50,
    };
  } catch (error) {
    console.error('Failed to parse Gemini response:', error);
    throw error;
  }
}

// ============================================
// Field Validation & Completion
// ============================================

function filterDefinedFields(input: DraftListingInput): Partial<Listing> {
  const result: any = {};
  if (input.category) result.category = input.category;
  if (input.description) result.description = input.description;
  if (input.quantity) result.quantity = input.quantity;
  if (input.unit) result.unit = input.unit;
  if (input.urgency) result.urgency = input.urgency;
  if (input.storageConstraint) result.storageConstraint = input.storageConstraint;
  if (input.pickupWindowStart) result.pickupWindowStart = input.pickupWindowStart;
  if (input.pickupWindowEnd) result.pickupWindowEnd = input.pickupWindowEnd;
  if (input.pickupBy) result.pickupBy = input.pickupBy;
  if (input.expiresAt) result.expiresAt = input.expiresAt;
  return result;
}

function findMissingFields(fields: Partial<Listing>): string[] {
  const required = ['category', 'description', 'quantity', 'unit', 'pickupWindowStart', 'pickupWindowEnd'];
  return required.filter(field => !fields[field as keyof Listing]);
}

// ============================================
// Fallback Logic (if Gemini fails)
// ============================================

function createFallbackResponse(input: DraftListingInput, donorId: string): AgentDraftResponse {
  const suggestedFields = filterDefinedFields(input);
  const missingFields = findMissingFields(suggestedFields);

  return {
    listingId: `LISTING#${Date.now()}-${donorId.substring(0, 8)}`,
    status: 'DRAFT',
    proposedSummary: input.description || input.freeText || 'Food donation available',
    suggestedFields: suggestedFields as Partial<Listing>,
    missingFields,
    confidence: 30, // Low confidence for fallback
  };
}

// ============================================
// Category Normalization
// ============================================

export const STANDARD_CATEGORIES = [
  'produce',
  'bakery',
  'prepared-meals',
  'dairy',
  'meat',
  'pantry-staples',
  'beverages',
  'other',
];

export function normalizeCategory(category: string): string {
  const lower = category.toLowerCase().trim();
  
  const mapping: Record<string, string> = {
    'fruit': 'produce',
    'fruits': 'produce',
    'vegetables': 'produce',
    'veggies': 'produce',
    'bread': 'bakery',
    'pastries': 'bakery',
    'baked goods': 'bakery',
    'milk': 'dairy',
    'cheese': 'dairy',
    'yogurt': 'dairy',
    'chicken': 'meat',
    'beef': 'meat',
    'pork': 'meat',
    'fish': 'meat',
    'seafood': 'meat',
    'canned': 'pantry-staples',
    'dry goods': 'pantry-staples',
    'drinks': 'beverages',
  };

  return mapping[lower] || (STANDARD_CATEGORIES.includes(lower) ? lower : 'other');
}
