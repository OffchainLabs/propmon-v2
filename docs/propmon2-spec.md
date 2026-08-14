# PropMon v2 Spec

Rewrite of the proposal monitor. One stage instance per monitored contract
(not per proposal). Each stage scans for events and executes them when ready.
All state is in-memory; on restart we re-scan from a configured start block and
already-executed operations are detected via chain state and reported as skipped.

## IStage

```ts
interface IStage {
  address: string       // the contract this stage acts on
  stageType(): string   // class name by default, overridable
  findEvents(): Promise<Log[]>
  handleEvents(): Promise<{ handled: Log[]; skipped: Log[]; waiting: Log[]; dead: Log[] }>
}
```

- `findEvents()`: query the contract's trigger event from `lastScannedBlock + 1`
  to latest, advance the cursor, append to internal `toHandle`, return the new logs.
- `handleEvents()`: for each log in `toHandle`, decide a verdict:
  - already done on-chain (executed by someone else / a prior run) -> `skipped`
  - terminal, can never be handled (proposal defeated/canceled/expired, timelock
    op cancelled, retryable expired) -> `dead`
  - not ready yet (timelock delay, challenge period, retryable not created) -> `waiting`
  - ready: send the handling tx. Success -> `handled`. Revert/failure -> throw.
  - any verdict except `waiting` removes the log from `toHandle`

`RetryJsonRpcProvider.send()` handles `eth_getLogs` failures by bisection, to
protect against provider "log lookup range too big" limits as simply as
possible: any failure waits X seconds, splits the block range in half
(absent or `"latest"` bounds resolve to the current block number first), and
recurses; an unsplittable query (single block, blockHash filter, unresolvable
tag) falls through to the normal transient-retry path.
Sequential left-then-right recursion keeps logs in order. Because this lives
in `send()`, it covers every log query, including those the Arbitrum SDK
issues internally.

Pseudocode (GovernorStage, the base execute variant, as the example):

```ts
class GovernorStage implements IStage {
  toHandle: Log[] = []
  constructor(address, signer, startBlock) { this.lastScanned = startBlock - 1 }

  async findEvents() {
    const latest = await provider.getBlockNumber()
    const logs = await provider.getLogs({ ...governor.filters.ProposalCreated(), fromBlock: this.lastScanned + 1, toBlock: latest })
    this.lastScanned = latest
    this.toHandle.push(...logs)
    return logs
  }

  async handleEvents() {
    const res = { handled: [], skipped: [], waiting: [], dead: [] }
    for (const log of [...this.toHandle]) {
      const { proposalId, targets, values, calldatas, description } = parse(log)
      const state = await governor.state(proposalId)
      let verdict
      if      (state is Queued | Executed)             verdict = "skipped"
      else if (state is Defeated | Canceled | Expired) verdict = "dead"
      else if (state is Pending | Active)              verdict = "waiting"
      else /* Succeeded */ {
        await (await governor.execute(targets, values, calldatas, keccak(description))).wait() // throws on revert
        verdict = "handled"
      }
      res[verdict].push(log)
      if (verdict !== "waiting") remove log from toHandle
    }
    return res
  }
}
```

## Stages

| Stage          | Trigger event (find on)              | Handle action (send on)                  |
| -------------- | ------------------------------------ | ---------------------------------------- |
| GovernorStage  | ProposalCreated (Arb1)               | queue() / execute() after vote succeeds  |
| TimelockStage  | CallScheduled (Arb1 or L1)           | execute() / executeBatch() after delay   |
| OutboxStage    | L2ToL1Tx from ArbSys (Arb1), caller+destination-filtered | Outbox.executeTransaction (L1) |
| RetryableStage | L1 timelock / upgrade executor execution events, then MessageDelivered in those txs | ArbRetryableTx.redeem (Arb1 or Nova) |

## Main loop

```ts
const stages: IStage[] = loadStages(configPath) // see Config

while (true) {
  for (const stage of stages) {
    for (const log of await stage.findEvents())       info("found", { type, address, log })
    const { handled, skipped, waiting, dead } = await stage.handleEvents()
    // one info line per log in each bucket
  }
  ping()  // fire-and-forget GET to PROPMON_HEALTHCHECK_URL, if set
  await sleep(pollIntervalSeconds)
}
```

