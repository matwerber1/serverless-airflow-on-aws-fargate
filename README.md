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

1. Webserver task running and can connect via Fargate IP and ALB
2. Scheduler task running, and webserver no longer says "no scheduler running", so I think scheduler-to-webserver communication is ok (?)
3. Redis task running



## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
