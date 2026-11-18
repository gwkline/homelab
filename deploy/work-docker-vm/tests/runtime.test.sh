#!/bin/sh
set -eu
python3 -m unittest discover -s deploy/work-docker-vm/tests -p 'test_*.py' -v
