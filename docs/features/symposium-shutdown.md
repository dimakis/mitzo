# Symposium graceful shutdown

The app retains each created Symposium runtime for shutdown. SIGTERM and SIGINT
fence new admission and dispatch synchronously, including queued sandbox creation.
In-flight owned-host setup and evidence collection settle while custody remains live.
Retained native executors cancel exact attempts and await setup already in progress;
seat cleanup uses the existing exact sandbox and artifact lease cleanup path without
reconciling or creating replacement seats. Login cancellation and the workspace
creation fence must settle before the gateway is stopped.

The owned gateway receives SIGTERM, but only its child exit and issuer termination
permit custody stores to close. A 30-second deadline or cleanup failure marks pending
native reservations uncertain, leaves stores open for remaining cleanup, and exits
with failure. Neither an abort nor a sent signal is recorded as successful physical
cleanup. Repeated shutdown requests share the same operation. The legacy emergency
stop remains available for failed bootstrap and is not a successful graceful drain.

Durable conversations, memberships, and review history remain replayable after a
restart. Personal connections require the existing reauthentication/revision checks;
active seats are never silently rebound. This change does not adopt an old gateway,
copy credentials, reconcile old artifact custody into a new host, or provide
same-session artifact continuation. Cross-custody artifact recovery is a separate
explicit design. It does not enable native review dispatch or relax application-policy,
account/model acceptance or physical custody gates. The
[current acceptance contract](symposium-integrated-acceptance.md#application-policy-contract)
defers guaranteed native token/spend caps and mandatory final usage totals.

Validation uses mocked processes, native setup, and temporary local ledgers. It covers
concurrent setup and queued creation, repeated shutdown, partial cleanup, deadline
expiry, and gateway exit ordering. No live gateway, OAuth, or model calls are part of
this change. Live restart acceptance remains unproven.
