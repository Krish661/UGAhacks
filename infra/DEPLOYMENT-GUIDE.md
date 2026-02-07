# SwarmAid Backend - Cognito + API Gateway Deployment

## 📝 What Was Added

### Files Changed:
- **infra/lib/swarmaid-stack.ts** - Added Cognito User Pool, API Gateway, and Lambda handlers

### New Resources:
1. **Cognito User Pool** - Email-based authentication
2. **Cognito App Client** - Web client (no secret) for frontend
3. **Cognito Groups** - supplier, recipient, driver, compliance, operator, admin
4. **API Gateway REST API** - `/v1/health` and `/v1/me` endpoints
5. **Lambda Functions** - Health check and user info handlers
6. **Cognito Authorizer** - Protects `/v1/me` endpoint

## 🚀 Deploy Command

```powershell
cdk deploy --profile swarmaid
```

## 📊 Expected Outputs

After deployment you'll see these new outputs:

- **UserPoolId** - Cognito User Pool ID
- **UserPoolClientId** - App Client ID for frontend
- **UserPoolIssuerUrl** - JWT issuer URL for token validation
- **ApiUrl** - Base API Gateway URL
- **ApiId** - REST API ID
- **HealthEndpoint** - Public health check URL
- **MeEndpoint** - Protected user info URL

## ✅ Test Plan

### 1. Test Public Health Endpoint

```powershell
curl https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/v1/health
```

**Expected Response:**
```json
{
  "ok": true,
  "timestamp": "2026-02-07T06:30:00.000Z"
}
```

### 2. Create a Test User

```powershell
aws cognito-idp sign-up --region us-east-1 --client-id YOUR_CLIENT_ID --username test@example.com --password Test1234! --user-attributes Name=email,Value=test@example.com --profile swarmaid
```

### 3. Confirm the User (Admin Action)

```powershell
aws cognito-idp admin-confirm-sign-up --region us-east-1 --user-pool-id YOUR_USER_POOL_ID --username test@example.com --profile swarmaid
```

### 4. Add User to a Group

```powershell
aws cognito-idp admin-add-user-to-group --region us-east-1 --user-pool-id YOUR_USER_POOL_ID --username test@example.com --group-name supplier --profile swarmaid
```

### 5. Get Authentication Token

```powershell
aws cognito-idp initiate-auth --region us-east-1 --auth-flow USER_PASSWORD_AUTH --client-id YOUR_CLIENT_ID --auth-parameters USERNAME=test@example.com,PASSWORD=Test1234! --profile swarmaid
```

**Save the `IdToken` from the response.**

### 6. Test Protected /me Endpoint

```powershell
curl -H "Authorization: Bearer YOUR_ID_TOKEN" https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/v1/me
```

**Expected Response:**
```json
{
  "sub": "uuid-here",
  "email": "test@example.com",
  "emailVerified": true,
  "groups": ["supplier"]
}
```

## 🎯 Quick Test Script

Save as `test-api.ps1`:

```powershell
# Get outputs from CloudFormation
$ApiUrl = aws cloudformation describe-stacks --stack-name SwarmAidFoundation --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text --profile swarmaid --region us-east-1
$UserPoolId = aws cloudformation describe-stacks --stack-name SwarmAidFoundation --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text --profile swarmaid --region us-east-1
$ClientId = aws cloudformation describe-stacks --stack-name SwarmAidFoundation --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text --profile swarmaid --region us-east-1

Write-Host "API URL: $ApiUrl"
Write-Host "User Pool ID: $UserPoolId"
Write-Host "Client ID: $ClientId"

# Test health endpoint
Write-Host "`nTesting /v1/health..."
curl "$($ApiUrl)v1/health"
```

## 📱 Frontend Integration

Provide these values to your frontend team:

```javascript
export const awsConfig = {
  region: 'us-east-1',
  userPoolId: 'us-east-1_XXXXXXXXX',  // From UserPoolId output
  userPoolClientId: 'XXXXXXXXXXXXXXXXXXXXXXXXXX',  // From UserPoolClientId output
  apiUrl: 'https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/prod',  // From ApiUrl output
};
```

They can use AWS Amplify or amazon-cognito-identity-js for authentication.

## 🔐 Security Notes

- **CORS is currently set to allow all origins** - This is for development only
- For production, restrict CORS to your frontend domain
- Cognito password policy requires: 8+ chars, uppercase, lowercase, digits
- User pool is set to DESTROY on stack deletion (dev only)
- All Lambda functions use Node.js 20 runtime

## 🚧 What's NOT Included Yet

- Step Functions orchestration
- EventBridge event-driven workflows
- SNS notifications
- Amazon Location Service
- CloudWatch detailed alarms
- WAF protection

These will be added in future incremental deployments.

---

**Ready to deploy!** Run: `cdk deploy --profile swarmaid`
