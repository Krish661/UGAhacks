# SwarmAid Backend Architecture

## Overview

SwarmAid is a disaster relief coordination platform that connects suppliers with surplus resources to recipients in need, coordinating delivery through available drivers. The backend is a serverless, event-driven system built on AWS with AI-powered enrichment via Google Gemini.

## Architecture Principles

1. **Serverless-first**: Lambda functions for compute, reducing operational overhead
2. **Event-driven**: EventBridge and Step Functions for asynchronous workflows
3. **Defense in depth**: Multiple layers of security (WAF, Cognito, IAM, encryption)
4. **Observability by default**: Structured logging, X-Ray tracing, CloudWatch metrics/alarms
5. **Graceful degradation**: Fallbacks for external dependencies (Gemini, Location Service)
6. **Audit everything**: Immutable audit trail for all state changes
7. **Idempotency**: Prevent duplicate operations with idempotency keys

## High-Level Architecture

```
┌─────────────┐
│   Client    │
│  (Frontend) │
└──────┬──────┘
       │
       │ HTTPS
       ▼
┌─────────────────────────────────────────────────────────┐
│                    AWS WAF                               │
│  (Rate limiting, Common attack protection)              │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│            API Gateway (HTTP API)                        │
│  - Lambda Authorizer (Cognito JWT validation)           │
│  - CORS configuration                                    │
│  - Request validation                                    │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                Lambda Functions                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Supply   │  │ Demand   │  │ Matches  │  ...         │
│  │ Handler  │  │ Handler  │  │ Handler  │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└──────┬────────────────┬────────────────┬────────────────┘
       │                │                │
       │                │                │
       ▼                ▼                ▼
┌──────────────────────────────────────────────┐
│              DynamoDB Tables                  │
│  - Entities (listings, demands, matches)     │
│  - Audit Events (immutable log)              │
│  GSI: Status, Geo, User, Actor               │
└──────────────────────────────────────────────┘
       │
       │ (On create/update)
       ▼
┌──────────────────────────────────────────────┐
│         Step Functions Orchestration          │
│  1. Enrich with Gemini (parse, categorize)  │
│  2. Find candidate matches (geo + rules)     │
│  3. Compute match scores                     │
│  4. Run compliance checks (deterministic)    │
│  5. Generate route plan (Location Service)   │
│  6. Create match recommendations             │
│  7. Notify parties (SNS)                     │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│              EventBridge                      │
│  (Event routing to subscribers)              │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│               SNS Topics                      │
│  (Email/SMS notifications)                   │
└──────────────────────────────────────────────┘

External Integrations:
┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│ Google       │  │ Amazon Location  │  │  Cognito     │
│ Gemini API   │  │  Service         │  │  (Auth)      │
└──────────────┘  └──────────────────┘  └──────────────┘
```

## Data Model

### DynamoDB Key Design

Single-table design with composite keys:

**Entities Table (SwarmAid-Entities)**
- PK: `<EntityType>#<ID>` (e.g., `LISTING#01HX...`, `DEMAND#01HY...`)
- SK: `METADATA` or related entity references
- GSI-Status: EntityType + Status
- GSI-Geo: GeoHash + CreatedAt
- GSI-User: UserId + CreatedAt

**Audit Table (SwarmAid-AuditEvents)**
- PK: EntityId
- SK: Timestamp (ISO 8601)
- GSI-Actor: Actor + Timestamp

### Entity Types

1. **SurplusListing**: Food/supplies available for donation
2. **DemandPost**: Request from recipient organization
3. **MatchRecommendation**: Proposed match between supply and demand
4. **DeliveryTask**: Assigned delivery with driver
5. **RoutePlan**: Route geometry, distance, duration
6. **ComplianceCheck**: Compliance decision record
7. **UserProfile**: User metadata, preferences, reliability score
8. **AuditEvent**: Immutable change log

## State Machine

### Delivery Lifecycle

```
        ┌──────────┐
        │  posted  │
        └────┬─────┘
             │
             ▼
      ┌──────────────┐
      │   matched    │
      └──────┬───────┘
             │
             ▼
      ┌──────────────┐
      │  scheduled   │
      └──────┬───────┘
             │
             ▼
      ┌──────────────┐
      │  picked_up   │
      └──────┬───────┘
             │
             ▼
      ┌──────────────┐
      │  delivered   │
      └──────────────┘

At any point:
  → canceled (with reason)
  → failed (with reason)
  → expired (automatic)
```

### State Transitions (with authorization)

