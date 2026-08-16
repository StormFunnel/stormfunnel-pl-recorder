# RUNBOOK — go live in ~30 minutes (up to ~1 h if an org policy bites)

Everything below is done by Bart (needs the GitHub account). The repo is already initialized locally; nothing here requires code changes.

## 0. Decide: public or private (2 min)

- **Public (recommended).** Actions minutes are unlimited on public repos; 144 runs/day at 1 billed minute each ≈ 4 300 min/month is above every private-plan quota (Free 2 000, Pro/Team 3 000). The repo holds only open data (IMGW HVD, Meteoalarm CC-BY-equivalent) and this code. Nothing secret, no credentials anywhere. Note `LICENSE-NOTES.md`: public means redistributing IMGW raw snapshots before the written HVD confirmation — the fallback there is "go private + `*/30`".
- Private only if there is a reason to hide the recorder itself; then change the cron in `.github/workflows/poll.yml` to `*/30 * * * *` (1 440 min/month) and accept 30-min resolution on latency measurements.

## 1. Create the repo under the org (3 min)

GitHub → org → **New repository** → name `stormfunnel-pl-recorder`, visibility per step 0, **no** README/.gitignore/license (the local repo has them). Copy the SSH/HTTPS URL.

**Before pushing, check the branch rules.** Repo → Settings → Rules → Rulesets (and Branches → protection rules) for `main`. Org defaults often require a pull request, signed commits, or linear history. Any of those makes **every bot push fail with 403 forever** (the bot commits directly to `main`, unsigned). Either create the repo without a ruleset, or add a bypass for the `github-actions` app / your bot user, or target another default branch that has no rules.

## 2. Make sure the failure emails have a recipient, then push (3 min)

GitHub attributes a scheduled run — and its failure email — to the **author of the commit that last touched the cron line in `poll.yml`**. Pushing an existing commit does not change its author. The local commits are authored `stormfunnel-pl-recorder <bart@exegov.ai>`; if that address is not a **verified email on the pushing GitHub account**, no user is attached to the runs and **nobody is emailed for six months.**

Either verify: GitHub → **Settings → Emails** → `bart@exegov.ai` is listed and verified. Or re-author the workflow commit with the account's email before the first push:

```
cd C:\Users\bachn\Projects\stormfunnel-pl-recorder
git config user.name "<your GitHub name>"
git config user.email "<a verified email of the GitHub account>"
git commit --amend --reset-author --no-edit     # only if bart@exegov.ai is NOT verified on the account
git remote add origin <URL>
git push -u origin main
```

Credential note: pushing a file under `.github/workflows/` over HTTPS needs a credential with the `workflow` scope — SSH keys and Git Credential Manager's OAuth login are fine; a classic PAT without `workflow` is rejected with "refusing to allow ... to create or update workflow".

## 3. Set the contact string (2 min)

Repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**: `RECORDER_CONTACT` = an email IMGW/Meteoalarm ops could reach (goes into the User-Agent). Not a secret.

## 4. Allow the workflow to push (2 min)

Repo → **Settings → Actions → General**:
- Actions permissions: *Allow all actions and reusable workflows* (or at least `actions/checkout`, `actions/setup-node`). If this section is greyed out the org owner has locked it at org level: Org → Settings → Actions → General → allow for this repo (or ask the owner).
- Workflow permissions: **Read and write permissions**. (The workflow also asks for `contents: write` itself; the setting removes one way for that to be denied by an org policy.)

If the org has "Allow GitHub Actions to create and approve pull requests" locked down it does not matter — the recorder never opens PRs.

## 5. First run by hand (5 min)

Repo → **Actions → poll → Run workflow → main**. Wait for green. Check:
- a new commit `poll 2026-…Z` by `recorder-bot`;
- `heartbeat.json` in the repo has fresh `last_success` for all 5 sources;
- the *Health check* step is green and `state/alarms.json` is `{}`.

If the push step fails with **403**: step 1 (ruleset) or step 4 was not applied, or the org forbids GITHUB_TOKEN writes. Fallback: create a fine-grained PAT (this repo only, *Contents: read and write*), store it as repo secret `RECORDER_PUSH_TOKEN`, and pass it to checkout — the commented line in `poll.yml` already sits in the right place:

```yaml
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          token: ${{ secrets.RECORDER_PUSH_TOKEN }}
```

Commit that change **through the GitHub web editor** so the workflow's actor stays your account. Not needed in the default configuration.

## 6. Schedule is on automatically

The `schedule` trigger is live as soon as the file is on the default branch. The first cron tick usually comes within 10–20 min, but a new repo can wait **up to an hour** — do not debug before that. Verify after ~1 h: Actions tab shows runs every ~10 min and commits keep landing. Open one scheduled run and confirm the actor shown at the top is **you** (not `github-actions`): that is who gets the emails.

## 7. Notifications (2 min, probably already correct)

Your GitHub → **Settings → Notifications → Actions**: "Send notifications for failed workflows only" (default). Also toggle "Notify me on the web" if you want the bell.

What to expect: `check.js` dedupes — **one email when a problem starts, one every 6 h while it lasts, none when it clears.** GitHub itself would mail on every red run (144/day); the dedupe map is `state/alarms.json`. If you get more than ~4 emails/day for the same source, something else is wrong (open the run: known problems appear as yellow `::warning::` annotations, not red runs).

## 8. Weekly, 5 min

- Open Actions: is the latest run green and recent? If the workflow got disabled (60-day inactivity rule, or GitHub paused it) there is a banner + an **Enable workflow** button.
- `git pull` locally, `npm run report`, glance at mutation %, silent-disappearance %, and cron gap p90.
- If a **SCHEMA DRIFT** alarm is red: read the last `schema_drift` line with `"alarm":true` in `ledger/<source>/<YYYY-MM>.ndjson` (added keys / changed top shape), decide whether the parser needs work, then acknowledge: open `state/acknowledged-schemas.json` **in the GitHub web editor**, set `<source>` to the `schema_hash` shown in `heartbeat.json`, commit to `main`. Green next tick. (Editing locally works too, but the bot pushes every 10 min, so your push will be non-fast-forward: `git pull --rebase` right before `git push`.)

## Stop / pause

Actions → poll → "…" → **Disable workflow**. Data stays. Re-enable the same way.

## Read the data without cloning everything

The repo will reach tens of thousands of commits. Use `git clone --depth 1` for a working copy; the whole picture is always in HEAD (ledger and poll logs are cumulative monthly files, snapshots are files, nothing is only in history).
