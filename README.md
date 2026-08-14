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
yarn start                                    # config/arb1-governance.jsonc: all Arbitrum DAO stages
PROPMON_CONFIG=my-config.json yarn start      # any custom stage set
```

The stages to run are entirely defined by a jsonc config file
(`PROPMON_CONFIG`, default `config/arb1-governance.jsonc`)

```json
{
  "chains": { "eth": { "rpcUrlEnv": "ETH_RPC_URL", "startBlock": 25690000 } },
  "stages": [{ "type": "timelock", "chain": "eth", "address": "0x..." }]
}
```

See [docs/propmon2-spec.md](./docs/propmon2-spec.md#config) for the fields
each stage type takes.

Contract types are generated from the ABIs in `abis/` (exported from the
[governance](https://github.com/ArbitrumFoundation/governance) repo) via
`yarn gen:types`.