| From       | To         | Who                    | Conditions                      |
|------------|------------|------------------------|---------------------------------|
| posted     | matched    | System (orchestration) | Match found, compliance passed  |
| matched    | scheduled  | Operator               | Driver assigned                 |
| scheduled  | picked_up  | Driver                 | At pickup location              |
| picked_up  | delivered  | Driver                 | At dropoff location             |
| *          | canceled   | Owner/Operator/Admin   | With justification              |
| *          | failed     | System/Operator        | After retry exhaustion          |
| posted     | expired    | System (cron)          | Pickup window lapsed            |

## Role-Based Access Control (RBAC)

### Roles (Cognito Groups)

- **supplier**: Create/manage own surplus listings
- **recipient**: Create/manage own demand posts
- **driver**: View assigned tasks, update status/location
- **compliance**: Approve/block matches
- **operator**: Full read access, override capabilities
- **admin**: Full access including user management

### Authorization Matrix

| Endpoint                  | supplier | recipient | driver | compliance | operator | admin |
|---------------------------|----------|-----------|--------|------------|----------|-------|
| POST /supply              | ✓        |           |        |            | ✓        | ✓     |
| GET /supply (own)         | ✓        |           |        |            | ✓        | ✓     |
| GET /supply (all)         |          |           |        |            | ✓        | ✓     |
| POST /demand              |          | ✓         |        |            | ✓        | ✓     |
| GET /demand (own)         |          | ✓         |        |            | ✓        | ✓     |
| GET /driver/tasks         |          |           | ✓      |            | ✓        | ✓     |
| POST /driver/tasks/status |          |           | ✓      |            | ✓        | ✓     |
| GET /compliance/queue     |          |           |        | ✓          | ✓        | ✓     |
| POST /compliance/approve  |          |           |        | ✓          | ✓        | ✓     |
| GET /ops/dashboard        |          |           |        |            | ✓        | ✓     |
| POST /ops/override        |          |           |        |            | ✓        | ✓     |

## Compliance Engine

### Deterministic Rules (Code-Based)

1. **Refrigeration Check**: Block if category requires cold chain and pickup window > 2 hours
2. **Expiration Check**: Block if expiration date < current date + 24 hours
3. **Quality Check**: Block if quality notes contain keywords: "spoiled", "moldy", "damaged"
4. **Pickup Window**: Block if pickup start time already passed
5. **Capacity Check**: Block if quantity > recipient capacity
6. **Distance Check**: Warn if distance > 50 miles (configurable)

### Gemini AI Enrichment (Advisory)

- Parse free-text notes into structured fields
- Normalize categories
- Extract handling requirements
- Generate risk score (0-100)
- Flag potential issues
- **NOT used as final compliance gate**

## Matching Algorithm

### Scoring Function

```
score = w1 * distanceScore + w2 * timeScore + w3 * categoryScore + w4 * capacityScore + w5 * reliabilityScore

where:
  distanceScore = 1 - (distance / maxDistance)
  timeScore = pickupWindowOverlap / totalPickupWindow
  categoryScore = exactMatch ? 1.0 : categoryIntersection / categoryUnion
  capacityScore = min(quantity / capacity, 1.0)
  reliabilityScore = (supplierReliability + recipientReliability) / 2

weights (w1-w5) are configurable via environment variables
```

### Matching Process

1. Query open listings/demands by geohash prefix (configurable radius)
2. Filter by category compatibility
3. Compute scores for all candidates
4. Sort by score descending
5. Take top N recommendations (default: 5)
6. Run compliance checks
7. Persist match recommendations with status=pending

## Observability

### Structured Logging

All logs are JSON with:
- `timestamp`: ISO 8601
- `level`: debug|info|warn|error
- `message`: Human-readable
- `requestId`: Correlation ID
- `userId`: Current user
- `operation`: Handler/function name
- `duration`: Milliseconds
- `error`: Error details (if applicable)

### Distributed Tracing

AWS X-Ray enabled on:
- API Gateway
- Lambda functions
- Step Functions
- DynamoDB calls
- External HTTP calls

### Metrics and Alarms

**Lambda Metrics**:
- Errors (threshold: 5 in 1 minute)
- Throttles (threshold: 5 in 1 minute)
- Duration (P99 > timeout warning)

**API Gateway Metrics**:
- 4xx rate (threshold: 10% of traffic)
- 5xx rate (threshold: 1% of traffic)
- Latency (P99 > 2s)

**Step Functions Metrics**:
- Execution failures (threshold: 5 in 5 minutes)
- Execution timeouts

**DynamoDB Metrics**:
- Read throttles
- Write throttles
- System errors

**Custom Metrics**:
- Match success rate
- Average matching time
- Compliance rejection rate
- Delivery completion rate

## Security

### Defense Layers

