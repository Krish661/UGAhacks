# SwarmAid Infrastructure

AWS CDK infrastructure for SwarmAid food surplus redistribution backend.

## Prerequisites

- Node.js 20+ and npm 10+
- AWS CLI configured with profile: `swarmaid`
- AWS CDK CLI installed globally: `npm install -g aws-cdk`
- CDK bootstrapped in us-east-1: `cdk bootstrap --profile swarmaid`

## Project Structure

```
infra/
├── bin/
│   └── app.ts          # CDK app entry point
├── lib/
│   └── swarmaid-stack.ts  # Foundation stack definition
├── cdk.json            # CDK configuration
├── package.json        # Dependencies
└── tsconfig.json       # TypeScript configuration
```

## Quick Start (Windows PowerShell)

### 1. Install Dependencies

```powershell
# Navigate to infra directory
cd infra

# Install dependencies (uses workspace node_modules from parent)
npm install
```

### 2. Build TypeScript

```powershell
npm run build
```

### 3. Synthesize CloudFormation Template

```powershell
npm run synth
```

This generates the CloudFormation template to `cdk.out/` directory.

### 4. Deploy Foundation Stack

```powershell
npm run deploy
```

Or manually with CDK:

```powershell
cdk deploy --profile swarmaid
```

**Expected Output:**
- DynamoDB table: `SwarmAidMainTable`
- Secrets Manager secret: `/swarmaid/gemini-api-key`
- Lambda function: Verification Lambda for secret access
- CloudFormation outputs showing resource names and ARNs

### 5. Set Gemini API Key Secret

After deployment, update the secret with your actual Gemini API key:

```powershell
aws secretsmanager put-secret-value `
  --secret-id /swarmaid/gemini-api-key `
  --secret-string "YOUR_GEMINI_API_KEY_HERE" `
  --profile swarmaid `
  --region us-east-1
```

**Important:** Replace `YOUR_GEMINI_API_KEY_HERE` with your actual Google Gemini API key.

### 6. Verify Secret Access

Test the verification Lambda to ensure it can read the secret:

```powershell
# Get the Lambda function name from stack outputs
$functionName = (aws cloudformation describe-stacks `
  --stack-name SwarmAidFoundation `
  --query "Stacks[0].Outputs[?OutputKey=='VerifyLambdaName'].OutputValue" `
  --output text `
  --profile swarmaid `
  --region us-east-1)

# Invoke the Lambda
aws lambda invoke `
  --function-name $functionName `
  --profile swarmaid `
  --region us-east-1 `
  response.json

# View the response
cat response.json
```

**Expected Response:**
```json
{
  "statusCode": 200,
  "body": "{\"status\":\"ok\",\"secretExists\":true,\"secretHasValue\":true,\"message\":\"Secret access verified successfully\"}"
}
```

## Available Commands

```powershell
# Build TypeScript
npm run build

# Watch mode (rebuild on file changes)
npm run watch

# Synthesize CloudFormation template
npm run synth

# Show differences between deployed and local
npm run diff

# Deploy stack
npm run deploy

# Destroy stack (caution: deletes all resources)
npm run destroy
```

## Foundation Stack Resources

### DynamoDB Table: SwarmAidMainTable
- **Partition Key:** `pk` (String)
- **Sort Key:** `sk` (String)
- **Billing Mode:** PAY_PER_REQUEST (on-demand)
- **Point-in-Time Recovery:** Enabled
- **Removal Policy:** DESTROY (for dev - change for production!)

### Secrets Manager: /swarmaid/gemini-api-key
- Stores Google Gemini API key for AI enrichment
- Used by backend services for natural language processing

### Lambda: VerifySecretLambda
- Verifies access to Secrets Manager
- Returns status of secret (exists, has value)
- IAM permissions: Read-only access to Gemini secret

## Stack Outputs

After deployment, the stack provides these outputs:

- `TableName`: DynamoDB table name
- `SecretName`: Secrets Manager secret name  
- `SecretArn`: Full ARN of the secret
- `VerifyLambdaName`: Lambda function name for verification
- `Region`: Deployment region (us-east-1)

View outputs:

```powershell
aws cloudformation describe-stacks `
  --stack-name SwarmAidFoundation `
  --query "Stacks[0].Outputs" `
  --profile swarmaid `
  --region us-east-1
