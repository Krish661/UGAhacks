#!/usr/bin/env ts-node
/**
 * Seed script to populate DynamoDB with sample users, suppliers, recipients, listings, and demand posts
 * Usage: ts-node scripts/seed.ts
 */
import { ulid } from 'ulid';
import { listingRepository, demandRepository, userRepository } from '../services/integrations/dynamodb';
import { SurplusListing, DemandPost, UserProfile } from '../services/shared/schemas';
import { logger } from '../services/shared/logger';

const SAMPLE_USERS: Partial<UserProfile>[] = [
  {
    cognitoUserId: 'supplier-001',
    email: 'supplier1@swarmaid.org',
    name: 'Green Grocers Inc',
    role: 'supplier',
    organizationName: 'Green Grocers',
    phoneNumber: '+1-555-0101',
    address: {
      street: '123 Market St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94102',
      country: 'USA',
    },
  },
  {
    cognitoUserId: 'supplier-002',
    email: 'supplier2@swarmaid.org',
    name: 'FreshMart',
    role: 'supplier',
    organizationName: 'FreshMart Supermarket',
    phoneNumber: '+1-555-0102',
    address: {
      street: '456 Commerce Ave',
      city: 'Los Angeles',
      state: 'CA',
      postalCode: '90001',
      country: 'USA',
    },
  },
  {
    cognitoUserId: 'recipient-001',
    email: 'recipient1@swarmaid.org',
    name: 'Food Bank Central',
    role: 'recipient',
    organizationName: 'Food Bank Central',
    phoneNumber: '+1-555-0201',
    address: {
      street: '789 Aid St',
      city: 'Oakland',
      state: 'CA',
      postalCode: '94601',
      country: 'USA',
    },
  },
  {
    cognitoUserId: 'recipient-002',
    email: 'recipient2@swarmaid.org',
    name: 'Community Kitchen',
    role: 'recipient',
    organizationName: 'Community Kitchen Network',
    phoneNumber: '+1-555-0202',
    address: {
      street: '321 Hope Blvd',
      city: 'San Jose',
      state: 'CA',
      postalCode: '95110',
      country: 'USA',
    },
  },
  {
    cognitoUserId: 'driver-001',
    email: 'driver1@swarmaid.org',
    name: 'John Driver',
    role: 'driver',
    phoneNumber: '+1-555-0301',
    address: {
      street: '555 Route 66',
      city: 'Sacramento',
      state: 'CA',
      postalCode: '95814',
      country: 'USA',
    },
  },
  {
    cognitoUserId: 'operator-001',
    email: 'ops@swarmaid.org',
    name: 'SwarmAid Operations',
    role: 'operator',
    phoneNumber: '+1-555-0401',
  },
];

const SAMPLE_LISTINGS: Partial<SurplusListing>[] = [
  {
    supplierId: 'supplier-001',
    title: 'Fresh Produce - Apples & Oranges',
    description: 'Surplus fresh fruit from daily operations, high quality',
    category: 'perishable_food',
    quantity: 150,
    quantityUnit: 'lbs',
    estimatedValue: 300,
    images: [],
    pickupAddress: {
      street: '123 Market St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94102',
      country: 'USA',
    },
    pickupCoordinates: { lat: 37.7749, lon: -122.4194 },
    pickupWindow: {
      start: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    },
    expirationDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    requiresRefrigeration: true,
    handlingRequirements: ['refrigerated_transport'],
    qualityNotes: 'Fresh, Grade A quality',
    status: 'posted',
  },
  {
    supplierId: 'supplier-002',
    title: 'Canned Goods Surplus',
    description: 'Overstocked canned vegetables and soups',
    category: 'non_perishable_food',
    quantity: 500,
    quantityUnit: 'cans',
    estimatedValue: 750,
    images: [],
    pickupAddress: {
      street: '456 Commerce Ave',
      city: 'Los Angeles',
      state: 'CA',
      postalCode: '90001',
      country: 'USA',
    },
    pickupCoordinates: { lat: 34.0522, lon: -118.2437 },
    pickupWindow: {
      start: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    },
    expirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    requiresRefrigeration: false,
    handlingRequirements: [],
    qualityNotes: 'Sealed, unexpired',
    status: 'posted',
  },
  {
    supplierId: 'supplier-001',
    title: 'Medical Supplies - First Aid Kits',
    description: 'Surplus first aid kits from safety stock rotation',
    category: 'medical_supplies',
    quantity: 50,
    quantityUnit: 'kits',
    estimatedValue: 1000,
    images: [],
    pickupAddress: {
      street: '123 Market St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94102',
      country: 'USA',
    },
    pickupCoordinates: { lat: 37.7749, lon: -122.4194 },
    pickupWindow: {
      start: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
    },
    requiresRefrigeration: false,
    handlingRequirements: [],
    qualityNotes: 'Unopened, sterile packaging intact',
    status: 'posted',
  },
];

