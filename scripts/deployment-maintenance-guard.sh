#!/bin/sh
# Inert next-launch guard for the existing USER job. Ignore its old argv;
# read no configuration, input or files and start no Mitzo/model work.
exec /usr/bin/perl -T -e 'while (1) { sleep 3600; }'
