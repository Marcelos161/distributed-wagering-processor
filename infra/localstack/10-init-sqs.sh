#!/bin/sh
set -eu
exec python3 /opt/dwp-sqs/provision.py apply
