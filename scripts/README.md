# Dashboard data refresh

Pulls live Jira Cloud data into `data/*.json` for the static GitHub Pages dashboard.

## One-time setup (required for the schedule)

1. Create a [Jira API token](https://id.atlassian.com/manage-profile/security/api-tokens) for a user who can read `CONAMER1001932`.
2. In the GitHub repo: **Settings → Secrets and variables → Actions**, add:
   - `JIRA_EMAIL` — Atlassian account email
   - `JIRA_API_TOKEN` — API token
   - `JIRA_BASE_URL` — optional; defaults to `https://pwc-us-adv-cc-85ef5f50.atlassian.net`
3. Merge the workflow on `main`. Cron jobs only run from the default branch.

## What the schedule does

Workflow: `.github/workflows/refresh-jira-data.yml`

- **When:** weekdays at 11:00 UTC (~7:00 AM ET), or **Actions → Refresh Jira dashboard data → Run workflow**
- **How:** `npm run refresh` → opens/updates PR branch `auto/jira-data-refresh`
- **Then:** merge that PR so Pages picks up the new JSON

## Local run

```bash
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="..."
npm run refresh
```

Scripts:

| Command | Purpose |
|---------|---------|
| `npm run fetch` | Write raw issues under `data/_raw/` |
| `npm run build:tabs` | Build conversion / defects / prep / rice |
| `npm run build:pte` | Build `data/p2-testing.json` |
| `npm run refresh` | All of the above |
