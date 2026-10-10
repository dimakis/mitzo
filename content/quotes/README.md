# Daily quote authoring pipeline

The catalogue is release content, separate from daily delivery. Home reads it without a model call or a network request to quote services.

1. Add a `draft` entry to `drafts.json`. Include the exact text, work/chapter, translator, source URL, biography, explanation and example. Keep editorial interpretation separate from the quotation.
2. Compare the quote with the cited edition. Verify attribution and translation rights. Record the evidence and set `verification` to `verified` only after that check. Drafts never reach the app.
3. Run `npm run quotes:build`, review the generated diff and submit it through the normal PR review gate. `npm run quotes:check` detects stale output. An authoring model may assist with drafts; admission remains source reviewed. This pipeline runs no inference.
4. The server shuffles admitted IDs and saves one complete entry per requested local calendar date in the workspace’s private `.mitzo/home.json`. Devices share this selection. Cached days retain their content when a catalogue changes. The current cache retains 60 selected days; the shuffle avoids repetitions until its deck is exhausted and avoids repeating across deck boundaries where possible.

Start with the small sourced seed. Broader schools and eras can be added through the same process. Do not schedule autonomous publication or put live text generation in home-page navigation.
