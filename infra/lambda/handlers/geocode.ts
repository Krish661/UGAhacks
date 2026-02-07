import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { geocodeAddress, Address } from '../shared/mapbox';
import { z } from 'zod';

//============================================
// Response Helpers
// ============================================

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

function createErrorResponse(
  statusCode: number,
  errorCode: string,
  message: string
): APIGatewayProxyResult {
  return createResponse(statusCode, {
    ok: false,
    error: errorCode,
    message,
  });
}

// ============================================
// Request Validation
// ============================================

const GeocodeRequestSchema = z.object({
  // Option 1: Structured address
  address: z.union([
    z.object({
      text: z.string().min(1).max(500),
    }),
    z.object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      country: z.string().optional(),
    }),
  ]).optional(),
  // Option 2: Free-form address text
  addressText: z.string().max(500).optional(),
}).refine(
  (data) => data.address || data.addressText,
  { message: 'Either address or addressText must be provided' }
);

// ============================================
// POST /v1/geocode
// ============================================

export async function postGeocode(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Parse and validate request body
    const body = JSON.parse(event.body || '{}');
    const validation = GeocodeRequestSchema.safeParse(body);

    if (!validation.success) {
      return createErrorResponse(400, 'INVALID_INPUT', validation.error.message);
    }

    const { address, addressText } = validation.data;

    // Extract query string
    let query: string;
    if (addressText) {
      query = addressText;
    } else if (address) {
      // Handle address.text or structured address
      if ('text' in address) {
        query = address.text;
      } else {
        // Pass structured address object to geocodeAddress
        const result = await geocodeAddress(address as Address);
        return createResponse(200, {
          ok: true,
          data: {
            location: {
              lat: result.lat,
              lon: result.lon,
              placeName: result.placeName,
            },
          },
        });
      }
    } else {
      return createErrorResponse(400, 'INVALID_INPUT', 'No address provided');
    }

    // Geocode string query
    const result = await geocodeAddress(query);

    return createResponse(200, {
      ok: true,
      data: {
        location: {
          lat: result.lat,
          lon: result.lon,
          placeName: result.placeName,
        },
      },
    });
  } catch (error) {
    console.error('Geocode error:', error);

    if (error instanceof Error) {
      if (error.message.includes('No geocoding results')) {
        return createErrorResponse(404, 'NOT_FOUND', 'Address not found');
      }
      if (error.message.includes('Mapbox token unavailable')) {
        return createErrorResponse(503, 'SERVICE_UNAVAILABLE', 'Geocoding service unavailable');
      }
    }

    return createErrorResponse(500, 'INTERNAL_ERROR', 'Geocoding failed');
  }
}
