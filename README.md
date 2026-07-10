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
no dotenv), then:

```
yarn start
```

Contract types are generated from the ABIs in `abis/` (exported from the
[governance](https://github.com/ArbitrumFoundation/governance) repo) via
`yarn gen:types`.
