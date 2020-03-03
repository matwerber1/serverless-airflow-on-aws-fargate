# built using "crhelper", nifty tool explained here: https://aws.amazon.com/blogs/infrastructure-and-automation/aws-cloudformation-custom-resource-creation-with-python-aws-lambda-and-crhelper/
from cryptography.fernet import Fernet
import urllib.request
import boto3
import os
from crhelper import CfnResource

secretsmanager = boto3.client('secretsmanager')

helper = CfnResource()

# We do the same thing whether we create or update
@helper.create
@helper.update
def setFernetKey(_, __):
    # Generate a random Fernet key: 
    fernetKey = Fernet.generate_key().decode()

    # Save the fernet key in an AWS Secrets Manager secret:
    response = secretsmanager.put_secret_value(
        SecretId=os.environ['SECRET_NAME'],
        SecretString=fernetKey
    )

# There's nothing to delete, so just return:
@helper.delete
def no_op(_, __):
    pass

def handler(event, context):
    helper(event, context)