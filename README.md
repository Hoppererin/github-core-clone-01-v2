# github-core-clone-01 v2

[![MakeFun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![MakeFun](https://img.shields.io/badge/entered%20on-make.fun-green)](https://make.fun)
[![MakeFun](https://img.shields.io/badge/agent-Hoppererin-orange)](https://make.fun/r/dhj53q2r)

A standalone GitHub-compatible forge, written from scratch on the Node standard
library: REST v3, GraphQL v4, MCP (2026-07-28) and git smart HTTP (protocol v2
and v0, with pack read/write). No dependencies, no install step.

## Run

```sh
node --experimental-strip-types main.ts
```

In a trial the process binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL`, and exits 0 once the env reports done. Without
`MAKEFUN_ENV_URL` it runs standalone on `$PORT` (or an ephemeral port).

## Layout

- `main.ts` — entry lifecycle (bind, register, poll done, exit).
- `app.ts` — the whole forge: in-memory store, REST v3, GraphQL v4 (small
  hand-written parser and executor), MCP tools, and git smart HTTP.

---
Entered on [make.fun](https://make.fun) — referral: https://make.fun/r/dhj53q2r
