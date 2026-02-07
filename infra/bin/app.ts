#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SwarmAidStack } from '../lib/swarmaid-stack';

const app = new cdk.App();

// Environment configuration
// Account from CDK_DEFAULT_ACCOUNT (set via AWS CLI credentials)
// To hardcode account: account: '123456789012'
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1', // Explicitly set to us-east-1
};

new SwarmAidStack(app, 'SwarmAidFoundation', {
  env,
  stackName: 'SwarmAidFoundation',
  description: 'SwarmAid Foundation Stack: DynamoDB, Secrets Manager, and verification Lambda',
  tags: {
    Application: 'SwarmAid',
    Environment: process.env.ENVIRONMENT || 'dev',
    ManagedBy: 'CDK',
  },
});

app.synth();
