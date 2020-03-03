import * as cdk from '@aws-cdk/core';
import rds = require('@aws-cdk/aws-rds');
import secretsmanager = require('@aws-cdk/aws-secretsmanager');
import ec2 = require("@aws-cdk/aws-ec2");
import ecs = require("@aws-cdk/aws-ecs");
import s3 = require("@aws-cdk/aws-s3");
import iam = require("@aws-cdk/aws-iam");
import lambda = require("@aws-cdk/aws-lambda");
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import servicediscovery = require('@aws-cdk/aws-servicediscovery');
import cloudformation = require('@aws-cdk/aws-cloudformation');
import fs = require('fs');
import path = require('path');
import { Duration } from '@aws-cdk/core';
import { ServicePrincipal } from '@aws-cdk/aws-iam';

// YOUR CONFIGURATION PARAMETERS:
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
    vpcSecurityGroupIds: ['sg-00e88c6dc027cc7ce'],
    passwordSecretName: "airflow/postgres/password"
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
    port: '6379',
    passwordSecretName: "airflow/redis/password"
  },
  airflow: {
    fernetKeySecretName: "airflow/fernetKey",
    loadExamples: 'n'
  }
};  

export class AwsAirflowEcsFargateStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //--------------------------------------------------------------------------
    // SECRETS
    //--------------------------------------------------------------------------
    /*
        Warning!

        The secrets below are dynamically referenced by the Airflow containers
        at runtime. If you make any changes to the secrets below, it may lead
        to problems. 

        If you change the database secret, it will automatically  propogate to
        the Aurora database. This means that when a container next starts/restarts, 
        its going to pull the wrong value from Secrets Manager. If this happens, 
        you should manually change the Aurora password to match the value in the secret. 

        If you change the Redis password, a similar issue. If this happens, you should
        restart kill all of the airflow tasks. Once they restart, they will pick up the
        new value. Since Redis runs in a Fargate container and uses the same env var, 
        restarting the Redis task is all you need to do to update the password. 

        Likewise, issues will arise when changing the Fernet key. All Airflow containers
        need to use the same Fernet key in order to communicate with one-another. If you
        change the fernet key, then kill all the running tasks to make sure they're all 
        replaced with new tasks that pick up the new Fernet key.
    */
    const databasePasswordSecret = new secretsmanager.Secret(this, 'AirflowDatabasePassword', {
      secretName: CFG.db.passwordSecretName,
      generateSecretString: {
        excludeCharacters: '!@#$%^&*()-=+[]{};",.<>/?'
      }
    });

    const redisPasswordSecret = new secretsmanager.Secret(this, 'RedisPassword', {
      secretName: CFG.redis.passwordSecretName,
      generateSecretString: {
        excludeCharacters: '!@#$%^&*()-=+[]{};",.<>/?'
      }
    });

    // AWS CDK does not allow us to specify a value for a secret, it only let's 
    // us randomly generate a value. So, we will create the secret with a random
    // value below, and later we will deploy a custom CloudFormation resource
    // which contains a Lambda that will generate a valid Fernet key and update
    // this secret. 
    const fernetKeySecret = new secretsmanager.Secret(this, 'FernetKey', {
      secretName: CFG.airflow.fernetKeySecretName
    });

    //--------------------------------------------------------------------------
    // AIRFLOW FERNET KEY GENERATOR
    //--------------------------------------------------------------------------
    /*  
        This Lambda is used to set a proper Fernet key in AWS Secrets Manager
        because the AWS CDK does not allow us to directly specify such a value
        in the secretsmanager.Secret construct :(
        
        https://github.com/aws/aws-cdk/issues/5810
    */
    const fernetKeyFunction = new lambda.Function(this, 'FernetKeyFunction', {
      runtime: lambda.Runtime.PYTHON_3_6,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/fernetKeyGenerator')), 
      environment: {
        SECRET_ARN: fernetKeySecret.secretArn,
        SECRET_NAME: CFG.airflow.fernetKeySecretName
      },
      timeout: Duration.seconds(10)
    });

    // Generate IAM policy that allows putting a new value to the Fernet secret in Secrets Manager: 
    const fernetSecretPolicyStatement = new iam.PolicyStatement(); 
    fernetSecretPolicyStatement.addActions('secretsmanager:PutSecretValue');
    fernetSecretPolicyStatement.addResources(fernetKeySecret.secretArn);

    // Attach the fernet secret policy to our fernet key generator function: 
    fernetKeyFunction.addToRolePolicy(fernetSecretPolicyStatement);

    // This custom CloudFormation resource below will use the Lambda above to
    // replace our Fernet key secret with a proper value, rather than the arbitrary
    // string that Secrets Manager generated when we first created the secret: 
    const fernetKeyResource = new cloudformation.CustomResource(this, 'fernetKeyResource', {
      provider: cloudformation.CustomResourceProvider.lambda(fernetKeyFunction),
    });

    //--------------------------------------------------------------------------
    // AIRFLOW S3 BUCKET (for logging and storing DAGs)
    //--------------------------------------------------------------------------
    // S3 Bucket to which we will ship airflow logs: 
    const airflowBucket = new s3.Bucket(this, 'airflowBucket', {});
    var s3_log_path = "s3://" + airflowBucket.bucketName + "/logs"

    //--------------------------------------------------------------------------
    // VPC, NETWORKING
    //--------------------------------------------------------------------------
    const ecsVpc = ec2.Vpc.fromLookup(this, 'ecsVpc', { vpcId: CFG.ecs.vpcId }); 
    
    // Define the subnet group which our Aurora cluster will use: 
    const dbSubnetGroup = new rds.CfnDBSubnetGroup(this, 'DatabaseSubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for Airflow database',
      dbSubnetGroupName: 'airflow-db-subnet-group',
      subnetIds: CFG.db.subnetIds
    });
    
    //--------------------------------------------------------------------------
    // IMPORTED IAM & SECURITY GROUPS
    //--------------------------------------------------------------------------
    const taskExecutionRoleArn = `arn:aws:iam::${props?.env?.account}:role/ecsTaskExecutionRole`;
    const taskExecutionRole = iam.Role.fromRoleArn(this, 'taskExecutionRole', taskExecutionRoleArn);
    const ecsTaskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'taskSecurityGroup', CFG.ecs.securityGroup);
    
    //--------------------------------------------------------------------------
    // AIRFLOW POSTGRES DATABASE (AURORA SERVERLESS)
    //--------------------------------------------------------------------------
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
      }
    });

    //--------------------------------------------------------------------------
    // AIRFLOW DOCKER IMAGE
    //--------------------------------------------------------------------------
    const airflowImage = new DockerImageAsset(this, 'airflowImage', {
      directory: path.join(__dirname, 'docker'),
      repositoryName: 'airflow'
    });
    
    //--------------------------------------------------------------------------
    // AIRFLOW ECS CLUSTER
    //--------------------------------------------------------------------------
    const ecsCluster = new ecs.Cluster(this, "ecsCluster", {
      vpc: ecsVpc
    });

    //--------------------------------------------------------------------------
    // REDIS HOST
    //--------------------------------------------------------------------------
    const redisHost = `${CFG.cloudmap.redisServiceName}.${CFG.cloudmap.namespace}`;  // e.g. private DNS = redis.airflow

    //--------------------------------------------------------------------------
    // AIRFLOW PRIVATE DNS ENTRIES via AWS CLOUD MAP
    //--------------------------------------------------------------------------
    // We will use a private DNS zone to give friendly names to our airflow services
    const airflowNamespace = new servicediscovery.PrivateDnsNamespace(this, 'airflowNamespace', {
      name: CFG.cloudmap.namespace,
      vpc: ecsVpc,
      description: 'Private DNS for airflow resources'
    });

    //--------------------------------------------------------------------------
    // ECS TASK ROLE - AIRFLOW ACCESS TO S3
    //--------------------------------------------------------------------------
    const airflowTaskRole = new iam.Role(this, 'airflowTaskRole', {
      description: 'Role assumed by Airflow ECS services to access S3',
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com')
    });
    airflowBucket.grantReadWrite(airflowTaskRole);

    //--------------------------------------------------------------------------
    // ECS SERVICE - AIRFLOW WEBSERVER
    //--------------------------------------------------------------------------
    const webserverTaskDefinition = new ecs.FargateTaskDefinition(this, 'webserverTaskDefinition', {
      family: 'airflow_webserver',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: taskExecutionRole,
      taskRole: airflowTaskRole
    });
 
    webserverTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry(airflowImage.imageUri),
      command: ['webserver'],
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-webserver", logRetention: 365 }),
      environment: {
        LOAD_EX: CFG.airflow.loadExamples,
        POSTGRES_DB: CFG.db.databaseName,
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        AIRFLOW__CORE__REMOTE_BASE_LOG_FOLDER: s3_log_path,
        REDIS_HOST: redisHost,
        REDIS_PORT: CFG.redis.port
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret),
        FERNET_KEY: ecs.Secret.fromSecretsManager(fernetKeySecret)
      }
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
    // ECS SERVICE - AIRFLOW SCHEDULER
    //--------------------------------------------------------------------------
    const schedulerTaskDefinition = new ecs.FargateTaskDefinition(this, 'schedulerTaskDefinition', {
      family: 'airflow_scheduler',
      cpu: 512,
      memoryLimitMiB: 2048,
      executionRole: taskExecutionRole,
      taskRole: airflowTaskRole
    });

    schedulerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry(airflowImage.imageUri),
      command: ['scheduler'],
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-scheduler", logRetention: 365 }),
      environment: {
        LOAD_EX: CFG.airflow.loadExamples,
        POSTGRES_DB: CFG.db.databaseName,
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        AIRFLOW__CORE__REMOTE_BASE_LOG_FOLDER: s3_log_path,
        REDIS_HOST: redisHost,
        REDIS_PORT: CFG.redis.port
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret),
        FERNET_KEY: ecs.Secret.fromSecretsManager(fernetKeySecret)
      }
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
    // ECS SERVICE - AIRFLOW FLOWER
    //--------------------------------------------------------------------------
    const flowerTaskDefinition = new ecs.FargateTaskDefinition(this, 'flowerTaskDefinition', {
      family: 'airflow_flower',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: taskExecutionRole,
      taskRole: airflowTaskRole
    });

    flowerTaskDefinition.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry(airflowImage.imageUri),
      command: ['flower'],
      logging: new ecs.AwsLogDriver({ streamPrefix: "airflow-flower", logRetention: 365 }),
      environment: {
        // Need to specify a key that is consistent across all airflow containers, otherwise they can't talk to one another: 
        POSTGRES_DB: CFG.db.databaseName,
        POSTGRES_HOST: aurora.attrEndpointAddress,
        POSTGRES_PORT: aurora.attrEndpointPort,
        POSTGRES_USER: CFG.db.masterUsername,
        AIRFLOW__CORE__REMOTE_BASE_LOG_FOLDER: s3_log_path,
        REDIS_HOST: redisHost,
        REDIS_PORT: CFG.redis.port
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret)
      }
    })
    .addPortMappings({ containerPort: 5555 });;

    const flowerService = new ecs.FargateService(this, 'flowerService', {
      serviceName: 'flower',
      cluster: ecsCluster,
      taskDefinition: flowerTaskDefinition,
      desiredCount: 1,
      securityGroup: ecsTaskSecurityGroup,
      assignPublicIp: false,
      cloudMapOptions: {
        name: CFG.cloudmap.flowerServiceName,
        cloudMapNamespace: airflowNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(30)
      }
    });
    
    //--------------------------------------------------------------------------
    // ECS SERVICE - AIRFLOW WORKER
    //--------------------------------------------------------------------------
    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'workerTaskDefinition', {
      family: 'airflow_worker',
      cpu: 1024,
      memoryLimitMiB: 3072,
      executionRole: taskExecutionRole,
      taskRole: airflowTaskRole
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
        REDIS_HOST: redisHost,
        REDIS_PORT: CFG.redis.port
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(databasePasswordSecret),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret),
        FERNET_KEY: ecs.Secret.fromSecretsManager(fernetKeySecret)
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
    // ECS SERVICE - REDIS (USED BY AIRFLOW)
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
        //ALLOW_EMPTY_PASSWORD: 'yes',    // used by Redis
      },
      secrets: {
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisPasswordSecret)
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
    
  }
}
