/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Preload script that forces dns.lookup to prefer IPv4.
// Loaded via NODE_OPTIONS=--require=<this file> before the Agent SDK cli.js starts.
//
// Works around a known undici bug where autoSelectFamily (RFC 8305) fails to
// fall back from IPv6 when EHOSTUNREACH is returned on networks with a
// Tailscale IPv6 ULA address but no routable IPv6 to Google's OAuth servers.
// See: https://github.com/nodejs/node/issues/48145
'use strict';

const dns = require('dns');
const origLookup = dns.lookup;

dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof options === 'number') {
    options = { family: options };
  }
  if (!options) options = {};

  if (!options.family) {
    options = { ...options, family: 4 };
  }

  return origLookup.call(dns, hostname, options, callback);
};
