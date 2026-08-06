# PropMon

Monitors Arbitrum DAO proposals and moves them through their lifecycle stages
(governor queue, timelocks, outbox execution, retryable redemption). See
[docs/propmon2-spec.md](./docs/propmon2-spec.md).

## Usage

```
yarn
yarn build
```

Set the env vars listed in `.env-sample` (the process env is read directly;
no dotenv), then run one of the two modes:

```
yarn start                                    # arb-full-governance (default): all Arbitrum DAO stages
PROPMON_MODE=individual-stage yarn start      # a single stage, configured via STAGE_TYPE etc.
```

`individual-stage` runs one stage against any contract, e.g. a timelock that
is part of another governance system. See `.env-sample` for the vars each
`STAGE_TYPE` needs.

Contract types are generated from the ABIs in `abis/` (exported from the
[governance](https://github.com/ArbitrumFoundation/governance) repo) via
`yarn gen:types`.
