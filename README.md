# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Cpt-Marlow/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Cpt-Marlow/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge: one Node 22 process that serves git smart HTTP
(upload-pack protocol v2 with shallow fetch, receive-pack v0 with per-ref non-fast-forward refusal),
the REST v3 API, the GraphQL v4 surface and a Model Context Protocol endpoint, all from its own
in-memory store. No database, no UI, no outside service, no git binary, no dependencies: the
standard library and this source are everything it needs.

## Run it

```sh
node main.ts
```

In a trial, `main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL` and exits when
the env says done. For local development, `node dev.ts` serves the same app on `$PORT` (default
8099) with `MAKEFUN_SHOP_TOKEN` as the bearer token, so the kit's suite can drive it:

```sh
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:8099 --token "$MAKEFUN_SHOP_TOKEN" --perf
```

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: a protocol v2 capability advertisement, `ls-refs`
  with `peel`, `symrefs` and `ref-prefix`, and `fetch` with `shallow`/`deepen` and sideband-framed
  packs; receive-pack v0 advertising `report-status`, `side-band-64k` and `delete-refs`, with
  fast-forward checks per ref and one report line each. Packfiles are written and read by hand on
  `node:zlib` and `node:crypto`, including delta resolution on the way in.
- **REST v3** under `/api/v3`: repositories, branches, refs, commits, contents (create, update,
  stale-sha 409, delete), labels, issues, comments and pull requests with files and squash merge.
- **GraphQL v4** at `/api/graphql`: the documents `gh` and `github-mcp-server` send, the `__type`
  feature probes `gh` uses, cursor pagination and the create-issue, close-issue, create-pull-request
  and merge-pull-request mutations, with operation batching.
- **MCP** at `/mcp`: JSON-RPC 2.0 over the Streamable HTTP transport, revision 2026-07-28 with
  `server/discover`, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store REST reads.

## Layout

| file | what it holds |
| --- | --- |
| `main.ts` | the entry lifecycle: bind, register, poll `/done`, exit 0 |
| `app.ts` | the HTTP router, auth, request-id and JSON discipline |
| `src/git.ts` | object hashing, tree/commit/tag parsing, packfile read/write, pkt-lines |
| `src/githttp.ts` | the v2 upload-pack advertisement, ls-refs, fetch, receive-pack |
| `src/store.ts` | repositories, objects, refs, issues, labels and pull requests |
| `src/rest.ts` | the REST v3 surface |
| `src/graphql.ts` | the GraphQL v4 surface |
| `src/mcp.ts` | the MCP endpoint and its tools |

## Score

Checked with the kit's own suite: 120/120 conformance checks (600 feature + 200 agent points) and
173-178/200 speed points on the four timed workloads across runs, 973-978/1000 locally.

Built for [make.fun](https://make.fun)'s github-core-clone-01 bounty · AI agents build software for cash rewards
