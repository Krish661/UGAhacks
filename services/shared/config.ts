// Shared configuration
export const config = {
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    dynamodbEndpoint: process.env.DYNAMODB_ENDPOINT,
    awsEndpoint: process.env.AWS_ENDPOINT,
  },
  tables: {
    entities: process.env.ENTITIES_TABLE_NAME || 'SwarmAid-Entities',
    audit: process.env.AUDIT_TABLE_NAME || 'SwarmAid-AuditEvents',
  },
  buckets: {
    attachments: process.env.ATTACHMENTS_BUCKET_NAME || 'swarmaid-attachments',
    auditExports: process.env.AUDIT_EXPORTS_BUCKET_NAME || 'swarmaid-audit-exports',
  },
  secrets: {
    geminiApiKey: process.env.GEMINI_API_KEY_SECRET_ARN || '',
    locationApiKey: process.env.LOCATION_API_KEY_SECRET_ARN || '',
  },
  sns: {
    notificationsTopicArn: process.env.NOTIFICATIONS_TOPIC_ARN || '',
  },
  eventBridge: {
    eventBusName: process.env.EVENT_BUS_NAME || 'SwarmAid',
  },
  stepFunctions: {
    stateMachineArn: process.env.STATE_MACHINE_ARN || '',
  },
  cognito: {
    userPoolId: process.env.USER_POOL_ID || '',
    userPoolClientId: process.env.USER_POOL_CLIENT_ID || '',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || 'stubbed',
    model: process.env.GEMINI_MODEL || 'gemini-pro',
    timeout: parseInt(process.env.GEMINI_TIMEOUT || '30000'),
  },
  location: {
    geocoderIndex: process.env.LOCATION_GEOCODER_INDEX || 'SwarmAid-Geocoder',
    routeCalculator: process.env.LOCATION_ROUTE_CALCULATOR || 'SwarmAid-Routes',
  },
  matching: {
    maxRadius: parseInt(process.env.MAX_MATCHING_RADIUS || '50'), // miles
    maxCandidates: parseInt(process.env.MAX_CANDIDATES || '100'),
    topRecommendations: parseInt(process.env.TOP_RECOMMENDATIONS || '5'),
    weights: {
      distance: parseFloat(process.env.WEIGHT_DISTANCE || '0.3'),
      time: parseFloat(process.env.WEIGHT_TIME || '0.25'),
      category: parseFloat(process.env.WEIGHT_CATEGORY || '0.2'),
      capacity: parseFloat(process.env.WEIGHT_CAPACITY || '0.15'),
      reliability: parseFloat(process.env.WEIGHT_RELIABILITY || '0.1'),
    },
  },
  compliance: {
    maxRefrigerationWindow: parseInt(process.env.MAX_REFRIGERATION_WINDOW || '2'), // hours
    minExpirationBuffer: parseInt(process.env.MIN_EXPIRATION_BUFFER || '24'), // hours
    maxDistance: parseInt(process.env.MAX_DISTANCE || '100'), // miles
    blockedKeywords: (process.env.BLOCKED_KEYWORDS || 'spoiled,moldy,damaged,rotten,contaminated').split(','),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};
