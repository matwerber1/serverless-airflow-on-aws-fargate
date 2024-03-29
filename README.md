# UPDATE!

On November 24th, 2020, AWS announced Amazon Managed Apache Airflow (AMAA):

* https://aws.amazon.com/about-aws/whats-new/2020/11/introducing-amazon-managed-workflows-for-apache-airflow-mwaa/

The new AMAA is likely a better strategy that trying to set up and run airflow yourself :)

# Serverless Apache Airflow on AWS

This project provides a CDK script to get you up and running with Apache Airflow on a completely **serverless** AWS infrastructure. No EC2s to manage :)

This project was based on this awesome article by Axel Furlan: 

https://towardsdatascience.com/how-to-deploy-apache-airflow-with-celery-on-aws-ce2518dbf631

## Disclaimer

I'm new to Airflow and this project is a learning experience.

My current goal is "just get it working", so production considerations (security, scaling, best practices, etc.) have not been addressed.

## Status

Just got everything finally working. I ran a DAG and it was successfully passed to and executed by the worker container :)

## Deployment

This project uses the AWS Cloud Development Kit (AWS CDK). Steps to deploy are: 

1. Clone this repo
2. Open `lib/aws-airflow-ecs-fargate-stack.ts` and edit the configuration (`CFG` object) at the top of the document; this includes things like specifying which pre-existing VPC and subnets you'd like to use. 
3. Run `npm run build` to synthesize a local CloudFormation stack from your CDK template
4. Run `cdk deploy` to deploy your stack to AWS CloudFormation
5. If local changes are made, repeat steps 3 and 4 to build and push them to AWS. 

## Architecture

* **Amazon ECS** - the Airflow webserver, scheduler, worker, and flower services, as well as an instance of Redis (for job queuing), each run as a separate Amazon ECS Service. If you're new to Amazon ECS, it is a serverless, fully-managed container orchestration service for Docker containers. For now, each service runs one task; if you've used Kubernetes, an ECS task is conceptually the same as a Kubernetes pod.

* **AWS Fargate** - rather than run our ECS tasks on an EC2 instance that we need to manage, the tasks run on AWS Fargate. Fargate is serverless containers, sort of like AWS Lambda for Docker. 

* **Amazon Aurora Serverless for Postgres** - this is used for our database backend for Airflow.

* **Amazon Route 53** - the `webserver` and `flower` ECS services are automatically mapped to private A-record DNS entries `webserver.airflow` and `flower.airflow` accessible only from within your VPC. This makes it easier to access their web UIs simply by navigating to http://webserver.airflow:8080 and http://flower.airflow:5555.

* **AWS Cloud Map** - AWS Cloud Map is a service discovery service and is the "glue" that maps the private IP addresses of our ECS task instances to the Route 53 A records described above. 

* **AWS Secrets Manager** - the passwords for the Redis ECS service and Aurora Postgres database, are generated by and stored within AWS Secrets Manager and dynamically loaded at runtime by each ECS service. We use a custom AWS Lambda function to generate a Fernet key (since Secrets Manager cannot generate Fernet keys natively) and also store it in Secrets Manager; again, our Airflow containers load these at runtime when the ECS task starts up. 

* **Amazon S3** - our Airflow services are configured to ship their logs to Amazon S3. 

## TODO List

