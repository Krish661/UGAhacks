import { z } from 'zod';

// Common schemas
export const coordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

export const addressSchema = z.object({
  street: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(2).max(2),
  zipCode: z.string().regex(/^\d{5}(-\d{4})?$/),
  country: z.string().default('US'),
});

export const timeWindowSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
});

export const notificationPreferencesSchema = z.object({
  email: z.boolean().default(true),
  sms: z.boolean().default(false),
  inApp: z.boolean().default(true),
  notificationTypes: z.array(z.enum([
    'match_proposed',
    'match_accepted',
    'scheduled',
    'en_route',
    'picked_up',
    'delivered',
    'canceled',
    'compliance_blocked',
  ])).default([
    'match_proposed',
    'match_accepted',
    'scheduled',
    'picked_up',
    'delivered',
    'canceled',
  ]),
});

// User Profile
export const userProfileSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  name: z.string().min(1),
  phone: z.string().optional(),
  roles: z.array(z.enum(['supplier', 'recipient', 'driver', 'compliance', 'operator', 'admin'])),
  organizationName: z.string().optional(),
  notificationPreferences: notificationPreferencesSchema.optional(),
  reliabilityScore: z.number().min(0).max(100).default(100),
  completedDeliveries: z.number().default(0),
  canceledDeliveries: z.number().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

