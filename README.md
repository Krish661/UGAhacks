# Replate.ai Backend

Production-ready disaster relief coordination platform backend built on AWS with TypeScript, Lambda, and Gemini AI support.

## Overview

RePlate.ai connects suppliers with surplus resources to recipients in need through a smart matching system and driver coordination. Built for disaster relief scenarios, it includes:

- **AI-Powered Matching**: Google Gemini enrichment + weighted scoring algorithm
- **Compliance Engine**: Deterministic rules for safety and logistics
- **State Machine**: RBAC-enforced workflow (posted → matched → scheduled → picked_up → delivered)
- **Real-time Coordination**: Step Functions orchestration with EventBridge
- **Comprehensive Audit**: Immutable audit trail for all state changes
- **Fallback Architecture**: Graceful degradation for AI and geo services
- **Production Ready**: Complete IaC, observability, security, and error handling

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌───────────────┐
│   Cognito   │─────→│ API Gateway  │─────→│ Lambda Funcs  │
│  User Pool  │      │   + WAF      │      │  (Handlers)   │
└─────────────┘      └──────────────┘      └───────┬───────┘
                                                    │
                     ┌──────────────────────────────┼──────────┐
                     │                              │          │
                     ↓                              ↓          ↓
              ┌──────────────┐              ┌────────────┐  ┌───────┐
              │  DynamoDB    │              │   Step     │  │  SNS  │
              │  (Entities)  │              │ Functions  │  │ Topics│
              └──────────────┘              └────────────┘  └───────┘
                     │                              │
                     ↓                              ↓
              ┌──────────────┐              ┌────────────┐
              │  DynamoDB    │              │  Gemini    │
              │   (Audit)    │              │  API + S3  │
              └──────────────┘              └────────────┘
```

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for comprehensive architecture documentation.

## Tech Stack

- **Runtime**: Node.js 20.x, TypeScript 5.3
- **Infrastructure**: AWS CDK v2
- **Compute**: AWS Lambda (512MB, 30s timeout)
- **API**: API Gateway HTTP API + Lambda Authorizer
- **Database**: DynamoDB (single-table design with GSIs)
- **Storage**: S3 (attachments, audit exports)
- **Auth**: Cognito User Pool (6 roles: supplier, recipient, driver, compliance, operator, admin)
- **Orchestration**: Step Functions (4-step workflow)
- **Events**: EventBridge custom bus
- **Notifications**: SNS (email/SMS)
- **AI**: Google Gemini API with fallback
- **Geospatial**: Amazon Location Service with haversine fallback
- **Security**: WAF, encryption at rest, Secrets Manager
- **Observability**: CloudWatch Logs/Metrics/Alarms, X-Ray tracing

## Project Structure

```
.
├── infra/                    # AWS CDK infrastructure
│   ├── bin/app.ts           # CDK app entry point
│   └── lib/swarmaid-stack.ts # Complete stack definition
├── services/                 # Lambda function code
│   ├── shared/              # Shared utilities
│   │   ├── config.ts        # Environment configuration
│   │   ├── logger.ts        # Structured logging
│   │   ├── errors.ts        # Custom error classes
│   │   └── schemas.ts       # Zod validation schemas
│   ├── domain/              # Domain logic
│   │   ├── state-machine.ts # State transitions with RBAC
│   │   ├── compliance-engine.ts # 6 compliance rules
│   │   ├── matching-engine.ts   # Weighted scoring
│   │   └── geohash.ts       # Geospatial utilities
│   ├── integrations/        # External integrations
│   │   ├── dynamodb.ts      # Repository pattern
│   │   ├── gemini.ts        # AI enrichment
│   │   ├── location.ts      # Geocoding/routing
│   │   ├── audit.ts         # Audit trail
│   │   ├── events.ts        # EventBridge
│   │   └── notifications.ts # SNS + in-app
│   ├── api/                 # API handlers
│   │   ├── authorizer.ts    # Cognito JWT validation
│   │   ├── helpers.ts       # Request/response utilities
│   │   └── handlers/        # Endpoint handlers
│   │       ├── supply.ts    # Surplus listings
│   │       ├── demand.ts    # Demand posts
│   │       ├── matches.ts   # Match recommendations
│   │       ├── compliance.ts # Compliance queue
│   │       ├── driver.ts    # Driver tasks
│   │       ├── ops.ts       # Operator dashboard
│   │       ├── events.ts    # Event polling
│   │       └── me.ts        # User profile
│   ├── orchestration/       # Step Functions handlers
│   │   ├── enrichment.ts    # Gemini enrichment
│   │   ├── matching.ts      # Match finding/scoring
│   │   ├── compliance-check.ts # Compliance validation
│   │   └── notification.ts  # Party notifications
│   └── __tests__/           # Unit tests
├── scripts/                 # Utility scripts
│   ├── seed.ts              # Seed sample data
│   └── simulate.ts          # Delivery simulation
├── docs/                    # Documentation
│   ├── ARCHITECTURE.md      # Architecture deep dive
│   └── openapi.yaml         # OpenAPI 3.0 spec
├── docker-compose.yml       # Local dev environment
├── Dockerfile.local         # Local API server
└── README.md                # This file
```

## Prerequisites

- **Node.js** 20.x or higher
- **AWS Account** with CLI configured (`aws configure`)
- **AWS CDK** v2 (`npm install -g aws-cdk`)
- **Docker** (for local development)
- **Google Gemini API Key** (from Google AI Studio)

## Environment Variables

Create `.env` file in project root (see `.env.example`):

```bash
# AWS Configuration
AWS_REGION=us-east-1

