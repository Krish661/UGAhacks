import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UserProfileSchema, UserProfile } from '../shared/types';
import { saveUserProfile, getUserProfile } from '../shared/repository';
import { successResponse, errorResponse, extractUserContext, parseBody, formatZodError } from '../shared/utils';
import { geocodeAddress } from '../shared/mapbox';

// ============================================
// PUT /v1/profile - Save or Update Profile
// ============================================

export async function putProfile(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    const body = parseBody<Partial<UserProfile>>(event);
    if (!body) {
      return errorResponse('BAD_REQUEST', 'Invalid request body', 400);
    }

    // Merge with user context
    const timestamp = new Date().toISOString();
    const profile: UserProfile = {
      userId: user.userId,
      email: user.email,
      role: (body.role || (user.groups[0] as any)) || 'supplier',
      name: body.name || user.email,
      phone: body.phone,
      address: body.address || {
        street: '',
        city: '',
        state: '',
        zip: '',
        country: 'USA',
      },
      createdAt: body.createdAt || timestamp,
      updatedAt: timestamp,
    };

    // Geocode address if provided
    if (body.address && body.address.street && body.address.city) {
      try {
        console.log('Geocoding address for profile:', profile.userId);
        const geocodeResult = await geocodeAddress(body.address);
        profile.location = {
          lat: geocodeResult.lat,
          lon: geocodeResult.lon,
          placeName: geocodeResult.placeName,
        };
        console.log('Geocoding successful:', profile.location);
      } catch (error) {
        console.warn('Geocoding failed, saving profile without location:', error instanceof Error ? error.message : 'unknown');
        // Continue without location rather than failing the entire profile save
      }
    }

    // Validate with Zod
    const validated = UserProfileSchema.parse(profile);

    // Save to DynamoDB
    await saveUserProfile(validated);

    return successResponse(validated);
  } catch (error: any) {
    console.error('Error saving profile:', error);
    
    if (error.name === 'ZodError') {
      return errorResponse('VALIDATION_ERROR', formatZodError(error), 400);
    }
    
    return errorResponse('INTERNAL_ERROR', 'Failed to save profile', 500, error.message);
  }
}

// ============================================
// GET /v1/profile - Get User Profile
// ============================================

export async function getProfile(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    const profile = await getUserProfile(user.userId);
    
    if (!profile) {
      return errorResponse('NOT_FOUND', 'Profile not found', 404);
    }

    return successResponse(profile);
  } catch (error: any) {
    console.error('Error getting profile:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to get profile', 500, error.message);
  }
}
