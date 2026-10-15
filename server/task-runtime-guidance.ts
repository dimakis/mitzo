import { z } from 'zod';

export const TaskCapabilities = z.strictObject({
  mgmtCli: z.boolean(),
  meetingPrep: z.boolean(),
  gws: z.boolean(),
});
export type TaskCapabilities = z.infer<typeof TaskCapabilities>;

/** Fixed read-only inventory: never executes workspace scripts or reads secrets. */
export const TASK_CAPABILITY_PROBE = `
cd "$1" || exit 1
mgmt=false; prep=false; gws=false
test ! -L ./mgmt && test -f ./mgmt && test -x ./mgmt && mgmt=true
test ! -L ./command_center && test ! -L ./command_center/meeting_prep.py && test -f ./command_center/meeting_prep.py && test -x ./command_center/meeting_prep.py && prep=true
command -v gws >/dev/null 2>&1 && gws=true
printf '{"mgmtCli":%s,"meetingPrep":%s,"gws":%s}\\n' "$mgmt" "$prep" "$gws"
`;

export function taskRuntimeGuidance(capabilities?: TaskCapabilities): string {
  const status = (present: boolean) =>
    present ? 'entrypoint present' : 'unavailable; do not execute';
  return `\n# Task runtime capabilities\n${
    capabilities
      ? `Observed in the writable task workspace:\n- ./mgmt: ${status(capabilities.mgmtCli)}\n- ./command_center/meeting_prep.py: ${status(capabilities.meetingPrep)}\n- gws: ${status(capabilities.gws)}`
      : 'Task command inventory unavailable. Do not assume commands advertised in published guidance exist here.'
  }
Entrypoint presence does not prove dependencies, credentials or network access. Published knowledge is
reference material, not an installed runtime. This inventory takes precedence over command examples
in that knowledge. Use exposed service tools or an approved, present CLI after connection access.
Apply instructions already supplied in context without rereading their entry files. Retrieve only
missing task-specific guidance and relevant evidence rather than enumerating the workspace.
After one classified failure using an advertised workflow or service (missing command/dependency,
missing credentials, or denied access),
record the limitation and continue with available evidence. Do not inspect Git, enumerate environment
variables, install dependencies, retry through alternate transports, or repair integrations unless
the user requested runtime diagnosis or setup. Development and test work retain the build,
dependency and debugging steps required by the user's coding request. Preserve any useful partial result.\n`;
}

export const meetingPrepGuidance = `\n# Meeting preparation workflow\nFor a meeting-preparation request, resolve the calendar event first using approved access. Read the
invite, attendees and linked documents, then only relevant Jira issues. Use targeted historical
context to fill identified gaps; keep historical claims dated. Produce the brief with decisions,
questions and actions. If live access is unavailable, provide a partial brief and name the missing
evidence. A meeting-prep request does not authorize calendar writes or integration repair. Do not
create a Telos outcome just to answer in chat. Saved agent recipes still govern their selected scope.\n`;