# DynamoDB
DYNAMODB_ENTITIES_TABLE=SwarmAid-Entities
DYNAMODB_AUDIT_TABLE=SwarmAid-Audit

# API Gateway
API_GATEWAY_ENDPOINT=https://api.swarmaid.org

# Cognito
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx

# External Services
GEMINI_API_KEY=your-gemini-api-key-here
LOCATION_PLACE_INDEX=SwarmAid-PlaceIndex
LOCATION_ROUTE_CALCULATOR=SwarmAid-RouteCalculator

# EventBridge
EVENT_BUS_NAME=SwarmAid-EventBus

# SNS Topics
SNS_SUPPLIER_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:SwarmAid-Suppliers
SNS_RECIPIENT_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:SwarmAid-Recipients
SNS_DRIVER_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:SwarmAid-Drivers

# Step Functions
STATE_MACHINE_ARN=arn:aws:states:us-east-1:123456789012:stateMachine:SwarmAid-Orchestration

# S3 Buckets
ATTACHMENTS_BUCKET=swarmaid-attachments-XXXXXX
AUDIT_EXPORTS_BUCKET=swarmaid-audit-exports-XXXXXX

# Logging
LOG_LEVEL=info
NODE_ENV=development
```

## Installation

1. **Clone repository**:
   ```bash
   git clone https://github.com/your-org/swarmaid-backend.git
   cd swarmaid-backend
   ```

2. **Install root dependencies**:
   ```bash
   npm install
   ```

3. **Install service dependencies**:
   ```bash
   cd services
   npm install
   cd ..
   ```

4. **Install infrastructure dependencies**:
   ```bash
   cd infra
   npm install
   cd ..
   ```

## Deployment to AWS

### First-Time Deployment

1. **Bootstrap CDK** (one-time per AWS account/region):
   ```bash
   cd infra
   cdk bootstrap
   ```

2. **Set Gemini API Key in Secrets Manager**:
   ```bash
   aws secretsmanager create-secret \
     --name SwarmAid-GeminiApiKey \
     --secret-string "your-gemini-api-key-here"
   ```

3. **Deploy stack**:
   ```bash
   cdk deploy --all
   ```

   This will create:
   - 2 DynamoDB tables (Entities, Audit)
   - 2 S3 buckets (attachments, audit exports)
   - Cognito User Pool with 6 groups
   - 13 Lambda functions
   - API Gateway with 40+ routes
   - Step Functions state machine
   - EventBridge custom bus
   - SNS topics (supplier, recipient, driver)
   - WAF with rate limiting
   - CloudWatch alarms

4. **Note the outputs**:
   ```
   SwarmAidStack.ApiEndpoint = https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com
   SwarmAidStack.UserPoolId = us-east-1_XXXXXXXXX
   SwarmAidStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