const SAMPLE_DEMANDS: Partial<DemandPost>[] = [
  {
    recipientId: 'recipient-001',
    title: 'Urgent: Fresh Food for 200 Families',
    description: 'Need fresh produce for weekly distribution',
    categories: ['perishable_food'],
    quantityNeeded: 200,
    quantityUnit: 'lbs',
    capacity: 300,
    deliveryAddress: {
      street: '789 Aid St',
      city: 'Oakland',
      state: 'CA',
      postalCode: '94601',
      country: 'USA',
    },
    deliveryCoordinates: { lat: 37.8044, lon: -122.2712 },
    acceptanceWindow: {
      start: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
    },
    specialRequirements: ['Must be refrigerated'],
    status: 'posted',
  },
  {
    recipientId: 'recipient-002',
    title: 'Canned Food Drive',
    description: 'Collecting non-perishable food for community pantry',
    categories: ['non_perishable_food'],
    quantityNeeded: 1000,
    quantityUnit: 'cans',
    capacity: 1500,
    deliveryAddress: {
      street: '321 Hope Blvd',
      city: 'San Jose',
      state: 'CA',
      postalCode: '95110',
      country: 'USA',
    },
    deliveryCoordinates: { lat: 37.3382, lon: -121.8863 },
    acceptanceWindow: {
      start: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    specialRequirements: [],
    status: 'posted',
  },
  {
    recipientId: 'recipient-001',
    title: 'First Aid Supplies for Clinic',
    description: 'Community health clinic needs first aid supplies',
    categories: ['medical_supplies'],
    quantityNeeded: 30,
    quantityUnit: 'kits',
    capacity: 50,
    deliveryAddress: {
      street: '789 Aid St',
      city: 'Oakland',
      state: 'CA',
      postalCode: '94601',
      country: 'USA',
    },
    deliveryCoordinates: { lat: 37.8044, lon: -122.2712 },
    acceptanceWindow: {
      start: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    },
    specialRequirements: ['Sterile packaging required'],
    status: 'posted',
  },
];

async function seed() {
  logger.info('Starting seed process...');

  try {
    // Seed users
    logger.info('Seeding users...');
    for (const userData of SAMPLE_USERS) {
      const userId = ulid();
      const user: UserProfile = {
        id: userId,
        cognitoUserId: userData.cognitoUserId!,
        email: userData.email!,
        name: userData.name!,
        role: userData.role!,
        organizationName: userData.organizationName,
        phoneNumber: userData.phoneNumber,
        address: userData.address,
        notificationPreferences: {
          email: true,
          sms: false,
          inApp: true,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      await userRepository.put(user);
      logger.info({ userId, email: user.email }, 'Created user');
    }

    // Seed listings
    logger.info('Seeding listings...');
    for (const listingData of SAMPLE_LISTINGS) {
      const listingId = ulid();
      const listing: SurplusListing = {
        id: listingId,
        supplierId: listingData.supplierId!,
        title: listingData.title!,
        description: listingData.description!,
        category: listingData.category!,
        quantity: listingData.quantity!,
        quantityUnit: listingData.quantityUnit!,
        estimatedValue: listingData.estimatedValue!,
        images: listingData.images!,
        pickupAddress: listingData.pickupAddress!,
        pickupCoordinates: listingData.pickupCoordinates!,
        pickupWindow: listingData.pickupWindow!,
        expirationDate: listingData.expirationDate,
        requiresRefrigeration: listingData.requiresRefrigeration!,
        handlingRequirements: listingData.handlingRequirements!,
        qualityNotes: listingData.qualityNotes,
        status: listingData.status!,
        enrichment: {
          status: 'pending',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      await listingRepository.put(listing);
      logger.info({ listingId, title: listing.title }, 'Created listing');
    }

    // Seed demand posts
    logger.info('Seeding demand posts...');
    for (const demandData of SAMPLE_DEMANDS) {
      const demandId = ulid();
      const demand: DemandPost = {
        id: demandId,
        recipientId: demandData.recipientId!,
        title: demandData.title!,
        description: demandData.description!,
        categories: demandData.categories!,
        quantityNeeded: demandData.quantityNeeded!,
        quantityUnit: demandData.quantityUnit!,
        capacity: demandData.capacity!,
        deliveryAddress: demandData.deliveryAddress!,
        deliveryCoordinates: demandData.deliveryCoordinates!,
        acceptanceWindow: demandData.acceptanceWindow!,
        specialRequirements: demandData.specialRequirements!,
        status: demandData.status!,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      await demandRepository.put(demand);
      logger.info({ demandId, title: demand.title }, 'Created demand post');
    }

    logger.info('✅ Seed process completed successfully!');
    logger.info({
      users: SAMPLE_USERS.length,
      listings: SAMPLE_LISTINGS.length,
      demands: SAMPLE_DEMANDS.length,
    }, 'Summary');
  } catch (error) {
    logger.error({ error }, 'Seed process failed');
    process.exit(1);
  }
}

seed();
