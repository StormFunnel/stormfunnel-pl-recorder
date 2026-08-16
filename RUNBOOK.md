# RUNBOOK — go live in ~30 minutes

Everything below is done by Bart (needs the GitHub account). The repo is already initialized locally with one commit; nothing here requires code changes.

## 0. Decide: public or private (2 min)

- **Public (recommended).** Actions minutes are unlimited on public repos; 144 runs/day at 1 billed minute each ≈ 4 300 min/month is above every private-plan quota (Free 2 000, Pro/Team 3 000). The repo holds only open data (IMGW HVD, Meteoalarm CC-BY-equivalent) and this code. Nothing secret, no credentials anywhere.
- Private only if there is a reason to hide the recorder itself; then change the cron in `.github/workflows/poll.yml` to `*/30 * * * *` (1 440 min/month) and accept 30-min resolution on latency measurements.

## 1. Create the repo under the org (3 min)

GitHub → org → **New repository** → name `stormfunnel-pl-recorder`, visibility per step 0, **no** README/.gitignore/license (the local repo has them). Copy the SSH/HTTPS URL.

## 2. Push (2 min)

```
cd C:\Users\bachn\Projects\stormfunnel-pl-recorder
git remote add origin <URL>
git push -u origin main
```

Pushing `poll.yml` yourself matters: GitHub attributes scheduled runs (and their failure emails) to the account that last modified the workflow file.

## 3. Set the contact string (2 min)

Repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**: `RECORDER_CONTACT` = an email IMGW/Meteoalarm ops could reach (goes into the User-Agent). Not a secret.

## 4. Allow the workflow to push (2 min)

Repo → **Settings → Actions → General**:
- Actions permissions: *Allow all actions and reusable workflows* (or at least `actions/checkout`, `actions/setup-node`).
- Workflow permissions: **Read and write permissions**. (The workflow also asks for `contents: write` itself; the setting removes one way for that to be denied by an org policy.)

If the org has "Allow GitHub Actions to create and approve pull requests" locked down it does not matter — the recorder never opens PRs.

## 5. First run by hand (5 min)

Repo → **Actions → poll → Run workflow → main**. Wait for green. Check:
- a new commit `poll 2026-…Z [skip ci]` by `recorder-bot`;
- `heartbeat.json` in the repo has fresh `last_success` for all 5 sources;
- the *Health check* step is green.

If the push step fails with 403: step 4 was not applied or the org forbids GITHUB_TOKEN writes → use a fine-grained PAT (Contents: read/write on this repo) as secret `RECORDER_PUSH_TOKEN` and set `token: ${{ secrets.RECORDER_PUSH_TOKEN }}` on the checkout step. Not needed in the default configuration.

## 6. Schedule is on automatically

The `schedule` trigger is live as soon as the file is on the default branch. First cron tick within ~10–20 min (GitHub delays first schedules). Verify after an hour: Actions tab shows runs every ~10 min and commits keep landing.

## 7. Notifications (2 min, probably already correct)

Your GitHub → **Settings → Notifications → Actions**: "Send notifications for failed workflows only" (default). Email arrives on the first red run of a series. Also toggle "Notify me on the web" if you want the bell.

## 8. Weekly, 5 min

- Open Actions: is the latest run green and recent? If the workflow got disabled (60-day inactivity rule, or GitHub paused it) there is a banner + an **Enable workflow** button.
- `git pull` locally, `npm run report`, glance at mutation %, silent-disappearance %, and cron gap p90.
- If a **SCHEMA DRIFT** alarm is red: read `ledger/<source>.ndjson` last `schema_drift` line, decide, then set `state/acknowledged-schemas.json[<source>]` to the hash shown in `heartbeat.json`, commit, push. Green next tick.

## Stop / pause

Actions → poll → "…" → **Disable workflow**. Data stays. Re-enable the same way.

## Read the data without cloning everything

The repo will reach tens of thousands of commits. Use `git clone --depth 1` for a working copy; the whole picture is always in HEAD (ledger and poll logs are cumulative files, snapshots are files, nothing is only in history).
