#!/usr/bin/env node
import process from 'node:process';
import { Buffer } from 'node:buffer';
import {
  parseNativeAppControlArguments,
  requestQualifiedNativeAppControl,
} from './lib/staging-native-app-control-client.mjs';

try {
  const selection = parseNativeAppControlArguments(process.argv.slice(2), process.env);
  const result = await requestQualifiedNativeAppControl(selection);
  const output = JSON.stringify(result);
  if (!output || Buffer.byteLength(output) > 32768) throw Error('bounded output required');
  process.stdout.write(output + '\n');
} catch {
  process.stderr.write('Original native app control refused; preserve owner, lock and evidence.\n');
  process.exitCode = 1;
}
