#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsAirflowEcsFargateStack } from '../lib/aws-airflow-ecs-fargate-stack';

const app = new cdk.App();
new AwsAirflowEcsFargateStack(app, 'AwsAirflowEcsFargateStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:process.env.CDK_DEFAULT_REGION
  }
});
