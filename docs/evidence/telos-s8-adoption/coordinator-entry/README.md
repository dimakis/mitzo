# S8 coordinator entry adapter

Base: frozen route candidate76e32913, with the three route findings independently
closed. Production checkpoint81af292f0a54730d03b7f84500b919612704b380;
9a427f2c adds tests only. The adapter adds no role enum, allocator, mandate or
control authority. It maps explicit canonical coordinator kind to the existing
ordinary lead setup role through one shared helper.

| Caller                  | Result                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| Item Chat tab           | Choose/Change uses lead+assign; New chat uses lead+additional.             |
| Chat list               | Current lead assignment supplies Choose/Change; links alone do not assign. |
| Overview role entry     | Coordinator exposes the same ordinary lead setup and advisor child entry.  |
| Tree conversation entry | Reads current lead assignment while keeping Coordinator display labels.    |

Unknown kind remains unclassified. The existing role setup hook retains explicit
assignment fencing:0 for first assignment, current revision for replacement,
null for an additional chat. Opening the entry does not allocate or send. No
additional lead link is shown as the current coordinator.

Approved mock9d0559132154b92d0bbb427a982a0002@r1 was read again and SHA-256
verified (97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab).
It uses ordinary lead collaborator setup for coordinators with New chat separate
from assignment. S6 confirmed the backend role/assignment interface; S7 confirmed
the read-only tree seam and no overlapping edits. Existing approved references,
protected tests and tokens remain unchanged.

Real RED: six coordinator entry regressions failed (four chooser paths, Overview,
and tree assignment). GREEN:248 focused checks across25 files, one existing skip,
including ordinary setup, source/route/navigation, tree refresh, design and the
complete runtime source registry. The additional-link/no-current-assignment
negative passes. Two existing source pins and the new shared mapper are explicitly
qualified; every other pin stays intact. Runtimev1.0.335-telos-coordinator-entry.

Twelve intercepted full-route browser scenarios pass: coordinator and existing
lead, light/dark, mobile WebKit/Chromium at320px and desktop. These use actual
TodoDetailView/ordinary screen/settings, reviewed role presentation and setup
wrapper, pre-allocation refusal, reload, exact-request retry, retained source and
unsent draft; the coordinator case verifies lead and first revision0, then the
slim work context row. Existing lead assertions retain their original path.
The settings/bound-chat captures show the new coordinator cases; effects are
synthetic and model labels are fixtures.

This repository-settings role fixture exercises the accepted-base role API; it
is not proof of the S5bV2 ordinary workspace owner or native scoped control path.
S6’s S6-COORDINATOR-CONTRACT.md defines that backend boundary. The independent
S9 joined UI→reviewed V2 setup→actual host→native control journey and immutable
coordinator-specific guidance remain open. UI routing alone does not satisfy
UX17. There were no model/live/staging/deployment operations.

The final production9b595892 rerun also passes all12 coordinator/lead setup
scenarios plus2 startup checks (final-role-browser.log), after the navigation
and viewport corrections. The final broader focused result is311 passes, one
existing skip; the earlier248/63 logs remain labelled intermediate evidence.
