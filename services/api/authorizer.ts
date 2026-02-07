import { APIGatewayProxyEventV2, APIGatewaySimpleAuthorizerResult } from 'aws-lambda';
import { createLogger } from '../shared/logger';
import * as jose from 'jose';
import { config } from '../shared/config';

const logger = createLogger('Authorizer');

// Cache for JWKS
let jwksCache: jose.JWTVerifyGetKey | null = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getJWKS(): Promise<jose.JWTVerifyGetKey> {
  const now = Date.now();

  if (jwksCache && now - jwksCacheTime < JWKS_CACHE_TTL) {
    return jwksCache;
  }

  const jwksUrl = `https://cognito-idp.${config.aws.region}.amazonaws.com/${config.cognito.userPoolId}/.well-known/jwks.json`;

  jwksCache = jose.createRemoteJWKSet(new URL(jwksUrl));
  jwksCacheTime = now;

  return jwksCache;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewaySimpleAuthorizerResult> {
  try {
    const token = event.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      logger.warn('No authorization token provided');
      return {
        isAuthorized: false,
      };
    }

    // Verify JWT
    const JWKS = await getJWKS();
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: `https://cognito-idp.${config.aws.region}.amazonaws.com/${config.cognito.userPoolId}`,
      audience: config.cognito.userPoolClientId,
    });

    // Extract user info and roles
    const userId = payload.sub as string;
    const email = payload.email as string;
    const groups = (payload['cognito:groups'] as string[]) || [];

    logger.info('User authenticated', { userId, email, groups });

    return {
      isAuthorized: true,
      context: {
        userId,
        email,
        roles: groups.join(','),
      },
    };
  } catch (error) {
    logger.error('Authorization failed', error as Error);
    return {
      isAuthorized: false,
    };
  }
}
