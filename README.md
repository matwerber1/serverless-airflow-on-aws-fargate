# Apache Airflow on AWS ECS (Fargate) and Aurora Postgres

This project provides a CDK script to get you up and running with Apache Airflow.

The majority of the infrastructure runs in Fargate containers on Amazon ECS. Amazon Aurora for Postgres provides persistent storage. 

This project was almost entirely based on the awesome article by Axel Furlan, below: 
https://towardsdatascience.com/how-to-deploy-apache-airflow-with-celery-on-aws-ce2518dbf631

# Work in process!

I don't have everything working yet...

# Help wanted

I am brand new to Airflow. My first task is just to the containers running... after that, I need to learn how to configure Airflow and get the container tasks talking to one another. Help is welcome :)

# Status

1. **Webserver** task running and can connect via Fargate IP and ALB
2. **Scheduler** task running and working (the /health endpoint shows scheduler and metadata are `healthy`)
3. **Redis** task running, not sure its properly configured... guessing I need to map it to a DNS name matching my env var config
4. **Flower** - container dies :(
5. **Worker** - container dies :(

## TODO List

1. Add password for Redis
2. Add security groups with least privileges to each ECS service
3. Add IAM roles with least privileges to each ECS task definition (or remove the task role)
4. Generate a random fernet key rather than hard-coding into code (probably a custom Lambda resource to save in Secrets Manager?)
5. Add a cron job to sync DAG scripts from S3 into the webserver container (see step six in this blog: https://stlong0521.github.io/20161023%20-%20Airflow.html)
6. Add an auto-scaling mechanism for the worker task (not sure what metric to measure...)
7. Add an auto-scaling mechanism for the webserver task (maybe for large deployments)
8. Maybe use AWS ElastiCache for Redis, instead of a Redis container on Fargate (not sure if needed)

## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template

# Lessons Learned

## Bad Characters in Postgres Password

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