import * as cdk from '@aws-cdk/core';
import rds = require('@aws-cdk/aws-rds');
import secretsmanager = require('@aws-cdk/aws-secretsmanager');
import ec2 = require("@aws-cdk/aws-ec2");
import ecs = require("@aws-cdk/aws-ecs");
import s3 = require("@aws-cdk/aws-s3");
import iam = require("@aws-cdk/aws-iam");
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import servicediscovery = require('@aws-cdk/aws-servicediscovery');
import { RotationSchedule } from '@aws-cdk/aws-secretsmanager';
var fs = require('fs');
var path = require('path');

// Various configuration parameters; I'm not yet familiar enough with Airflow or
// the puckel/docker-airflow image to know which of these can be changed...
// Of course, you can definitely edit your subnet / VPC information. I used
// existing VPCs/subnets when creating this, rather than deploying new ones
// in the CDK. Eventually, maybe I'll remove these when everything is working. 
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
    vpcId: 'vpc-23d0fe58',
    securityGroup: 'sg-00e88c6dc027cc7ce'
  },
  cloudmap: {
    namespace: 'airflow',
    redisServiceName: 'redis',
    webserverServiceName: 'webserver',
    flowerServiceName: 'flower'
  },
  redis: {
    port: '6379'
  }
};

export class AwsAirflowEcsFargateStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //--------------------------------------------------------------------------
    // EXTERNAL RESOURCES
    //   These are pre-existing resources created outside of this CDK stack:
    //--------------------------------------------------------------------------
    
    const ecsVpc = ec2.Vpc.fromLookup(this, 'ecsVpc', { vpcId: CFG.ecs.vpcId }); 
    
    const ecsTaskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'taskSecurityGroup', CFG.ecs.securityGroup);
    
    var taskExecutionRoleArn = `arn:aws:iam::${props?.env?.account}:role/ecsTaskExecutionRole`;
    const taskExecutionRole = iam.Role.fromRoleArn(this, 'taskExecutionRole', taskExecutionRoleArn);

    //--------------------------------------------------------------------------
    // CDK RESOURCES
    //--------------------------------------------------------------------------
    //TODO - add restrictions to avoid invalid chars
    const databasePasswordSecret = new secretsmanager.Secret(this, 'AirflowDatabasePassword', {
      secretName: "airflow/postgres/password"
    });

     //TODO - add restrictions to avoid invalid chars (redis failed to launch for certain chars)
    const redisPasswordSecret = new secretsmanager.Secret(this, 'RedisPassword', {
      secretName: "airflow/redis/password"
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

    // ECS cluster in which our Airflow cluster will run: 
    const ecsCluster = new ecs.Cluster(this, "ecsCluster", {
      vpc: ecsVpc
    });

    //--------------------------------------------------------------------------
    // AIRFLOW DOCKER IMAGE
    //--------------------------------------------------------------------------
    // This will build the contents of the local docker/Dockerfile and upload to ECR: 
    const airflowImage = new DockerImageAsset(this, 'airflowImage', {
      directory: path.join(__dirname, 'docker'),
      repositoryName: 'airflow'
    });
    
    //--------------------------------------------------------------------------
    // TASK VARS
    //--------------------------------------------------------------------------
    
    var redis_host = `${CFG.cloudmap.redisServiceName}.${CFG.cloudmap.namespace}`;  // e.g. private DNS = redis.airflow

    var taskEnvironmentVars = {
      POSTGRES_DB: CFG.db.databaseName,
      POSTGRES_HOST: aurora.attrEndpointAddress,
      POSTGRES_PORT: aurora.attrEndpointPort,
      POSTGRES_USER: CFG.db.masterUsername,
      AIRFLOW__CORE__REMOTE_BASE_LOG_FOLDER: s3_log_path,
      REDIS_HOST: redis_host,
      REDIS_PORT: CFG.redis.port, 
      // Need to specify a key that is consistent across all airflow containers, otherwise they can't talk to one another: 
      FERNET_KEY: 'CQInk_dg4xsDrB-s2pvAt81cbddUNffTXqnGoRlPb5c='    // This needs to be migrated to an automated, secure way of generating a key
    };

    var taskSecrets = {
      POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret),
      REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret)
    };

    //--------------------------------------------------------------------------
    // CLOUDMAP
    //--------------------------------------------------------------------------

    // We will use a private DNS zone to give friendly names to our airflow services
    const airflowNamespace = new servicediscovery.PrivateDnsNamespace(this, 'airflowNamespace', {
      name: CFG.cloudmap.namespace,
      vpc: ecsVpc,
      description: 'Private DNS for airflow resources'
    });

    //--------------------------------------------------------------------------
    // TASK DEFINITION - WEBSERVER
    //--------------------------------------------------------------------------
    
    const webserverTaskDefinition = new ecs.FargateTaskDefinition(this, 'webserverTaskDefinition', {
      family: 'airflow_webserver',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: taskExecutionRole
    });
 
    webserverTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry(airflowImage.imageUri),
      command: ['webserver'],
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-webserver", logRetention: 365 }),
      environment: taskEnvironmentVars,
      secrets: taskSecrets
    })
      .addPortMappings({ containerPort: 8080 });
    
    const webserverService = new ecs.FargateService(this, 'webserverService', {
      serviceName: 'webserver',
      cluster: ecsCluster,
      taskDefinition: webserverTaskDefinition,
      desiredCount: 1,
      securityGroup: ecsTaskSecurityGroup,
      assignPublicIp: false,
      cloudMapOptions: {
        name: CFG.cloudmap.webserverServiceName,
        cloudMapNamespace: airflowNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(30)
      }
    });

    //--------------------------------------------------------------------------
    // TASK DEFINITION - SCHEDULER
    //--------------------------------------------------------------------------
    
    const schedulerTaskDefinition = new ecs.FargateTaskDefinition(this, 'schedulerTaskDefinition', {
      family: 'airflow_scheduler',
      cpu: 512,
      memoryLimitMiB: 2048,
      executionRole: taskExecutionRole
    });

    schedulerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry(airflowImage.imageUri),
      command: ['scheduler'],
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-scheduler", logRetention: 365 }),
      environment: taskEnvironmentVars,
      secrets: taskSecrets
    });
    
    const schedulerService = new ecs.FargateService(this, 'schedulerService', {
      serviceName: 'scheduler',
      cluster: ecsCluster,
      taskDefinition: schedulerTaskDefinition,
      desiredCount: 1,
      securityGroup: ecsTaskSecurityGroup,
      assignPublicIp: false
    });
    
    //--------------------------------------------------------------------------
    // TASK DEFINITION - FLOWER
    //--------------------------------------------------------------------------
    /*
    const flowerTaskDefinition = new ecs.FargateTaskDefinition(this, 'flowerTaskDefinition', {
      family: 'airflow_flower',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: taskExecutionRole
    });

    flowerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry(airflowImage.imageUri),
      command: ['flower'],
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-flower", logRetention: 365 }),
      environment: taskEnvironmentVars,
      secrets: taskSecrets
    })
    .addPortMappings({ containerPort: 5555 });;

    const flowerService = new ecs.FargateService(this, 'flowerService', {
      serviceName: 'flower',
      cluster: ecsCluster,
      taskDefinition: flowerTaskDefinition,
      desiredCount: 0,
      securityGroup: ecsTaskSecurityGroup,
      assignPublicIp: false,
      cloudMapOptions: {
        name: CFG.cloudmap.flowerServiceName,
        cloudMapNamespace: airflowNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(30)
      }
    });
    */
    //--------------------------------------------------------------------------
    // TASK DEFINITION - WORKER
    //--------------------------------------------------------------------------
    
    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'workerTaskDefinition', {
      family: 'airflow_worker',
      cpu: 1024,
      memoryLimitMiB: 3072,
      executionRole: taskExecutionRole
    });

    workerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry(airflowImage.imageUri),
      command: ['worker'],
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-worker", logRetention: 365 }),
      environment: {
        POSTGRES_DB: CFG.db.databaseName,
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        AIRFLOW__CORE__REMOTE_BASE_LOG_FOLDER: s3_log_path,
        REDIS_HOST: redis_host,
        REDIS_PORT: CFG.redis.port, 
        ALLOW_EMPTY_PASSWORD: 'yes',
        // Need to specify a key that is consistent across all airflow containers, otherwise they can't talk to one another: 
        FERNET_KEY: 'CQInk_dg4xsDrB-s2pvAt81cbddUNffTXqnGoRlPb5c='    // This needs to be migrated to an automated, secure way of generating a key
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret),
        //REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret)
      }
    })
    .addPortMappings({ containerPort: 8793 });;
  
    const workerService = new ecs.FargateService(this, 'workerService', {
      serviceName: 'worker',
      cluster: ecsCluster,
      taskDefinition: workerTaskDefinition,
      desiredCount: 1,
      securityGroup: ecsTaskSecurityGroup,
      assignPublicIp: false
    });

    //--------------------------------------------------------------------------
    // TASK DEFINITION - REDIS
    //--------------------------------------------------------------------------
    
    const redisTaskDefinition = new ecs.FargateTaskDefinition(this, 'redisTaskDefinition', {
      family: 'airflow_redis',
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: taskExecutionRole
    });

    redisTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry('bitnami/redis:5.0.7'),
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-redis", logRetention: 365 }),
      environment: {
        POSTGRES_DB: CFG.db.databaseName,
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        AIRFLOW__CORE__REMOTE_BASE_LOG_FOLDER: s3_log_path,
        REDIS_HOST: redis_host,
        REDIS_PORT: CFG.redis.port, 
        // Need to specify a key that is consistent across all airflow containers, otherwise they can't talk to one another: 
        FERNET_KEY: 'CQInk_dg4xsDrB-s2pvAt81cbddUNffTXqnGoRlPb5c='    // This needs to be migrated to an automated, secure way of generating a key
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret),
        //REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret)
      }
    })
      .addPortMappings({ containerPort: 6379 });;
    
    const redisService = new ecs.FargateService(this, 'redisService', {
      serviceName: 'redis',
      cluster: ecsCluster,
      taskDefinition: redisTaskDefinition,
      desiredCount: 1,
      securityGroup: ecsTaskSecurityGroup,
      assignPublicIp: false,
      cloudMapOptions: {
        name: CFG.cloudmap.redisServiceName,
        cloudMapNamespace: airflowNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(30)
      }
    });
    
    //--------------------------------------------------------------------------
    // Dependency Config
    //--------------------------------------------------------------------------
    // Based on guidance in: https://github.com/puckel/docker-airflow/blob/master/docker-compose-CeleryExecutor.yml
    // We need to set up certain containers before others: 
    //webserverService.node.addDependency(redisService);
    //flowerService.node.addDependency(redisService);
    //schedulerService.node.addDependency(webserverService);
    //workerService.node.addDependency(schedulerService);

    //--------------------------------------------------------------------------
    // APPLICATION LOAD BALANCER - used for webserver and flower tasks
    //--------------------------------------------------------------------------
    /*
    // DEPRECATING IN FAVOR OF CLOUDMAP

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
      targets: [webserverService],
      healthCheck: {
        healthyHttpCodes: '200,302'   // Because the webserver does a redirect, we add code 302 as an acceptable code
      }
    });

    const flowerTargetGroup = new elbv2.ApplicationTargetGroup(this, 'flowerTargetGroup', {
      port: 5555,
      targetGroupName: 'airflow-flower-tg',
      targetType: elbv2.TargetType.IP,
      vpc: ecsVpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [flowerService],
      healthCheck: {
        healthyHttpCodes: '200,302'   // Because the webserver does a redirect, we add code 302 as an acceptable code
      }
    });
      
    listener.addTargetGroups('defaultRule', {
      targetGroups: [webserverTargetGroup],
    });

    listener.addTargetGroups('flowerRule', {
      targetGroups: [flowerTargetGroup],
      pathPattern: "/flower",
      priority: 2
    });
    */
  }
}
