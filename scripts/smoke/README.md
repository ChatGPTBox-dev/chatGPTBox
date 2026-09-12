# Browser smoke tests

This maintained Linux smoke tool loads the built extension into real, isolated
headless Chromium and Firefox sessions. It does not use Xvfb, real API credentials,
external test websites, or the user's browser profile. It does not install software,
download browsers, build the extension, or integrate with CI automatically.

## Prerequisites and usage

Install Node 22+, project dependencies (`npm ci`), full Chromium or Chrome for
Testing, Firefox, and a native Linux geckodriver binary. Browser installation is an
explicit prerequisite, not part of the runner. An npm geckodriver launcher is
rejected because it may download a driver. Use the actual extracted executable.

Build in the same worktree first:

```sh
npm run build
npm run smoke -- --browser all \
  --chromium-path /path/to/chromium \
  --firefox-path /path/to/firefox \
  --geckodriver-path /path/to/geckodriver
```

Firefox installs a temporary add-on from a per-run copy of `build/firefox`, not
`build/firefox.zip`. The copy must match the directory hash recorded during
preflight; a changed or incomplete build fails before Firefox starts. Popup paths
and expected identity come from that verified copy's manifest, including its query
string. This validates the unpacked build, not the distribution ZIP. A missing or
stale distribution ZIP does not select different JavaScript for the smoke run.

Use `--browser chromium` or `--browser firefox` for a single browser. The default
is `all`, with Chromium followed by Firefox. All selected prerequisites are checked
before any browser starts; missing browsers are failures, not skipped passes.
Paths supplied on the command line override PATH discovery. Discovery searches
explicit PATH directories; empty components do not imply the current directory.
Use an explicit `--*-path ./executable` or PATH entry `.` to select a local binary.
Relative executable and artifact-parent paths use the caller's working directory.
Build entry paths are fixed at `build/<browser>` in the runner's own worktree.
Chromium accepts a stable build-root symlink, whose canonical target may be outside
the worktree; Firefox requires a non-symlink build root. Paths containing spaces work.

`node scripts/xvfb-smoke.mjs` and `sh scripts/run-smoke.sh` are compatibility
entry points to the same runner. Despite the historical filename, Xvfb is not
required. `--help` lists options. There is no automatic sandbox-disabling flag;
the browser must be able to start with its normal sandbox.

Use full Chromium or Chrome for Testing, not `chrome-headless-shell` or branded
Google Chrome. Chrome 137+ removed the command-line extension-loading flag from
branded builds. See the [Chromium announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ).
Firefox requires geckodriver's `--allow-system-access` for privileged popup
navigation, and dynamic port flags; see [geckodriver flags](https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html).

## What is verified

- The installed extension's identity, version, and rendered popup.
- A popup extension port reaches the real background implementation, which sends
  a Chat Completions request to the run's loopback-only mock server.
- A first answer arrives while the server deliberately holds the rest of the
  response; after release, the complete Unicode answer, one completion message,
  and one conversation record are asserted.
- An HTTP failure reports an error without a successful completion or new record.

This tests the committed Chat Completions route and does not require the separate
Responses API feature. Exact byte splitting, UTF-8 boundaries, and CRLF parsing
remain deterministic unit tests: separate server writes do not guarantee separate
browser network reads. These checks are a focused runtime smoke test, not a
replacement for all site-adapter and keyboard interaction testing in AGENTS.md.

## Isolation, results, and cleanup

Every invocation gets unique browser profiles, a unique artifact directory, and
OS-assigned loopback ports. Concurrent invocations do not share browser state.
Chromium's debugging endpoint is read from its own profile's `DevToolsActivePort`;
geckodriver's endpoint comes from its own startup log.

`--artifacts-dir PATH` selects a parent directory. The tool creates a unique
`chatgptbox-smoke-*` child, retaining `report.json`, browser logs, and available
failure screenshots/DOM. Reports include selected browsers, versions, build
hashes, checks, failure stage, cleanup errors, and exit status. Retained artifacts
must stay outside the selected build directories; parents inside a build,
including symlink aliases, are rejected before writing. Ancestor directories
such as the worktree root or `/tmp` are allowed because each run gets a new child.
Retained artifacts include Firefox's `extension/` snapshot and its `snapshotDir`
in the report.
For Firefox, `preflightManifestVersion` identifies the initial manifest, and
`manifestVersion` is set from the verified snapshot after successful startup.
Chromium's `manifestVersion` starts with the preflight value and is updated from
the rechecked build on successful startup. `artifactSha256` is the preflight
directory hash; Firefox verifies its snapshot against it before startup.
Chromium rechecks the live directory against that hash before launch and derives
startup identity from the on-disk manifest, not stale caller metadata. Directory
hashes include entry types, length-framed paths and file bytes, and empty directories.
If startup fails, the retained snapshot may be absent or incomplete.
Do not modify a build or the retained snapshot during a run.
Use trusted builds and keep their paths, the artifact parent, and all ancestors
stable during the run. Path-based validation and hashing are not an atomic security
boundary against concurrent directory or symlink substitution and cannot prevent
outside bytes entering retained artifacts if this precondition is violated.
Temporary browser profiles are removed only after confirming their processes have
stopped. If termination cannot be confirmed within the cleanup budget, the run fails and
preserves the profile at the path recorded in the report. The tool never removes the
artifact parent or user profiles. Browser logs and failure DOM may contain test
data; review artifacts before sharing.

Each managed command runs inside an isolated group with a small Node supervisor.
Shutdown first closes browser protocols, then asks the supervisor through a private
IPC channel to signal its own group with SIGTERM and finally SIGKILL (including
itself). The parent never sends termination signals to remembered numeric PIDs or
PGIDs, which can be reused by the OS. The target does not inherit the control channel.
Target exit reports are separate from supervisor exit: if a final group SIGKILL
prevents a target report, its exit status is explicitly unavailable, not inferred.

Cleanup is idempotent and bounded, and attempts remaining resources even when one
cleanup fails. SIGINT and SIGTERM trigger cleanup; a second signal asks supervisors
to accelerate termination. Control-channel loss triggers local supervisor cleanup,
but unexpected loss of the supervisor remains an error and preserves its profile.
An unresponsive or forcibly killed supervisor, machine failure, uninterruptible
processes, or a browser escaping its group can prevent complete cleanup. The parent
reports uncertainty rather than retrying termination using an unverified group ID.

Startup is limited to 60 seconds, individual browser requests to 30 seconds, the
browser test run to five minutes, and cleanup to ten seconds. Readiness checks
may retry, but session creation, addon installation, and test requests never do.

| Exit status | Meaning                                             |
| ----------- | --------------------------------------------------- |
| 0           | Every selected browser passed and cleanup succeeded |
| 1           | Test, runtime, reporting, or cleanup failure        |
| 2           | Invalid arguments or missing prerequisites/builds   |
| 130         | SIGINT                                              |
| 143         | SIGTERM                                             |

The shell and npm entry points preserve failure status. No fixed `/tmp/smoke.done`
or `/tmp/smoke.out` files are used. A Firefox-only pass is not an all-browser pass.
The console prints the artifact location, not a provisional PASS or exit code:
signals can still arrive while that output is pending. Use the process exit status
and `report.json` for the final result.

## Development checks

Run the targeted formatter on changed files, `npm run lint`, `shellcheck
scripts/run-smoke.sh`, `npm test`, `npm run build`, then the actual browser smoke.
`npm test` includes fake-protocol and real child-process lifecycle tests, but never
launches a real browser automatically. It needs loopback socket access for mock
servers. No new browser automation package or indirect `ws` dependency is used.
