import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';
import { ServiceUnavailableError } from '../shared/errors';

const logger = createLogger('GeminiService');

export interface EnrichmentResult {
  normalizedCategory?: string;
  extractedCategories?: string[];
  handlingRequirements?: string[];
  riskScore: number;
  riskFlags: string[];
  parsedNotes?: {
    quality?: string;
    packaging?: string;
    special?: string;
  };
  confidence: number;
  status: 'success' | 'degraded' | 'failed';
}

class GeminiService {
  private client?: GoogleGenerativeAI;
  private model?: GenerativeModel;
  private apiKey?: string;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Try to get API key from Secrets Manager
      if (config.secrets.geminiApiKey) {
        const secretsClient = new SecretsManagerClient({ region: config.aws.region });
        const response = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: config.secrets.geminiApiKey })
        );
        const secret = JSON.parse(response.SecretString || '{}');
        this.apiKey = secret.apiKey;
      }

      // Fallback to environment variable
      if (!this.apiKey || this.apiKey === 'placeholder') {
        this.apiKey = config.gemini.apiKey;
      }

      // If still stubbed, skip initialization
      if (this.apiKey === 'stubbed' || this.apiKey === 'placeholder') {
        logger.warn('Gemini API key is stubbed, using fallback mode');
        this.initialized = true;
        return;
      }

      this.client = new GoogleGenerativeAI(this.apiKey);
      this.model = this.client.getGenerativeModel({ model: config.gemini.model });
      this.initialized = true;

      logger.info('Gemini service initialized');
    } catch (error) {
      logger.error('Failed to initialize Gemini service', error as Error);
      this.initialized = true; // Mark as initialized to use fallback
    }
  }

  /**
   * Enrich a surplus listing with AI analysis
   */
  async enrichListing(listing: {
    title: string;
    description: string;
    category: string;
    qualityNotes?: string;
  }): Promise<EnrichmentResult> {
    await this.initialize();

    if (!this.model) {
      logger.warn('Gemini not available, using fallback enrichment');
      return this.fallbackEnrichment(listing);
    }

    try {
      const prompt = this.buildEnrichmentPrompt(listing);

      const result = await Promise.race([
        this.model.generateContent(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Gemini timeout')), config.gemini.timeout)
        ),
      ]) as any;

      const responseText = result.response.text();
      const parsed = this.parseEnrichmentResponse(responseText);

      logger.info('Listing enriched with Gemini', {
        title: listing.title,
        riskScore: parsed.riskScore,
        flags: parsed.riskFlags,
      });

      return {
        ...parsed,
        status: 'success',
      };
    } catch (error) {
      logger.error('Gemini enrichment failed, using fallback', error as Error);
      return {
        ...this.fallbackEnrichment(listing),
        status: 'degraded',
      };
    }
  }

  /**
   * Build enrichment prompt
   */
  private buildEnrichmentPrompt(listing: {
    title: string;
    description: string;
    category: string;
    qualityNotes?: string;
  }): string {
    return `You are a food safety and disaster relief expert. Analyze the following surplus listing and provide a structured assessment.

Title: ${listing.title}
Description: ${listing.description}
Category: ${listing.category}
Quality Notes: ${listing.qualityNotes || 'None'}

Please provide a JSON response with the following structure:
{
  "normalizedCategory": "one of: perishable_food, non_perishable_food, beverages, medical_supplies, hygiene_products, clothing, blankets, tents, water, baby_supplies, pet_supplies, cleaning_supplies, other",
  "extractedCategories": ["array of relevant categories"],
  "handlingRequirements": ["array of required handling instructions like 'refrigeration', 'fragile', 'hazmat'"],
  "riskScore": 0-100 (0 is safest, 100 is highest risk),
  "riskFlags": ["array of concerns like 'approaching_expiration', 'quality_concerns', 'handling_risk'"],
  "parsedNotes": {
    "quality": "summary of quality condition",
    "packaging": "packaging notes",
    "special": "special instructions"
  },
  "confidence": 0-100 (confidence in assessment)
}

Focus on food safety, handling requirements, and risk assessment. Be conservative with risk scoring.`;
  }

  /**
   * Parse Gemini response
   */
  private parseEnrichmentResponse(responseText: string): Omit<EnrichmentResult, 'status'> {
    try {
      // Extract JSON from response (Gemini might wrap it in markdown)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        normalizedCategory: parsed.normalizedCategory,
        extractedCategories: parsed.extractedCategories || [],
        handlingRequirements: parsed.handlingRequirements || [],
        riskScore: Math.min(Math.max(parsed.riskScore || 0, 0), 100),
        riskFlags: parsed.riskFlags || [],
        parsedNotes: parsed.parsedNotes,
        confidence: Math.min(Math.max(parsed.confidence || 50, 0), 100),
      };
    } catch (error) {
      logger.error('Failed to parse Gemini response', error as Error, { responseText });
      throw error;
    }
  }

  /**
   * Fallback enrichment using simple rules
   */
  private fallbackEnrichment(listing: {
    title: string;
    description: string;
    category: string;
    qualityNotes?: string;
  }): Omit<EnrichmentResult, 'status'> {
    const text = `${listing.title} ${listing.description} ${listing.qualityNotes || ''}`.toLowerCase();

    // Extract handling requirements
    const handlingRequirements: string[] = [];
    if (/refrigerat|cold|chill|freeze/i.test(text)) handlingRequirements.push('refrigeration');
    if (/fragile|delicate|glass/i.test(text)) handlingRequirements.push('fragile');
    if (/heavy|lift/i.test(text)) handlingRequirements.push('heavy');

    // Calculate basic risk score
    let riskScore = 0;
    const riskFlags: string[] = [];

    if (/expir|best.?by|use.?by/i.test(text)) {
      riskScore += 20;
      riskFlags.push('approaching_expiration');
    }

    if (/spoil|mold|damage|dent/i.test(text)) {
      riskScore += 30;
      riskFlags.push('quality_concerns');
    }

    if (/refrigerat|perishable/i.test(text)) {
      riskScore += 15;
      riskFlags.push('handling_risk');
    }

    if (/open|unsealed|broken/i.test(text)) {
      riskScore += 25;
      riskFlags.push('packaging_concerns');
    }

    return {
      normalizedCategory: listing.category,
      extractedCategories: [listing.category],
      handlingRequirements,
      riskScore: Math.min(riskScore, 100),
      riskFlags,
      confidence: 60, // Lower confidence for fallback
    };
  }
}

// Singleton instance
export const geminiService = new GeminiService();
