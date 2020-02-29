import * as cdk from '@aws-cdk/core';
import rds = require('@aws-cdk/aws-rds');
import secretsmanager = require('@aws-cdk/aws-secretsmanager');
import ec2 = require("@aws-cdk/aws-ec2");
import ecs = require("@aws-cdk/aws-ecs");
import s3 = require("@aws-cdk/aws-s3");
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
var fs = require('fs');
var path = require('path');

const CFG = {
  db: {
    databaseName: 'airflow',
    dbClusterIdentifier: 'aurora-airflow',
    engine: 'aurora-postgresql',
    engineMode: 'serverless',
    masterUsername: 'airflow',
    port: 5432,
    autoPause: false,
    minCapacity: 2, 
    maxCapacity: 8,
    SecondsUntilAutoPause: 3600,
    subnetIds: ['subnet-0cc5bd19c2c1829aa', 'subnet-02b4e00939e9f33bc'], // list of pre-existing subnet IDs
    vpcSecurityGroupIds: ['sg-00e88c6dc027cc7ce']
  },
  ecs: {
    vpcId: 'vpc-23d0fe58'
  }
};

export class AwsAirflowEcsFargateStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const databasePasswordSecret = new secretsmanager.Secret(this, 'AirflowDatabasePassword', {
      secretName: "airflow/postgres/password"
    });

    // S3 Bucket to which we will ship airflow logs: 
    const airflowLogBucket = new s3.Bucket(this, 'airflowLogBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    var s3_log_path = "s3://" + airflowLogBucket.bucketName + "/logs"

    // Define the subnet group which our Aurora cluster will use: 
    const dbSubnetGroup = new rds.CfnDBSubnetGroup(this, 'DatabaseSubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for Airflow database',
      dbSubnetGroupName: 'airflow-db-subnet-group',
      subnetIds: CFG.db.subnetIds
    });
    
    // The Aurora database that our airflow service will use:
    const aurora = new rds.CfnDBCluster(this, 'AuroraAirflow', {
      databaseName: CFG.db.databaseName,
      dbClusterIdentifier: CFG.db.dbClusterIdentifier,
      engine: CFG.db.engine,
      engineMode: CFG.db.engineMode,
      masterUsername: CFG.db.masterUsername,
      masterUserPassword: databasePasswordSecret.secretValue.toString(),
      port: CFG.db.port,
      dbSubnetGroupName: dbSubnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: CFG.db.vpcSecurityGroupIds,
      scalingConfiguration: {
        autoPause: CFG.db.autoPause,
        maxCapacity: CFG.db.maxCapacity,
        minCapacity: CFG.db.minCapacity,
        //secondsUntilAutoPause: CFG.db.secondsUntilAutoPause
      }
    });

    aurora.node.addDependency(dbSubnetGroup);

    
    // The vpc that our ECS Fargate tasks will use: 
    const ecsVpc = ec2.Vpc.fromLookup(this, 'ecsVpc', {
      vpcId: CFG.ecs.vpcId
    }); 

    // ECS cluster in which our Airflow cluster will run: 
    const ecsCluster = new ecs.Cluster(this, "ecsCluster", {
      vpc: ecsVpc
    });

    //--------------------------------------------------------------------------
    // AIRFLOW DOCKER IMAGE
    //--------------------------------------------------------------------------
    const airflowImage = new DockerImageAsset(this, 'airflowImage', {
      directory: path.join(__dirname, 'docker'),
      repositoryName: 'airflow'
    });
    
    //--------------------------------------------------------------------------
    // TASK DEFINITIONS
    //--------------------------------------------------------------------------
    const webserverTaskDefinition = new ecs.FargateTaskDefinition(this, 'webserverTaskDefinition', {
      family: 'airflow_webserver',
      cpu: 512,
      memoryLimitMiB: 1024
    });

    webserverTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromEcrRepository(airflowImage.repository),
      command: ['webserver'],
      environment: {
        POSTGRES_DB: CFG.db.databaseName, 
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        S3_LOG_PATH: s3_log_path
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret)
      }
    })
      .addPortMappings({ containerPort: 8080 });
    
    
    const schedulerTaskDefinition = new ecs.FargateTaskDefinition(this, 'schedulerTaskDefinition', {
      family: 'airflow_scheduler',
      cpu: 512,
      memoryLimitMiB: 2048
    });

    schedulerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromEcrRepository(airflowImage.repository),
      command: ['scheduler'],
      environment: {
        POSTGRES_DB: CFG.db.databaseName, 
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        REDIS_HOST: 'redis.airflow.celery',
        S3_LOG_PATH: s3_log_path
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret)
      }
    });
    
    const flowerTaskDefinition = new ecs.FargateTaskDefinition(this, 'flowerTaskDefinition', {
      family: 'airflow_flower',
      cpu: 256,
      memoryLimitMiB: 512
    });

    flowerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromEcrRepository(airflowImage.repository),
      command: ['flower'],
      environment: {
        POSTGRES_DB: CFG.db.databaseName, 
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        S3_LOG_PATH: s3_log_path
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret)
      }
    })
    .addPortMappings({ containerPort: 5555 });;

    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'workerTaskDefinition', {
      family: 'airflow_worker',
      cpu: 1024,
      memoryLimitMiB: 3072
    });

    workerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromEcrRepository(airflowImage.repository),
      command: ['worker'],
      environment: {
        POSTGRES_DB: CFG.db.databaseName, 
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        REDIS_HOST: 'redis.airflow.celery',
        S3_LOG_PATH: s3_log_path
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret)
      }
    })
    .addPortMappings({ containerPort: 8793 });;
    
    const redisTaskDefinition = new ecs.FargateTaskDefinition(this, 'redisTaskDefinition', {
      family: 'airflow_redis',
      cpu: 1024,
      memoryLimitMiB: 2048
    });

    redisTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry('docker.io/redis:5.0.5'),
      environment: {
        POSTGRES_DB: CFG.db.databaseName, 
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        S3_LOG_PATH: s3_log_path
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret)
      }
    })
      .addPortMappings({ containerPort: 6379 });;
  
    //--------------------------------------------------------------------------
    // SERVICE DEFINITIONS
    //--------------------------------------------------------------------------
    /*
    const webserverService = new ecs.FargateService(this, 'webserverService', {
      cluster: ecsCluster,
      taskDefinition: webserverTaskDefinition,
      desiredCount: 1
    });
      
    //--------------------------------------------------------------------------
    // APPLICATION LOAD BALANCER
    //--------------------------------------------------------------------------

    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc: ecsVpc,
      internetFacing: false
    });
      
    const listener = lb.addListener('Listener', {
      port: 80,
      open: true,
    });

    const webserverTargetGroup = new elbv2.ApplicationTargetGroup(this, 'webserverTargetGroup', {
      port: 8080,
      targetGroupName: 'airflow-webserver-tg',
      targetType: elbv2.TargetType.IP,
      vpc: ecsVpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webserverService]
    });
      
    listener.addTargetGroups('targetGroupAddition', {
      targetGroups: [webserverTargetGroup]
    });
    */
    
  }
}