### Create Test Users

```bash
# Create supplier user
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username supplier@test.com \
  --user-attributes Name=email,Value=supplier@test.com Name=email_verified,Value=true \
  --temporary-password TempPass123!

# Add to supplier group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <USER_POOL_ID> \
  --username supplier@test.com \
  --group-name supplier

# Repeat for other roles: recipient, driver, compliance, operator, admin
```

### Seed Sample Data

```bash
cd services
AWS_REGION=us-east-1 ts-node ../scripts/seed.ts
```

## Local Development

### Start Local Environment

```bash
# Start DynamoDB Local, LocalStack, and API server
docker-compose up
```

This starts:
- **DynamoDB Local** on port 8000
- **LocalStack** (EventBridge, SNS, S3) on port 4566
- **API server** on port 3000

### Create Local Tables

```bash
# Create Entities table
aws dynamodb create-table \
  --table-name SwarmAid-Entities \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
    AttributeName=GSI2PK,AttributeType=S \
    AttributeName=GSI2SK,AttributeType=S \
    AttributeName=GSI3PK,AttributeType=S \
    AttributeName=GSI3SK,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    IndexName=GSI1,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL} \
    IndexName=GSI2,KeySchema=[{AttributeName=GSI2PK,KeyType=HASH},{AttributeName=GSI2SK,KeyType=RANGE}],Projection={ProjectionType=ALL} \
    IndexName=GSI3,KeySchema=[{AttributeName=GSI3PK,KeyType=HASH},{AttributeName=GSI3SK,KeyType=RANGE}],Projection={ProjectionType=ALL} \
  --endpoint-url http://localhost:8000

# Create Audit table
aws dynamodb create-table \
  --table-name SwarmAid-Audit \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    IndexName=GSI1,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL} \
  --endpoint-url http://localhost:8000
```

### Test API Locally

```bash
# Get Cognito JWT token (use AWS CLI or amplify)
export TOKEN="<your-jwt-token>"

# Create listing
curl -X POST http://localhost:3000/supply \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fresh Produce",
    "description": "Surplus apples",
    "category": "perishable_food",
    "quantity": 100,
    "quantityUnit": "lbs",
    "estimatedValue": 200,
    "pickupAddress": {
      "street": "123 Main St",
      "city": "San Francisco",
      "state": "CA",
      "postalCode": "94102",
      "country": "USA"
    },
    "pickupWindow": {
      "start": "2024-01-20T10:00:00Z",
      "end": "2024-01-20T14:00:00Z"
    },
    "requiresRefrigeration": true,
    "handlingRequirements": ["refrigerated_transport"]
  }'
```

## Testing

### Run Unit Tests

```bash
cd services
npm test
```

Tests cover:
- Compliance engine (6 rules)
- State machine transitions
- Matching score calculations

### Run Simulation

```bash
# Simulate driver delivering a task over 60 minutes
cd services
ts-node ../scripts/simulate.ts --duration=60 --interval=10 --driver=driver-001
```

## API Documentation

See [docs/openapi.yaml](./docs/openapi.yaml) for complete OpenAPI 3.0 specification.

### Key Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/supply` | POST | Create surplus listing |
| `/supply` | GET | List surplus listings |
| `/supply/{id}` | GET | Get listing details |
| `/supply/{id}/cancel` | POST | Cancel listing |
| `/demand` | POST | Create demand post |
| `/demand` | GET | List demand posts |
| `/matches/recommendations` | POST | Create match recommendations |
| `/matches` | GET | List matches |
| `/matches/{id}/accept` | POST | Accept match |
| `/matches/{id}/schedule` | POST | Schedule delivery |
| `/compliance/queue` | GET | Compliance review queue |
| `/compliance/{matchId}/approve` | POST | Approve with override |
| `/driver/tasks` | GET | Get assigned tasks |
| `/driver/tasks/{id}/status` | POST | Update task status |
| `/driver/tasks/{id}/location` | POST | Update location |
| `/ops/dashboard` | GET | Operator metrics |
| `/me` | GET | Get user profile |
| `/events` | GET | Poll for events |

