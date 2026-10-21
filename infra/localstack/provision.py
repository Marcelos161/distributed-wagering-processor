import json
import os
import sys
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def ensure_queue(client, spec: dict) -> str:
    try:
        url = client.get_queue_url(QueueName=spec['name'])['QueueUrl']
    except ClientError as error:
        if error.response['Error']['Code'] not in (
            'AWS.SimpleQueueService.NonExistentQueue', 'QueueDoesNotExist'
        ):
            raise
        url = client.create_queue(
            QueueName=spec['name'], Attributes=spec['attributes']
        )['QueueUrl']
    attributes = client.get_queue_attributes(QueueUrl=url, AttributeNames=['FifoQueue'])['Attributes']
    if attributes.get('FifoQueue') != 'true':
        raise RuntimeError(f"Queue {spec['name']} must already be FIFO; refusing to delete it")
    return url


def expected_attributes(spec: dict, source_arn: str, dlq_arn: str) -> dict:
    source = dict(spec['source']['attributes'])
    dlq = dict(spec['dlq']['attributes'])
    source['RedrivePolicy'] = json.dumps({
        'deadLetterTargetArn': dlq_arn, 'maxReceiveCount': str(spec['maxReceiveCount'])
    })
    dlq['RedriveAllowPolicy'] = json.dumps({
        'redrivePermission': 'byQueue', 'sourceQueueArns': [source_arn]
    })
    return {'source': source, 'dlq': dlq}


def normalized(key: str, value: str):
    if key not in ('RedrivePolicy', 'RedriveAllowPolicy'):
        return value
    policy = json.loads(value)
    if 'maxReceiveCount' in policy:
        policy['maxReceiveCount'] = int(policy['maxReceiveCount'])
    return policy


def main(mode: str) -> None:
    if mode not in ('apply', 'check'):
        raise ValueError('Mode must be apply or check')
    spec = json.loads(Path(__file__).with_name('queues.json').read_text())
    client = boto3.client(
        'sqs', endpoint_url='http://127.0.0.1:4566',
        region_name=os.environ.get('AWS_DEFAULT_REGION', 'us-east-1'),
        aws_access_key_id='test', aws_secret_access_key='test',
        config=Config(connect_timeout=2, read_timeout=2, retries={'max_attempts': 1}),
    )
    urls = {}
    arns = {}
    for kind in ('dlq', 'source'):
        urls[kind] = (ensure_queue(client, spec[kind]) if mode == 'apply'
                      else client.get_queue_url(QueueName=spec[kind]['name'])['QueueUrl'])
        arns[kind] = client.get_queue_attributes(
            QueueUrl=urls[kind], AttributeNames=['QueueArn']
        )['Attributes']['QueueArn']
    expected = expected_attributes(spec, arns['source'], arns['dlq'])
    for kind in ('dlq', 'source'):
        if mode == 'apply':
            mutable = {key: value for key, value in expected[kind].items() if key != 'FifoQueue'}
            client.set_queue_attributes(QueueUrl=urls[kind], Attributes=mutable)
        actual = client.get_queue_attributes(QueueUrl=urls[kind], AttributeNames=['All'])['Attributes']
        for key, value in expected[kind].items():
            if key not in actual or normalized(key, actual[key]) != normalized(key, value):
                raise RuntimeError(f"{spec[kind]['name']}: unexpected attribute {key}")
    print(json.dumps({'sqs': 'configured', 'mode': mode, 'queues': urls}))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'apply')