1. Add security groups with least privileges to each ECS service
2. Add a cron job to sync DAG scripts from S3 into the webserver container (see step six in this blog: https://stlong0521.github.io/20161023%20-%20Airflow.html)
3. Add an auto-scaling mechanism for the worker task (not sure what metric to measure...)
4. Add an auto-scaling mechanism for the webserver task (maybe for large deployments)
5. Maybe use AWS ElastiCache for Redis, instead of a Redis container on Fargate (not sure if needed / trade-offs?)

## Other Topics

### Fernet Key Lambda Generator

In order for the Airflow tasks to successfully communicate, they need to use the same Fernet key, which we assign via an environment variable. 

Existing docs typically suggest running a local Python command to generate a key and then copy-pasting it into code. I instead chose to automate this process. 

Normally, I would just find a package to generate a Fernet key within the CDK script, store it in AWS Secrets Manager, and then add that secret as an env var in the ECS task definition. Unfortunately, the CDK Secrets construct does not allow you to specify your own secret value... the construct will always generate a random string for you (see https://github.com/aws/aws-cdk/issues/5810).

So, my approach was to instead: 
1. Create a Secrets Manager secret for the Fernet key with the CDK (which gives it a random string that is **not** a valid Fernet key)
2. Create a custom CloudFormation resource in which a simple Python Lambda generates a Fernet key and overwrites the value in Secrets Manager

The python `cryptography` package has a few components that are compiled specifically for the host's OS and Python version... meaning if you run `pip install` on an environment that doesn't match AWS Lambda's execution environment, you're going to get errors. For that reason, I've included the Python dependencies in this repository to save you time. If you do want to compile your own, just be sure to run on an Amazon Linux environment (Docker, EC2, Cloud9, etc.) and use a Python version that matches the version you've configured for your Lambda.

There's probably an easier way to do this, but this is what I've settled on for now. 

### Web UI to edit DAGs

Just to make my early learning a bit easier, I included an [airflow-code-editor](https://github.com/andreax79/airflow-code-editor) plugin, which gives a web UI to edit DAGs and commit to a local git repo. You will see this UI when you connect to the `webserver.airflow:8080` service. 

As Airflow is running in a container, this repo would of course be lost if the container were to restart, and running more than one container would lead to data inconsistency. Long-term, I'd rather see some sort of strategy where DAGs are maintained in an external GitHub or Code Commit repo and a cron job within the container periodically copies them into the DAG folder.

### Bad Characters in Postgres Password

I used AWS Secrets Manager's `new secretsManager.Secret()` to generate a random string for the Postgres and Redis passwords. 

After many painful hours of trying to figure out why flower and worker containers were failing to start, I learned that certain characters (never bothered to figure out which ones) in my Postgres password were the culprit. 

The container logs showed the error below: 

```
[2020-03-01 20:44:06,502: CRITICAL/MainProcess] Unrecoverable error: ValueError("invalid literal for int() with base 10: 'k'")
Traceback (most recent call last):
File "/usr/local/lib/python3.7/site-packages/celery/worker/worker.py", line 205, in start
  self.blueprint.start(self)
File "/usr/local/lib/python3.7/site-packages/celery/bootsteps.py", line 115, in start
  self.on_start()
File "/usr/local/lib/python3.7/site-packages/celery/apps/worker.py", line 139, in on_start
  self.emit_banner()
File "/usr/local/lib/python3.7/site-packages/celery/apps/worker.py", line 154, in emit_banner
  ' \n', self.startup_info(artlines=not use_image))),
File "/usr/local/lib/python3.7/site-packages/celery/apps/worker.py", line 217, in startup_info
  results=self.app.backend.as_uri(),
File "/usr/local/lib/python3.7/site-packages/celery/backends/base.py", line 138, in as_uri
  url = maybe_sanitize_url(self.url or '')
File "/usr/local/lib/python3.7/site-packages/kombu/utils/url.py", line 121, in maybe_sanitize_url
  return sanitize_url(url, mask)
File "/usr/local/lib/python3.7/site-packages/kombu/utils/url.py", line 114, in sanitize_url
  return as_url(*_parse_url(url), sanitize=True, mask=mask)
File "/usr/local/lib/python3.7/site-packages/kombu/utils/url.py", line 81, in url_to_parts
  parts.port,
File "/usr/local/lib/python3.7/urllib/parse.py", line 169, in port
  port = int(port, 10)
ValueError: invalid literal for int() with base 10: 'k'
```

If you use this CDK project as-is, there's a good chance your random passwords will also create problems. If you find that your flower or worker containers seem to be having problems starting, the manual workaround for now is: 

1. Manually change the Aurora Postgres master password to be alphanumeric
2. Within AWS Secrets Manager:
  1. Change the `/airflow/postgres/password` secret to match your new Aurora password
  2. Change the `airflor/redis/password` secret to an alphanumeric password
3. Wait for things to (hopefully) start working, and/or kill the running service tasks in ECS and let ECS start up new ones

I say "alphanumeric" above because I'm not yet sure which character(s) create problems. 

## Useful commands

This is generic info about the CDK CLI: 

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
