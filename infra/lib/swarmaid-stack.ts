import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';

export class SwarmAidStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table for SwarmAid data
    const table = new dynamodb.Table(this, 'SwarmAidMainTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl', // Enable TTL for automatic event cleanup
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev only
    });

    // Secrets Manager secret for Gemini API key
    const geminiSecret = new secretsmanager.Secret(this, 'GeminiSecret', {
      secretName: '/swarmaid/gemini-api-key',
      description: 'Google Gemini API key for SwarmAid AI enrichment',
    });

    // Secrets Manager secret for Mapbox token
    // Secret value managed externally via AWS Secrets Manager
    const mapboxSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'MapboxSecret',
      '/swarmaid/mapbox-token'
    );

    // Verification Lambda to test secret access
    const verifyLambda = new lambda.Function(this, 'VerifySecretLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

exports.handler = async (event) => {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  
  try {
    const command = new GetSecretValueCommand({
      SecretId: process.env.SECRET_NAME,
    });
    const response = await client.send(command);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'ok',
        secretExists: true,
        secretHasValue: !!response.SecretString,
        message: 'Secret access verified successfully'
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        secretExists: false,
        message: error.message
      })
    };
  }
};
      `),
      environment: {
        SECRET_NAME: geminiSecret.secretName,
      },
      description: 'Verifies access to Secrets Manager',
    });

    // Grant Lambda permission to read the secret
    geminiSecret.grantRead(verifyLambda);

    // ========================================
    // Cognito User Pool for Authentication
    // ========================================

    const userPool = new cognito.UserPool(this, 'SwarmAidUserPool', {
      userPoolName: 'SwarmAidUserPool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev only
    });

    // App Client for web frontend (no client secret)
    const userPoolClient = userPool.addClient('SwarmAidWebClient', {
      userPoolClientName: 'SwarmAidWebClient',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // Important for web/mobile clients
      preventUserExistenceErrors: true,
    });

    // Create Cognito Groups for RBAC
    const roles = ['supplier', 'recipient', 'driver', 'compliance', 'operator', 'admin'];
    roles.forEach((role) => {
      new cognito.CfnUserPoolGroup(this, `${role}Group`, {
        userPoolId: userPool.userPoolId,
        groupName: role,
        description: `${role.charAt(0).toUpperCase() + role.slice(1)} user group`,
      });
    });

    // ========================================
    // API Gateway with Lambda Handlers
    // ========================================

    // Health check Lambda (public)
    const healthLambda = new lambda.Function(this, 'HealthLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    },
    body: JSON.stringify({ ok: true, timestamp: new Date().toISOString() })
  };
};
      `),
      description: 'Health check endpoint',
    });

    // Me endpoint Lambda (protected, returns user info from Cognito)
    const meLambda = new lambda.Function(this, 'MeLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  try {
    // Extract claims from Cognito authorizer context
    const claims = event.requestContext.authorizer.claims;
    
    const userInfo = {
      sub: claims.sub,
      email: claims.email || null,
      emailVerified: claims.email_verified === 'true',
      groups: claims['cognito:groups'] ? claims['cognito:groups'].split(',') : []
    };
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
      },
      body: JSON.stringify(userInfo)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};
      `),
      description: 'Returns authenticated user information',
    });

    // Create REST API
    const api = new apigateway.RestApi(this, 'SwarmAidApi', {
      restApiName: 'SwarmAid API',
      description: 'SwarmAid backend REST API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // dev only - restrict in production
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        allowCredentials: true,
      },
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
    });

    // Cognito Authorizer
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [userPool],
        authorizerName: 'CognitoAuthorizer',
        identitySource: 'method.request.header.Authorization',
      }
    );

    // API resources
    const v1 = api.root.addResource('v1');

    // GET /v1/health (public)
    const health = v1.addResource('health');
    health.addMethod('GET', new apigateway.LambdaIntegration(healthLambda));

    // GET /v1/me (protected)
    const me = v1.addResource('me');
    me.addMethod('GET', new apigateway.LambdaIntegration(meLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ========================================
    // Business Logic Lambda Functions
    // ========================================

    const lambdaDir = path.join(__dirname, '..', 'lambda');

    const commonLambdaProps: Partial<lambdaNodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        SECRET_NAME: geminiSecret.secretName,
        MAPBOX_SECRET_NAME: mapboxSecret.secretName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['aws-sdk', '@aws-sdk/*'], // AWS SDK v2 and v3 modules
        forceDockerBundling: false, // Use local esbuild instead of Docker
      },
    };

    // Profile Lambda (PUT /v1/profile, GET /v1/profile)
    const profileLambda = new lambdaNodejs.NodejsFunction(this, 'ProfileLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'profile.ts'),
      handler: 'putProfile', // Default handler
      description: 'Handle user profile operations',
    });

    const profileGetLambda = new lambdaNodejs.NodejsFunction(this, 'ProfileGetLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'profile.ts'),
      handler: 'getProfile',
      description: 'Get user profile',
    });

    table.grantReadWriteData(profileLambda);
    mapboxSecret.grantRead(profileLambda); // Profile geocodes address

    table.grantReadData(profileGetLambda);

    // Draft Listing Lambda (POST /v1/listings/draft)
    const draftListingLambda = new lambdaNodejs.NodejsFunction(this, 'DraftListingLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'listings.ts'),
      handler: 'postDraftListing',
      description: 'Create draft listing with AI agent assistance',
      timeout: cdk.Duration.seconds(60), // Longer for Gemini API
    });

    table.grantReadWriteData(draftListingLambda);
    geminiSecret.grantRead(draftListingLambda);

    // Confirm Listing Lambda (POST /v1/listings/{id}/confirm)
    const confirmListingLambda = new lambdaNodejs.NodejsFunction(this, 'ConfirmListingLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'listings.ts'),
      handler: 'postConfirmListing',
      description: 'Confirm and post a draft listing',
    });

    table.grantReadWriteData(confirmListingLambda);

    // My Listings Lambda (GET /v1/listings/mine)
    const myListingsLambda = new lambdaNodejs.NodejsFunction(this, 'MyListingsLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'listings.ts'),
      handler: 'getMyListings',
      description: 'Get user\'s listings',
    });

    table.grantReadData(myListingsLambda);

    // Deals Lambda (GET /v1/deals)
    const dealsLambda = new lambdaNodejs.NodejsFunction(this, 'DealsLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'deals.ts'),
      handler: 'getDeals',
      description: 'Browse ranked available listings',
    });

    table.grantReadData(dealsLambda);

    // Events Lambda (GET /v1/events)
    const eventsLambda = new lambdaNodejs.NodejsFunction(this, 'EventsLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'events.ts'),
      handler: 'getEvents',
      description: 'Poll for status update events',
    });

    table.grantReadData(eventsLambda);

    // ========================================
    // API Routes for New Endpoints
    // ========================================

    // /v1/profile
    const profile = v1.addResource('profile');
    profile.addMethod('PUT', new apigateway.LambdaIntegration(profileLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    profile.addMethod('GET', new apigateway.LambdaIntegration(profileGetLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/listings
    const listings = v1.addResource('listings');

    // /v1/listings/draft
    const draftListings = listings.addResource('draft');
    draftListings.addMethod('POST', new apigateway.LambdaIntegration(draftListingLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/listings/{id}/confirm
    const listingId = listings.addResource('{id}');
    const confirmListing = listingId.addResource('confirm');
    confirmListing.addMethod('POST', new apigateway.LambdaIntegration(confirmListingLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/listings/mine
    const myListings = listings.addResource('mine');
    myListings.addMethod('GET', new apigateway.LambdaIntegration(myListingsLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/deals
    const deals = v1.addResource('deals');
    deals.addMethod('GET', new apigateway.LambdaIntegration(dealsLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/events
    const events = v1.addResource('events');
    events.addMethod('GET', new apigateway.LambdaIntegration(eventsLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ========================================
    // Agent Endpoints (Conversational UX)
    // ========================================

    // Agent Message Lambda (POST /v1/agent/message)
    const agentMessageLambda = new lambdaNodejs.NodejsFunction(this, 'AgentMessageLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'agent.ts'),
      handler: 'postAgentMessage',
      description: 'Conversational agent message handler',
      timeout: cdk.Duration.seconds(60), // Longer for Gemini API
    });

    table.grantReadWriteData(agentMessageLambda);
    geminiSecret.grantRead(agentMessageLambda);

    // Agent Confirm Lambda (POST /v1/agent/confirm)
    const agentConfirmLambda = new lambdaNodejs.NodejsFunction(this, 'AgentConfirmLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'agent.ts'),
      handler: 'postAgentConfirm',
      description: 'Finalize agent session and create entity',
    });

    table.grantReadWriteData(agentConfirmLambda);

    // /v1/agent
    const agent = v1.addResource('agent');

    // /v1/agent/message
    const agentMessage = agent.addResource('message');
    agentMessage.addMethod('POST', new apigateway.LambdaIntegration(agentMessageLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/agent/confirm
    const agentConfirm = agent.addResource('confirm');
    agentConfirm.addMethod('POST', new apigateway.LambdaIntegration(agentConfirmLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ========================================
    // Matching System
    // ========================================

    // Match Generation Lambda (triggered by API or EventBridge)
    const matchGenerationLambda = new lambdaNodejs.NodejsFunction(this, 'MatchGenerationLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'match-generation.ts'),
      handler: 'handler',
      description: 'Generate suggested matches for listings',
      timeout: cdk.Duration.seconds(60), // Allow time for batch writes
    });

    table.grantReadWriteData(matchGenerationLambda);

    // Matches Lambda (Accept, List receiver matches, List listing matches)
    const matchesLambda = new lambdaNodejs.NodejsFunction(this, 'MatchesLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'matches.ts'),
      handler: 'handler',
      description: 'Handle match operations (accept, list)',
    });

    table.grantReadWriteData(matchesLambda);

    // /v1/matches
    const matches = v1.addResource('matches');

    // GET /v1/matches?status=SUGGESTED (receiver feed)
    matches.addMethod('GET', new apigateway.LambdaIntegration(matchesLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // POST /v1/matches/{matchId}/accept
    const matchId = matches.addResource('{matchId}');
    const acceptMatch = matchId.addResource('accept');
    acceptMatch.addMethod('POST', new apigateway.LambdaIntegration(matchesLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /v1/listings/{id}/matches (donor interest view)
    const listingMatches = listingId.addResource('matches');
    listingMatches.addMethod('GET', new apigateway.LambdaIntegration(matchesLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ========================================
    // Mapbox Integration (Geocoding & Routing)
    // ========================================

    // Geocode Lambda (POST /v1/geocode)
    const geocodeLambda = new lambdaNodejs.NodejsFunction(this, 'GeocodeLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'geocode.ts'),
      handler: 'postGeocode',
      description: 'Geocode addresses using Mapbox',
      timeout: cdk.Duration.seconds(20),
    });

    mapboxSecret.grantRead(geocodeLambda);

    // Map Payload Lambda (GET /v1/map/match/{matchId}, GET /v1/map/listing/{listingId})
    const mapPayloadLambda = new lambdaNodejs.NodejsFunction(this, 'MapPayloadLambda', {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, 'handlers', 'map.ts'),
      handler: 'handler',
      description: 'Generate map payload with route geometry',
      timeout: cdk.Duration.seconds(20),
    });

    table.grantReadData(mapPayloadLambda);
    mapboxSecret.grantRead(mapPayloadLambda);

    // /v1/geocode
    const geocode = v1.addResource('geocode');
    geocode.addMethod('POST', new apigateway.LambdaIntegration(geocodeLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/map
    const map = v1.addResource('map');

    // /v1/map/match/{matchId}
    const mapMatch = map.addResource('match');
    const mapMatchId = mapMatch.addResource('{matchId}');
    mapMatchId.addMethod('GET', new apigateway.LambdaIntegration(mapPayloadLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /v1/map/listing/{listingId}
    const mapListing = map.addResource('listing');
    const mapListingId = mapListing.addResource('{listingId}');
    mapListingId.addMethod('GET', new apigateway.LambdaIntegration(mapPayloadLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Outputs
    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'SwarmAid Main DynamoDB Table',
    });

    new cdk.CfnOutput(this, 'SecretName', {
      value: geminiSecret.secretName,
      description: 'Gemini API Key Secret Name',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: geminiSecret.secretArn,
      description: 'Gemini API Key Secret ARN',
    });

    new cdk.CfnOutput(this, 'MapboxSecretName', {
      value: mapboxSecret.secretName,
      description: 'Mapbox API Token Secret Name',
    });

    new cdk.CfnOutput(this, 'MapboxSecretArn', {
      value: mapboxSecret.secretArn,
      description: 'Mapbox API Token Secret ARN',
    });

    new cdk.CfnOutput(this, 'VerifyLambdaName', {
      value: verifyLambda.functionName,
      description: 'Verification Lambda Function Name',
    });

    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'AWS Region',
    });

    // Cognito outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID (Web)',
    });

    new cdk.CfnOutput(this, 'UserPoolIssuerUrl', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      description: 'Cognito User Pool Issuer URL (for JWT validation)',
    });

    // API Gateway outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: api.restApiId,
      description: 'API Gateway REST API ID',
    });

    new cdk.CfnOutput(this, 'HealthEndpoint', {
      value: `${api.url}v1/health`,
      description: 'Health check endpoint (public)',
    });

    new cdk.CfnOutput(this, 'MeEndpoint', {
      value: `${api.url}v1/me`,
      description: 'User info endpoint (protected)',
    });
  }
}
