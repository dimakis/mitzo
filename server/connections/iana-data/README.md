# IANA address-policy snapshots

These compact CSV snapshots were retrieved on 2026-09-17 from the authoritative IANA registries below. Runtime never fetches them: `iana-address-data.generated.ts` is the checked-in, offline policy table.

- IPv4 special-purpose: https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
- IPv6 special-purpose: https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
- IPv6 global unicast allocations: https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv

To update intentionally, download the three source CSVs, reduce them to the documented `Address Block`/`Status` columns used by these compact snapshots, then run `node scripts/generate-iana-address-data.mjs --retrieved-on YYYY-MM-DD` and review its output and provenance digests before replacing `iana-address-data.generated.ts` in the same reviewed change. `npm run build:server` checks that the generated table still exactly matches the snapshots. The data is deliberately fail-closed: an incomplete or malformed snapshot cannot make a special range acceptable, and unallocated IPv6 space remains denied.
