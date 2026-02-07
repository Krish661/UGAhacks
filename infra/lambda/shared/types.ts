import { z } from 'zod';

// ============================================
// Zod Schemas for Data Validation
// ============================================

// User Profile
export const UserProfileSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  role: z.enum(['supplier', 'recipient', 'driver', 'compliance', 'operator', 'admin']),
  name: z.string().optional(),
  phone: z.string().optional(),
  address: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zip: z.string(),
    country: z.string().default('USA'),
  }),
  // Geocoded location (automatically filled when address is saved)
  location: z.object({
    lat: z.number(),
    lon: z.number(),
    placeName: z.string(),
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// Listing Status
export const ListingStatus = z.enum([
  'DRAFT',
  'POSTED',
  'MATCHED',
  'SCHEDULED',
  'PICKED_UP',
  'DELIVERED',
  'CANCELED',
  'EXPIRED'
]);

export type ListingStatusType = z.infer<typeof ListingStatus>;

// Listing
export const ListingSchema = z.object({
  listingId: z.string(),
  donorId: z.string(),
  category: z.string(),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string(), // e.g., "lbs", "meals", "items"
  pickupWindowStart: z.string(), // ISO timestamp
  pickupWindowEnd: z.string(), // ISO timestamp
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  expiresAt: z.string().optional(), // ISO timestamp
  storageConstraint: z.enum(['REFRIGERATED', 'FROZEN', 'SHELF_STABLE', 'HOT']).optional(),
  pickupBy: z.enum(['donor', 'receiver']).default('receiver'),
  // Pickup location (geocoded from donor's profile address)
  pickupLocation: z.object({
    lat: z.number(),
    lon: z.number(),
    placeName: z.string(),
  }).optional(),
  status: ListingStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().optional(),
  // Fields suggested by agent
  suggestedFields: z.record(z.any()).optional(),
  missingFields: z.array(z.string()).optional(),
});

export type Listing = z.infer<typeof ListingSchema>;

// Draft Listing Input (partial)
export const DraftListingInputSchema = z.object({
  freeText: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().positive().optional(),
  unit: z.string().optional(),
  pickupWindowStart: z.string().optional(),
  pickupWindowEnd: z.string().optional(),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  expiresAt: z.string().optional(),
  storageConstraint: z.enum(['REFRIGERATED', 'FROZEN', 'SHELF_STABLE', 'HOT']).optional(),
  pickupBy: z.enum(['donor', 'receiver']).optional(),
});

export type DraftListingInput = z.infer<typeof DraftListingInputSchema>;

// Need Request
export const NeedRequestSchema = z.object({
  requestId: z.string(),
  receiverId: z.string(),
  category: z.string(),
  quantity: z.number().positive().optional(),
  unit: z.string().optional(),
  restrictions: z.array(z.string()).optional(), // e.g., ["no-nuts", "kosher"]
  availableHours: z.string().optional(),
  status: z.enum(['ACTIVE', 'MATCHED', 'FULFILLED', 'CANCELED']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type NeedRequest = z.infer<typeof NeedRequestSchema>;

// Match (Hybrid Architecture)
export const MatchSchema = z.object({
  matchId: z.string(),
  listingId: z.string(),
  donorId: z.string(),
  receiverId: z.string(),
  score: z.number().min(0).max(100),
  reasons: z.array(z.string()),
  status: z.enum(['SUGGESTED', 'ACCEPTED', 'EXPIRED', 'WITHDRAWN']),
  suggestedAt: z.string(), // ISO timestamp
  acceptedAt: z.string().optional(), // ISO timestamp
  expiresAt: z.string(), // ISO timestamp (24h from suggestedAt)
  ttlEpochSeconds: z.number(), // DynamoDB TTL
  // Snapshot of listing at match time
  listingSnapshot: z.object({
    category: z.string(),
    quantity: z.number(),
    unit: z.string(),
    pickupWindowStart: z.string(),
    pickupWindowEnd: z.string(),
    storageConstraint: z.string().optional(),
    urgency: z.string(),
  }).optional(),
});

export type Match = z.infer<typeof MatchSchema>;

// Event (for polling sync)
export const EventSchema = z.object({
  eventId: z.string(),
  userId: z.string(),
  entityType: z.enum(['PROFILE', 'LISTING', 'REQUEST', 'MATCH']),
  entityId: z.string(),
  eventType: z.string(), // e.g., "profile.updated", "listing.posted"
  payload: z.record(z.any()),
  createdAt: z.string(),
});

export type Event = z.infer<typeof EventSchema>;

// ============================================
// DynamoDB Key Patterns
// ============================================

export const KeyPatterns = {
  profile: (userId: string) => ({
    pk: `PROFILE#${userId}`,
    sk: 'PROFILE',
  }),
  listing: (listingId: string) => ({
    pk: `LISTING#${listingId}`,
    sk: 'META',
  }),
  userListing: (userId: string, listingId: string) => ({
    pk: `USER#${userId}`,
    sk: `LISTING#${listingId}`,
  }),
  request: (requestId: string) => ({
    pk: `REQUEST#${requestId}`,
    sk: 'META',
  }),
  userRequest: (userId: string, requestId: string) => ({
    pk: `USER#${userId}`,
    sk: `REQUEST#${requestId}`,
  }),
  match: (matchId: string) => ({
    pk: `MATCH#${matchId}`,
    sk: 'META',
  }),
  // Receiver feed index: query matches for a receiver sorted by status+score
  receiverMatch: (receiverId: string, status: string, score: number, createdAt: string, matchId: string) => ({
    pk: `RECEIVER#${receiverId}`,
    sk: `MATCH#${status}#${String(100 - score).padStart(3, '0')}#${createdAt}#${matchId}`,
  }),
  // Listing interest index: query matches for a listing sorted by status+score
  listingMatch: (listingId: string, status: string, score: number, createdAt: string, matchId: string) => ({
    pk: `LISTING#${listingId}`,
    sk: `MATCH#${status}#${String(100 - score).padStart(3, '0')}#${createdAt}#${matchId}`,
  }),
  userEvent: (userId: string, timestamp: string) => ({
    pk: `USER#${userId}`,
    sk: `EVENT#${timestamp}`,
  }),
  // For querying posted listings by category
  categoryListing: (category: string, listingId: string) => ({
    pk: `CATEGORY#${category}`,
    sk: `LISTING#${listingId}`,
  }),
};

// ============================================
// API Response Types
// ============================================

export interface ApiResponse {
  statusCode: number;
  body: string; // JSON stringified
  headers: {
    'Content-Type': string;
    'Access-Control-Allow-Origin': string;
    'Access-Control-Allow-Headers': string;
    'Access-Control-Allow-Methods': string;
  };
}

export interface ErrorResponse {
  error: string;
  message: string;
  details?: any;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
}

// Agent Response for Draft Listing
export interface AgentDraftResponse {
  listingId: string;
  status: 'DRAFT';
  proposedSummary: string;
  suggestedFields: Partial<Listing>;
  missingFields: string[];
  confidence: number; // 0-100
}
