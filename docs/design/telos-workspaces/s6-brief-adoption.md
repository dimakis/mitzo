# S6 reviewed brief adoption (CT10)

An execution attempt retains its original reviewed child/ancestor records, sources,
material revisions and ordinary contributor guidance. Saving a revised brief does
not mutate those bytes or grant an ongoing turn the revised scope.

The chosen adoption boundary is an explicitly reviewed **new worker attempt**.
The existing retry command captures the current context and predecessor; ordinary
settings and independent workspace preparation retain their existing authority.
A default start recovers the old attempt and cannot silently adopt a new revision.

New native queue admission and the final synchronous provider-dispatch callback
check the current canonical record pins. A queued command whose context changed
fails before provider dispatch. Restart does not remove this fence. The same
check applies to future commands in an existing worker chat. Running tool/context
continuations and result callbacks keep their admitted packet and do not run this
brief-change check. Current worker authority remains independently enforced.

`assertWorkTurnAdmission` is a narrow host callback, not model input. Its native
hook runs before queueing and immediately before provider dispatch; normal active
context authorization is separate. It also consumes scoped safe-point holds.

Test-first evidence: two real store/admission tests and the native callback test
failed before implementation. The focused command, native chat and owned command
start suites pass (133 tests). The provider is inert. No account is charged.
Accepted S5b repository-free integration and final combined feature evidence
remain S6/S9 acceptance work; this document does not claim those gates passed.