```

## Troubleshooting (Windows)

### Issue: Cannot find module 'aws-cdk-lib'

**Solution:** Ensure you've run `npm install` in both the root workspace and infra folder:

```powershell
# From root directory
cd "C:\Users\Samia Moid\Desktop\UGA Hacks 11"
npm install

# From infra directory
cd infra
npm install
```

### Issue: TypeScript errors about 'process' not defined

**Solution:** The workspace uses shared node_modules. Ensure `@types/node` is installed in the root:

```powershell
# From root directory
npm install --save-dev @types/node
```

### Issue: CDK deploy fails with "Need to perform AWS calls for account"

**Solution:** Ensure your AWS profile is configured correctly:

```powershell
# Verify profile exists
aws configure list --profile swarmaid

# Test credentials
aws sts get-caller-identity --profile swarmaid

# Bootstrap CDK (if not already done)
cdk bootstrap --profile swarmaid
```

### Issue: PowerShell command line too long

**Solution:** Use backticks (`) for line continuation in PowerShell:

```powershell
aws secretsmanager put-secret-value `
  --secret-id /swarmaid/gemini-api-key `
  --secret-string "key" `
  --profile swarmaid
```

### Issue: Build fails with errors from /services folder

**Solution:** The `tsconfig.json` should exclude `/services`. Verify the exclude section:

```json
"exclude": [
  "node_modules",
  "cdk.out",
  "../services",
  "../scripts",
  "../swarmaid"
]
```

### Issue: CDK diff shows unwanted changes

**Solution:** Run `cdk synth` first to regenerate templates, then `cdk diff`:

```powershell
npm run synth
npm run diff
```

### Issue: Deploy hangs or times out

**Solution:** Check CloudFormation events in AWS Console or via CLI:

```powershell
aws cloudformation describe-stack-events `
  --stack-name SwarmAidFoundation `
  --profile swarmaid `
  --region us-east-1 `
  --max-items 20
```

## Environment Configuration

The stack reads environment from:
- `CDK_DEFAULT_ACCOUNT`: AWS account ID (from AWS CLI credentials)
- `ENVIRONMENT`: Environment tag (defaults to 'dev')
- Region: Explicitly set to `us-east-1` in app.ts

To set environment before deploy:

```powershell
$env:ENVIRONMENT = "dev"
npm run deploy
```

## Next Steps

After the foundation stack is deployed and verified:

1. **Add Cognito User Pool** - User authentication
2. **Add API Gateway** - REST API endpoints
3. **Add Step Functions** - Orchestration workflows
4. **Add EventBridge** - Event-driven architecture
5. **Add SNS** - Notifications
6. **Add CloudWatch** - Logging and monitoring
7. **Add WAF** - API security
8. **Add Amazon Location Service** - Geospatial features

## Security Notes

- The current stack uses `RemovalPolicy.DESTROY` for easy cleanup during development
- **For production:** Change to `RemovalPolicy.RETAIN` to prevent accidental data loss
- Secret values are not stored in CloudFormation templates
- Lambda uses the AWS SDK v3 which is included in Node.js 20 runtime
- IAM permissions follow least-privilege principle (Lambda can only read the specific secret)

## Cost Estimation

Foundation stack costs (us-east-1):
- **DynamoDB:** Pay per request (~$1.25 per million requests)
- **Secrets Manager:** $0.40/month per secret + $0.05 per 10k API calls
- **Lambda:** Free tier: 1M requests/month + 400k GB-seconds
- **CloudFormation:** No charge

**Estimated monthly cost for dev:** ~$1-5 depending on usage

## Support

For issues:
1. Check the troubleshooting section above
2. Review CloudFormation events: AWS Console → CloudFormation → SwarmAidFoundation → Events
3. Check Lambda logs: AWS Console → CloudWatch → Log Groups
4. Verify IAM permissions: AWS Console → IAM → Roles

---

**Built with AWS CDK v2 | TypeScript | Node.js 20**