## State Machine

```
posted → matched → scheduled → picked_up → delivered
   ↓        ↓          ↓           ↓
canceled  canceled   failed     failed
   ↓
expired
```

Roles and permissions:
- **system**: posted → matched
- **operator**: matched → scheduled, any → canceled
- **driver**: scheduled → picked_up, picked_up → delivered, any → failed
- **admin**: any → any (with justification)

## Compliance Rules

1. **REF-001**: Refrigeration time limit (4 hours for perishable)
2. **EXP-001**: Expiration date validation (24 hours minimum buffer)
3. **QUAL-001**: Quality notes keyword blocking (moldy, spoiled, etc.)
4. **TIME-001**: Pickup window validation (must be future)
5. **CAP-001**: Capacity validation (quantity ≤ capacity)
6. **DIST-001**: Distance validation (≤ 100 miles default)

## Matching Algorithm

Weighted scoring (0-100):
- **Distance** (30%): Closer is better (exponential decay)
- **Time overlap** (25%): Longer overlap window is better
- **Category match** (20%): Exact match = 1.0, related = 0.5
- **Capacity fit** (15%): 70-90% utilization is optimal
- **Reliability** (10%): Historical success rate (future enhancement)

## Monitoring

### CloudWatch Dashboards

View metrics at: https://console.aws.amazon.com/cloudwatch/

Key metrics:
- API request rate and latency
- Lambda invocation count, errors, throttles
- DynamoDB read/write capacity
- Step Functions execution status
- SNS delivery success rate

### Alarms

Automatic alarms for:
- Lambda error rate > 5%
- API Gateway 5xx errors
- DynamoDB throttling
- Step Functions failures

### X-Ray Tracing

View distributed traces at: https://console.aws.amazon.com/xray/

## Security

- **Authentication**: Cognito JWT validation on all endpoints
- **Authorization**: RBAC enforced in handlers + state machine
- **API Protection**: WAF with rate limiting (2000 req/5min per IP)
- **Encryption**: DynamoDB and S3 encrypted at rest (AES-256)
- **Secrets**: Gemini API key in Secrets Manager (automatic rotation ready)
- **Audit**: Immutable audit log for all state changes
- **Network**: Lambda in VPC (optional, configure in CDK stack)

## Troubleshooting

### Common Issues

**"Access Denied" errors**:
- Verify IAM permissions in CDK stack
- Check Lambda execution role has DynamoDB/S3/SNS access

**"Throttling" errors**:
- Increase DynamoDB capacity or use on-demand billing
- Check CloudWatch for throttling metrics

**Gemini API failures**:
- Verify API key in Secrets Manager
- Check enrichment fallback is working (status: 'degraded')

**Location Service errors**:
- Verify Amazon Location Service is enabled
- Check haversine fallback is activated

### Logs

View Lambda logs:
```bash
aws logs tail /aws/lambda/SwarmAid-SupplyHandler --follow
```

View all SwarmAid logs:
```bash
aws logs tail /aws/lambda/SwarmAid-* --follow --filter-pattern "ERROR"
```

## Contributing

1. Fork repository
2. Create feature branch (`git checkout -b feature/my-feature`)
3. Write tests for new functionality
4. Run linter (`npm run lint`)
5. Commit changes (`git commit -am 'Add feature'`)
6. Push branch (`git push origin feature/my-feature`)
7. Create Pull Request

## License

MIT License - see LICENSE file for details

## Support

- **Issues**: https://github.com/your-org/swarmaid-backend/issues
- **Docs**: https://github.com/your-org/swarmaid-backend/wiki
- **Email**: support@swarmaid.org

---

Built with ❤️ for disaster relief coordination
