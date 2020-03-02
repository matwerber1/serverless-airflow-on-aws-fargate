# Apache Airflow on AWS ECS (Fargate) and Aurora Postgres

This project provides a CDK script to get you up and running with Apache Airflow.

The majority of the infrastructure runs in Fargate containers on Amazon ECS. Amazon Aurora for Postgres provides persistent storage. 

This project was based on the awesome article by Axel Furlan, below: 
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

1. Key Apache Airflow components (webserver, scheduler, worker, and flower) are run as docker containers on Amazon ECS with AWS Fargate. 

2. A single Redis instance is also run as a container on ECS + Fargate and acts as the message queue for our Airflow worker task(s). 

3. Persistent storage for Apache Airflow is provided by an instance of Amazon Aurora Serverless for Postgres. 

4. The containers within the `webserver` and `flower` ECS services are automatically mapped to the DNS entries `webserver.airflow` and `flower.airflow`, respectively, within a Route 53 private hosted zone named `airflow`. Their web UIs may be accessed from within your VPC by http://webserver.airflow:8080 and http://flower.airflow:5555, respectively.

5. The Aurora Postgres and Redis passwords are randomly generated and stored as secrets within AWS Secrets Manager.

6. An Amazon S3 bucket is created to store logs from the airflow containers (and eventually, DAGs uploaded to this bucket willl be synced via a cron task into our airflow containers).

## TODO List

1. Learn how to use Airflow :)
1. Generate Redis and Postgres passwords that do not cause errors (see **Known Issues**)
2. Add security groups with least privileges to each ECS service
3. Add IAM roles with least privileges to each ECS task definition (or remove the task role)
4. Generate a random fernet key rather than hard-coding into code (probably a custom Lambda resource to save in Secrets Manager?)
5. Add a cron job to sync DAG scripts from S3 into the webserver container (see step six in this blog: https://stlong0521.github.io/20161023%20-%20Airflow.html)
6. Add an auto-scaling mechanism for the worker task (not sure what metric to measure...)
7. Add an auto-scaling mechanism for the webserver task (maybe for large deployments)
8. Maybe use AWS ElastiCache for Redis, instead of a Redis container on Fargate (not sure if needed)

## Other Topics

### Web UI to edit DAGs

Just to make my early learning a bit easier, I included an [airflow-code-editor](https://github.com/andreax79/airflow-code-editor) plugin, which gives a web UI to edit DAGs and commit to a local git repo. 

As Airflow is running in a container, this repo would of course be lost if the container were to restart, and running more than one container would lead to data inconsistency. Long-term, I'd rather see some sort of strategy where DAGs are maintained in an external GitHub or Code Commit repo and a cron job within the container periodically copies them into the DAG folder.

## Known Issues

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
