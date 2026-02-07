import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Listing, UserProfile } from '../shared/types';
import { getPostedListingsByCategory, getUserProfile, getUserNeedRequests } from '../shared/repository';
import { successResponse, errorResponse, extractUserContext } from '../shared/utils';
import { haversineDistance } from '../shared/mapbox';

// ============================================
// GET /v1/deals - Browse Available Listings (Ranked)
// ============================================

export async function getDeals(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    // Get query parameters
    const category = event.queryStringParameters?.category;
    const limit = parseInt(event.queryStringParameters?.limit || '50', 10);

    // Get user profile to personalize recommendations
    const profile = await getUserProfile(user.userId);
    const userRequests = await getUserNeedRequests(user.userId);

    // Fetch listings (if category specified, filter by category)
    let listings: Listing[];
    if (category) {
      listings = await getPostedListingsByCategory(category, limit);
    } else {
      // For MVP, fetch from common categories
      const categories = ['produce', 'bakery', 'prepared-meals', 'dairy', 'meat', 'pantry-staples'];
      const allListings = await Promise.all(
        categories.map(cat => getPostedListingsByCategory(cat, 10))
      );
      listings = allListings.flat().slice(0, limit);
    }

    // Rank listings based on deterministic criteria
    const rankedListings = rankListings(listings, profile, userRequests);

    return successResponse({
      deals: rankedListings,
      count: rankedListings.length,
    });
  } catch (error: any) {
    console.error('Error getting deals:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to get deals', 500, error.message);
  }
}

// ============================================
// Ranking Algorithm
// ============================================

interface RankedListing extends Listing {
  score: number;
  reasons: string[];
}

function rankListings(
  listings: Listing[],
  profile: UserProfile | null,
  userRequests: any[]
): RankedListing[] {
  const now = new Date();

  const scored = listings.map(listing => {
    let score = 50; // Base score
    const reasons: string[] = [];

    // 1. Urgency boost
    if (listing.urgency === 'CRITICAL') {
      score += 30;
      reasons.push('Critical urgency');
    } else if (listing.urgency === 'HIGH') {
      score += 20;
      reasons.push('High urgency');
    } else if (listing.urgency === 'MEDIUM') {
      score += 10;
    }

    // 2. Recency boost (posted within last 2 hours)
    const createdAt = new Date(listing.createdAt);
    const ageInHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
    if (ageInHours < 2) {
      score += 15;
      reasons.push('Recently posted');
    } else if (ageInHours < 24) {
      score += 5;
    }

    // 3. Pickup window (starting soon = higher priority)
    const pickupStart = new Date(listing.pickupWindowStart);
    const hoursUntilPickup = (pickupStart.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursUntilPickup > 0 && hoursUntilPickup < 4) {
      score += 20;
      reasons.push('Pickup window opening soon');
    } else if (hoursUntilPickup < 0) {
      // Pickup window already started
      const pickupEnd = new Date(listing.pickupWindowEnd);
      if (pickupEnd > now) {
        score += 25;
        reasons.push('Pickup window open now');
      } else {
        score -= 30; // Expired
      }
    }

    // 4. Category match with user's active requests
    if (userRequests.length > 0) {
      const matchingRequest = userRequests.find(
        req => req.category === listing.category && req.status === 'ACTIVE'
      );
      if (matchingRequest) {
        score += 25;
        reasons.push('Matches your need request');
      }
    }

    // 5. Distance scoring (if both locations available)
    if (profile?.location && listing.pickupLocation) {
      const distanceMeters = haversineDistance(
        profile.location.lat,
        profile.location.lon,
        listing.pickupLocation.lat,
        listing.pickupLocation.lon
      );
      const distanceKm = distanceMeters / 1000;
      
      if (distanceKm < 5) {
        score += 20;
        reasons.push(`Very close (${distanceKm.toFixed(1)} km)`);
      } else if (distanceKm < 15) {
        score += 10;
        reasons.push(`Near your location (${distanceKm.toFixed(1)} km)`);
      } else if (distanceKm < 50) {
        score += 5;
        reasons.push(`Within range (${distanceKm.toFixed(1)} km)`);
      } else {
        score -= 10; // Far away
        reasons.push(`Far away (${distanceKm.toFixed(1)} km)`);
      }
    }

    return {
      ...listing,
      score: Math.max(0, Math.min(100, score)), // Clamp to 0-100
      reasons,
    } as RankedListing;
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored;
}
