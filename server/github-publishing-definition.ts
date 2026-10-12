import { z } from 'zod';
import type { ToolDefinition } from '@mitzo/harness';
export const REQUEST_GITHUB_PUBLISH = 'RequestGithubPublish';
export const GithubPublishingFields = {
  repositoryPath: z.string().min(1).max(256),
  baseBranch: z.string().min(1).max(128),
  title: z.string().min(1).max(128),
  body: z.string().max(512),
  draft: z.boolean(),
};
export const GithubPublishingInput = z.object(GithubPublishingFields).strict();
export const githubPublishingDefinition: ToolDefinition = {
  name: REQUEST_GITHUB_PUBLISH,
  description:
    'Request approval to publish committed workspace changes to a GitHub feature branch and create or update its pull request. Mitzo resolves the GitHub repository from the current workspace and selects its configured connection for this session account. It asks the user for repository-specific access when needed. Credentials remain on the controller. Supply the absolute local repository path inside the current workspace, base branch, title, body and draft choice; do not use direct GitHub writes.',
  input_schema: z.toJSONSchema(GithubPublishingInput),
};