Since any stage error crashes the process, reaching the ping means the whole
iteration succeeded.

## Config

The stage set is entirely defined by a jsonc config file: `PROPMON_CONFIG`,
default `config/arb1-governance.jsonc` (all Arbitrum DAO stages). Env vars
cover only secrets and tuning, read once at startup; missing required vars throw:

- `PROPMON_PRIVATE_KEY` - one key, funded on every chain the config sends on
- one rpc url var per configured chain (named by the chain's `rpcUrlEnv`).
  Chains running governor or timelock stages must support
  `debug_traceTransaction` with `callTracer` (used by TimelockStage op
  recovery; public endpoints generally don't serve debug methods)
- `PROPMON_HEALTHCHECK_URL` (optional) - pinged after each successful poll iteration
- tuning (defaulted): `POLL_INTERVAL_SECONDS`, `RPC_RETRY_COUNT`,
  `RPC_RETRY_INTERVAL_SECONDS`, `GETLOGS_WAIT_SECONDS`
- `LOG_LEVEL` - `debug | info | warn`, default `info`

The config file has two sections:

```json
{
  "chains": {
    "eth": { "rpcUrlEnv": "ETH_RPC_URL", "startBlock": 25690000 }
  },
  "stages": [
    { "type": "timelock", "chain": "eth", "address": "0x..." }
  ]
}
```

- `chains` - named chains: `rpcUrlEnv` (env var holding the rpc url) and
  `startBlock`. Each stage scans from the start block of the chain its
  `findEvents` runs on; `startBlock` is only required on chains used for
  finding (e.g. not on a chain only used to redeem retryables).
- `stages` - run in order each iteration. Fields by `type`:
  - `governor | queue-governor | nominee-governor | timelock`: `chain`,
    `address`
  - `outbox`: `address` (the L1 outbox), `l2Chain` (find), `l1Chain`
    (execute), `l2Caller`, `l1Destination` (ArbSys is the fixed precompile
    `0x...64`)
  - `retryable`: `address` (the L1 bridge), `l1Chain` (find), `l2Chain`
    (redeem), `l1Timelock`, `l1UpgradeExecutor`

## Errors

The only errors ever caught are transient RPC errors and failed `eth_getLogs`
queries (bisected, see above). All providers are
`RetryJsonRpcProvider`, a `JsonRpcProvider` subclass whose `send()` override
retries up to N times with a fixed X-second interval, then throws. Since every
ethers call funnels through `send()`, stage code contains no retry logic.

Retried errors are an explicit allowlist:
- transport failures: timeout, connection error, HTTP 429, HTTP 5xx
- known-transient JSON-RPC errors: rate limits (e.g. -32005), "header/block
  not found" from lagging load-balanced nodes, provider-side timeouts

Anything else - reverts, nonce/funds errors, decode errors, retry exhaustion -
propagates up and crashes the process. When in doubt, crash: deterministic
errors (especially reverts) must never be retried.

## Output

Structured JSON logging via `src/log.ts`: `debug()` / `info()` / `warn()`, one
`{ts, level, msg, ...fields}` object per line filtered by `LOG_LEVEL`. Event lines use the verdict as `msg`
(`found | handled | skipped | waiting | dead`) and carry the raw log (no
decoding - downstream tools render); stages only parse logs internally where
needed to function. `(transactionHash, logIndex)` identifies a log across lines.

```json
{"ts":"2026-07-09T12:00:00Z","level":"info","msg":"found","type":"TimelockStage","address":"0x34d4...","log":{"address":"0x34d4...","topics":["0x4cf4...","0x8a71..."],"data":"0x...","blockNumber":362000000,"transactionHash":"0x...","logIndex":3}}
{"ts":"2026-07-09T12:00:05Z","level":"info","msg":"waiting","type":"TimelockStage","address":"0x34d4...","log":{"transactionHash":"0x...","logIndex":3, ...}}
```

Stages also log execution details (op/proposal ids, tx hashes) at `info`,
scan ranges and on-chain statuses at `debug`, and rpc retries at `warn`.
