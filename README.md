# Apache Airflow on AWS ECS (Fargate) and Aurora Postgres

This project provides a CDK script to get you up and running with Apache Airflow.

The majority of the infrastructure runs in Fargate containers on Amazon ECS. Amazon Aurora for Postgres provides persistent storage. 

This project was almost entirely based on the awesome article by Axel Furlan, below: 
https://towardsdatascience.com/how-to-deploy-apache-airflow-with-celery-on-aws-ce2518dbf631

# Work in process!

I don't have everything working yet...

1. Got the `webserver` task up and running, and I can see that it has connected to and populated data within the Aurora PG database...

## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
