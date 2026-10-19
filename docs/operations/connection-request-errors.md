# Connection request errors

ConnectionRequest reports fixed JSON diagnostics with `error.code`, `message`,
`retry` and `mayHaveApplied`. Raw upstream errors, response bodies, addresses and
credentials never become diagnostic messages.

| Code                                               | Action                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `response_too_large`                               | Narrow the endpoint or search published knowledge; an unchanged retry cannot help. |
| `authentication_failed`, `access_denied`           | Repair credentials or account permissions through secure setup.                    |
| `destination_blocked`, `redirect`, `tls_failed`    | Correct the connection scope, address or certificate.                              |
| `timeout`, `network_failed`, `service_unavailable` | A read may be retried later.                                                       |
| `cancelled`                                        | Resume only under valid session authority.                                         |
| `request_failed`                                   | Inspect configuration before retrying.                                             |

The HTTPS response cap remains 64 KiB. Oversized responses fail rather than
returning a partial body. Failed writes conservatively report
`mayHaveApplied: true` and `retry: verify_state`; verify actual service state
before any repeat. Existing WebSocket/dashboard uncertain-write protections and
session/runtime/credential custody checks remain in force.

This is the typed-error remainder of the original HA investigation. Hardware
knowledge uses the mgmt HA spoke through existing publication (mgmt #351 and
Mitzo #1055), with no new inventory tool, host-file binding or activation.
