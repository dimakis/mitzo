---
description: View and update people profiles
mutating: true
allowed-tools:
  - Read
  - Edit
  - Glob
  - Grep
---

Look up and optionally update a person's profile stored under `command_center/context/people/` in the repo.

## Instructions

The user provides a person's name or email prefix via `$ARGUMENTS`. Follow these steps:

### 1. Find the profile

Use Glob to search for matching files:

```
command_center/context/people/*$ARGUMENTS*.md
```

If no exact match, use Grep to search file contents for the name or email prefix across all `command_center/context/people/*.md` files. If multiple matches are found, list them and ask the user to clarify.

### 2. Display the profile

Read and display the matching profile file. Show the full content (frontmatter and body) so the user can see all available context.

### 3. Handle updates (if requested)

Check `$ARGUMENTS` for update instructions:

- **If `--note <text>` is present:** Append a new line to the "Notes" section of the profile:

  ```
  - [YYYY-MM-DD] <text>
  ```

  Use today's date. If no "Notes" section exists, create one at the end of the file with a `## Notes` header.

- **If additional text is provided after the person's name (without `--note`):** Append the text as a new bullet point under the "Open Threads" section. If no "Open Threads" section exists, create one before "Notes" (or at the end if no Notes section).

Use the Edit tool to make any updates. After editing, read and display the updated file to confirm the change.

### 4. Confirm

If an update was made, show a brief confirmation of what was added and where.