1. **WAF**: Rate limiting (2000 req/5min per IP), AWS managed rule sets
2. **API Gateway**: Cognito JWT validation via Lambda authorizer
3. **Lambda**: Least-privilege IAM roles per function
4. **DynamoDB**: Encryption at rest (AWS managed keys)
5. **S3**: Encryption at rest, block public access
6. **Secrets Manager**: API keys, connection strings
7. **Input Validation**: Zod schemas on all endpoints
8. **CORS**: Configured allow-list (not wildcard in production)

### Secrets Management

- Gemini API key: `swarmaid/gemini-api-key`
- Location Service API key: `swarmaid/location-service-api-key`

Secrets are:
- Never logged
- Cached in Lambda memory (with TTL)
- Accessed via AWS SDK with IAM permissions

## Reliability and Fallbacks

### Gemini API Failure

If Gemini is unavailable or returns error:
1. Log warning with request ID
2. Use basic text parsing (regex for categories, keywords)
3. Set enrichment status = "degraded"
4. Continue processing
5. Mark listing for manual review

### Location Service Failure

If Amazon Location Service is unavailable:
1. Use simple haversine distance calculation
2. Generate straight-line route
3. Estimate duration: distance / average_speed (45 mph)
4. Set provider_status = "degraded"
5. Continue processing

### Step Functions Retry Policy

- Lambda failures: 3 retries with exponential backoff (2s, 4s, 8s)
- Service exceptions: Automatic retry
- DLQ: Send failed executions to SNS topic for operator investigation

### Idempotency

- Status updates use idempotency keys (ULID + operation)
- Scheduling uses idempotency: matchId + driverId + scheduledTime
- DynamoDB conditional writes prevent race conditions

## Deployment

### Environments

- **local**: Docker Compose (DynamoDB Local, LocalStack)
- **dev**: AWS CDK deploy to development account
- **staging**: AWS CDK deploy to staging account
- **prod**: AWS CDK deploy to production account

### CI/CD (future)

1. GitHub Actions on push to main
2. Run unit tests and linters
3. CDK synth and validate
4. Deploy to dev environment
5. Run integration tests
6. Manual approval for staging/prod
7. Deploy with CloudFormation change sets

## Cost Optimization

- DynamoDB: Pay-per-request billing (no idle cost)
- Lambda: 512MB memory, 30s timeout (right-sized)
- S3: Lifecycle policies for old attachments/exports
- CloudWatch Logs: 30-day retention
- API Gateway: HTTP API (cheaper than REST API)
- No NAT Gateway (Lambda in public subnet with IGW for AWS service access)

## Scalability

- API Gateway: 10,000 RPS steady-state, burst to 50,000
- Lambda: 1,000 concurrent executions per region (adjustable)
- DynamoDB: Auto-scales to millions of RPS
- Step Functions: 4,000 executions/second
- EventBridge: Unlimited throughput

## Disaster Recovery

- DynamoDB: Point-in-time recovery (35 days)
- S3: Versioning enabled
- Cross-region replication: NOT implemented (single-region for MVP)
- RTO: 1 hour (redeploy stack)
- RPO: 5 minutes (DynamoDB PITR granularity)

## Testing Strategy

1. **Unit Tests**: Domain logic (compliance, matching, state machine)
2. **Integration Tests**: Lambda handlers with mocked AWS services
3. **Contract Tests**: API schema validation (OpenAPI)
4. **Load Tests**: Artillery/k6 against deployed environment
5. **Chaos Engineering**: Random Lambda failures, latency injection

## Monitoring Runbook

### Common Issues

**High API 4xx Rate**
- Check: WAF blocks, invalid tokens, malformed requests
- Action: Review API Gateway logs, check Cognito token expiry

**High API 5xx Rate**
- Check: Lambda errors, DynamoDB throttles, timeout
- Action: Review Lambda CloudWatch Logs, check X-Ray traces

**Step Functions Failures**
- Check: Lambda execution errors, timeout
- Action: Review state machine execution history, check input/output

**Low Match Rate**
- Check: Compliance blocks, no candidates in geo radius
- Action: Review compliance check results, adjust matching radius

**Notification Delivery Failures**
- Check: SNS delivery status, invalid email/phone
- Action: Review SNS CloudWatch metrics, validate user preferences

## API Versioning

Current version: `v1`
All endpoints prefixed: `/v1/...`

Breaking changes require new version: `/v2/...`

## Future Enhancements

1. WebSocket support for real-time updates
2. Multi-region active-active deployment
3. GraphQL API via AppSync
4. Mobile push notifications via SNS Mobile
5. Advanced routing with traffic optimization
6. ML-based match scoring
7. Blockchain audit trail (immutable, decentralized)
8. Predictive demand forecasting
