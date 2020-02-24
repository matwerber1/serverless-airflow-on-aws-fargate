import * as cdk from '@aws-cdk/core';
import rds = require('@aws-cdk/aws-rds');
import secretsmanager = require('@aws-cdk/aws-secretsmanager');

const CFG = {
  db: {
    databaseName: 'airflow',
    dbClusterIdentifier: 'airflow',
    engine: 'aurora',
    engineMode: 'serverless',
    masterUsername: 'admin',
    port: 3306,
    autoPause: false,
    minCapacity: 1, 
    maxCapacity: 8,
    SecondsUntilAutoPause: 3600,
    subnetIds: ['subnet-0cc5bd19c2c1829aa', 'subnet-02b4e00939e9f33bc'] // list of pre-existing subnet IDs
  }
};

export class AwsAirflowEcsFargateStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    
    // Generate an AWS Secrets Manager secret that will contain database username and password: 
    const databaseSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: CFG.db.masterUsername }),
        generateStringKey: 'password',
        excludeCharacters: '@/" ',     // these chars not allowed: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html
        includeSpace: false, // not allowed for RDS master password
        passwordLength: 30
      }
    });

    const dbSubnetGroup = new rds.CfnDBSubnetGroup(this, 'DatabaseSubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for Airflow database',
      subnetIds: CFG.db.subnetIds
    });

    const aurora = new rds.CfnDBCluster(this, 'AuroraServerless', {
      databaseName: CFG.db.databaseName,
      dbClusterIdentifier: CFG.db.dbClusterIdentifier,
      engine: CFG.db.engine,
      engineMode: CFG.db.engineMode,
      masterUsername: CFG.db.masterUsername,
      masterUserPassword: databaseSecret.secretValueFromJson('password').toString(),
      port: CFG.db.port,
      dbSubnetGroupName: dbSubnetGroup.dbSubnetGroupName,
      scalingConfiguration: {
        autoPause: CFG.db.autoPause,
        maxCapacity: CFG.db.maxCapacity,
        minCapacity: CFG.db.minCapacity,
        //secondsUntilAutoPause: CFG.db.secondsUntilAutoPause
      }
    });


  }
}