// Surplus Listing
export const surplusListingSchema = z.object({
  id: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  category: z.enum([
    'perishable_food',
    'non_perishable_food',
    'beverages',
    'medical_supplies',
    'hygiene_products',
    'clothing',
    'blankets',
    'tents',
    'water',
    'baby_supplies',
    'pet_supplies',
    'cleaning_supplies',
    'other',
  ]),
  quantity: z.number().positive(),
  unit: z.string(),
  expirationDate: z.string().datetime().optional(),
  qualityNotes: z.string().max(500).optional(),
  handlingRequirements: z.array(z.string()).default([]),
  requiresRefrigeration: z.boolean().default(false),
  pickupAddress: addressSchema,
  pickupCoordinates: coordinatesSchema.optional(),
  pickupWindow: timeWindowSchema,
  pickupInstructions: z.string().max(500).optional(),
  contactName: z.string(),
  contactPhone: z.string(),
  status: z.enum([
    'posted',
    'matched',
    'scheduled',
    'picked_up',
    'delivered',
    'canceled',
    'failed',
    'expired',
  ]).default('posted'),
  geohash: z.string().optional(),
  enrichmentStatus: z.enum(['pending', 'completed', 'degraded', 'failed']).optional(),
  aiRiskScore: z.number().min(0).max(100).optional(),
  aiFlags: z.array(z.string()).optional(),
  version: z.number().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SurplusListing = z.infer<typeof surplusListingSchema>;

// Demand Post
export const demandPostSchema = z.object({
  id: z.string(),
  recipientId: z.string(),
  recipientName: z.string(),
  organizationType: z.enum(['shelter', 'food_bank', 'hospital', 'community_center', 'school', 'other']),
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  categories: z.array(z.string()).min(1),
  quantityNeeded: z.number().positive(),
  capacity: z.number().positive(),
  priorityLevel: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  deliveryAddress: addressSchema,
  deliveryCoordinates: coordinatesSchema.optional(),
  acceptanceWindow: timeWindowSchema,
  deliveryInstructions: z.string().max(500).optional(),
  contactName: z.string(),
  contactPhone: z.string(),
  status: z.enum([
    'posted',
    'matched',
    'scheduled',
    'picked_up',
    'delivered',
    'closed',
    'canceled',
    'expired',
  ]).default('posted'),
  geohash: z.string().optional(),
  version: z.number().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type DemandPost = z.infer<typeof demandPostSchema>;

// Match Recommendation
export const matchRecommendationSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  demandId: z.string(),
  score: z.number().min(0).max(100),
  scoreBreakdown: z.object({
    distance: z.number(),
    time: z.number(),
    category: z.number(),
    capacity: z.number(),
    reliability: z.number(),
  }),
  distanceMiles: z.number(),
  status: z.enum([
    'pending',
    'accepted',
    'rejected',
    'scheduled',
    'picked_up',
    'delivered',
    'canceled',
    'compliance_blocked',
  ]).default('pending'),
  complianceStatus: z.enum(['pending', 'passed', 'blocked']).default('pending'),
  complianceChecks: z.array(z.object({
    ruleId: z.string(),
    ruleName: z.string(),
    passed: z.boolean(),
    message: z.string().optional(),
  })).optional(),
  routePlanId: z.string().optional(),
  acceptedAt: z.string().datetime().optional(),
  rejectedReason: z.string().optional(),
  version: z.number().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type MatchRecommendation = z.infer<typeof matchRecommendationSchema>;

// Delivery Task
export const deliveryTaskSchema = z.object({
  id: z.string(),
  matchId: z.string(),
  listingId: z.string(),
  demandId: z.string(),
  driverId: z.string().optional(),
  driverName: z.string().optional(),
  status: z.enum([
    'scheduled',
    'en_route',
    'picked_up',
    'delivered',
    'canceled',
    'failed',
  ]).default('scheduled'),
  scheduledPickupTime: z.string().datetime(),
  scheduledDeliveryTime: z.string().datetime(),
  actualPickupTime: z.string().datetime().optional(),
  actualDeliveryTime: z.string().datetime().optional(),
  currentLocation: coordinatesSchema.optional(),
  lastLocationUpdate: z.string().datetime().optional(),
  routePlanId: z.string().optional(),
  cancellationReason: z.string().optional(),
  failureReason: z.string().optional(),
  notes: z.string().max(1000).optional(),
  idempotencyKey: z.string().optional(),
  version: z.number().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type DeliveryTask = z.infer<typeof deliveryTaskSchema>;

// Route Plan
export const routePlanSchema = z.object({
  id: z.string(),
  matchId: z.string(),
  pickupCoordinates: coordinatesSchema,
  deliveryCoordinates: coordinatesSchema,
  distanceMiles: z.number(),
  durationMinutes: z.number(),
  polyline: z.string().optional(),
  provider: z.enum(['amazon_location', 'fallback']),
  providerStatus: z.enum(['ok', 'degraded']).default('ok'),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export type RoutePlan = z.infer<typeof routePlanSchema>;

// Compliance Check
export const complianceCheckSchema = z.object({
  id: z.string(),
  matchId: z.string(),
  listingId: z.string(),
  demandId: z.string(),
  status: z.enum(['passed', 'blocked']),
  ruleVersion: z.string(),
  checks: z.array(z.object({
    ruleId: z.string(),
    ruleName: z.string(),
    passed: z.boolean(),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string(),
  })),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
  blockedBy: z.string().optional(),
  blockedAt: z.string().datetime().optional(),
  blockReason: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ComplianceCheck = z.infer<typeof complianceCheckSchema>;

// Audit Event
export const auditEventSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.enum([
    'create',
    'update',
    'delete',
    'state_transition',
    'compliance_decision',
    'override',
  ]),
  actor: z.string(),
  actorRole: z.string(),
  requestId: z.string(),
  before: z.record(z.unknown()).optional(),
  after: z.record(z.unknown()).optional(),
  diff: z.array(z.object({
    field: z.string(),
    oldValue: z.unknown(),
    newValue: z.unknown(),
  })).optional(),
  justification: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime(),
  ttl: z.number().optional(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

// Notification
export const notificationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.enum([
    'match_proposed',
    'match_accepted',
    'scheduled',
    'en_route',
    'picked_up',
    'delivered',
    'canceled',
    'compliance_blocked',
  ]),
  title: z.string(),
  message: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  read: z.boolean().default(false),
  readAt: z.string().datetime().optional(),
  deliveryChannels: z.array(z.enum(['email', 'sms', 'in_app'])),
  deliveryStatus: z.record(z.enum(['pending', 'sent', 'failed'])).optional(),
  createdAt: z.string().datetime(),
});

export type Notification = z.infer<typeof notificationSchema>;

// Request/Response schemas for API
export const createSupplyRequestSchema = surplusListingSchema.omit({
  id: true,
  supplierId: true,
  status: true,
  geohash: true,
  enrichmentStatus: true,
  aiRiskScore: true,
  aiFlags: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  pickupCoordinates: true,
});

export const createDemandRequestSchema = demandPostSchema.omit({
  id: true,
  recipientId: true,
  status: true,
  geohash: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deliveryCoordinates: true,
});

export const updateStatusRequestSchema = z.object({
  status: z.string(),
  reason: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export const updateLocationRequestSchema = z.object({
  coordinates: coordinatesSchema,
  timestamp: z.string().datetime().optional(),
});

export const scheduleMatchRequestSchema = z.object({
  driverId: z.string(),
  scheduledPickupTime: z.string().datetime(),
  scheduledDeliveryTime: z.string().datetime(),
  idempotencyKey: z.string(),
});

export const overrideTaskRequestSchema = z.object({
  action: z.enum(['force_schedule', 'reassign_driver', 'cancel']),
  justification: z.string().min(10),
  newDriverId: z.string().optional(),
  newScheduledTimes: z.object({
    pickup: z.string().datetime(),
    delivery: z.string().datetime(),
  }).optional(),
});
