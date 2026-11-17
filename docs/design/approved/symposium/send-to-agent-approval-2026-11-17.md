# Send to agent — scoped approval

Dimitri approved the revised sharing mock on 17 November 2026 in shared
conversation `9a999953-4124-44d6-8638-3c4b80d2174f`, operator sequence 74:

> So this looks excellent. Only thing I’m wondering is if it is heavier for the
> server to rerender the entire messages, as you have here or add the select as
> you had in your initial flow? I agree with the other bug fixes. Add them

The preceding correction, operator sequence 47, defines the visual boundary:
preserve existing headers, composer, bubbles, date/time stamps and Reply.
Sharing and selection belong in the message menu. Recipient configuration must
expose type, name, profile, thinking and account; model is also shown when known.

Reference: MGMT `mockups/symposium-send-to-agent/v002.html`, local source commit
`5bdd37d`. The preceding `v001.html` remains historical and is not the approved
visual scope. The revised mock contains source-rendered controls from Mitzo
`f986db0cc379`, with illustrative messages/configuration and simulated sends.
The implementation reuses cached compact excerpts and lazy full Markdown rather
than rendering a second complete transcript. Recorded configuration is labelled;
it does not establish runtime readiness or inherit execution authority.

Retain all earlier shared-composer approval revisions. This approval extends
the existing message menu and review dialog; it does not authorize redesign of
the conversation shell, removal of recorded dates, or a different Reply style.
Exact reviewed audience/source identities and original-operation recovery remain
mandatory. Sharing alone starts no response; requesting a reply is explicit.
Production activation and rendered acceptance remain separate.
