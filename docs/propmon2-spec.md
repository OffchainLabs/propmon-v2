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

All event queries go through a bisecting helper, to protect against provider
"log lookup range too big" limits as simply as possible:

```ts
async function getLogs(provider, filter, fromBlock, toBlock): Promise<Log[]> {
  try { return await provider.getLogs({ ...filter, fromBlock, toBlock }) }
  catch (e) {
    if (fromBlock === toBlock) throw e
    await wait(X seconds)
    const mid = Math.floor((fromBlock + toBlock) / 2)
    return [...await getLogs(provider, filter, fromBlock, mid),
            ...await getLogs(provider, filter, mid + 1, toBlock)]
  }
}
```

Any failure bisects; a failure on a single-block range throws. Sequential
left-then-right recursion keeps logs in order. `RetryJsonRpcProvider.send()`
skips its retry logic for `eth_getLogs` so the helper's wait-and-bisect is the
only retry path for log queries.

Pseudocode (GovernorStage, the base execute variant, as the example):

```ts
class GovernorStage implements IStage {
  toHandle: Log[] = []
  constructor(address, signer, startBlock) { this.lastScanned = startBlock - 1 }

  async findEvents() {
    const latest = await provider.getBlockNumber()
    const logs = await getLogs(provider, governor.filters.ProposalCreated(), this.lastScanned + 1, latest)
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
| RetryableStage | MessageDelivered from Bridge (L1), sender-filtered | ArbRetryableTx.redeem (Arb1 or Nova) |

GovernorStage variants: base = execute() when Succeeded (member election
governor); QueueGovernorStage = queue() instead (core, treasury); NomineeGovernorStage
= also wait for the vetting deadline (an L1 block number) before execute().
OutboxStage and RetryableStage are cross-chain: constructor takes
(address, findProvider, handleSigner). Both ignore unrelated traffic:
OutboxStage only picks up L2ToL1Tx with caller == the L2 timelock and
destination == the L1 timelock (destination is an indexed topic; caller is
filtered client-side); RetryableStage only picks up MessageDelivered with
sender in a configured list - the L1 timelock and the L1 upgrade executor
(each aliased or not, filtered client-side).

## Main loop

```ts
// start blocks are per-chain config: each stage scans from the start block of
// the chain its findEvents runs on
const stages: IStage[] = [
  new QueueGovernorStage(coreGovernor, arbSigner, arbStartBlock),
  new QueueGovernorStage(treasuryGovernor, arbSigner, arbStartBlock),
  new NomineeGovernorStage(nomineeElectionGovernor, arbSigner, arbStartBlock),
  new GovernorStage(memberElectionGovernor, arbSigner, arbStartBlock),
  new TimelockStage(l2Timelock, arbSigner, arbStartBlock),
  new OutboxStage(arbSys, l2Timelock, l1Timelock, arbProvider, l1Outbox, ethSigner, arbStartBlock),
  new TimelockStage(l1Timelock, ethSigner, ethStartBlock),
  new RetryableStage(arbBridge, [l1Timelock, l1UpgradeExecutor], ethProvider, arbSigner, ethStartBlock),
  new RetryableStage(novaBridge, [l1Timelock, l1UpgradeExecutor], ethProvider, novaSigner, ethStartBlock),
]

while (true) {
  for (const stage of stages) {
    for (const log of await stage.findEvents())       emit(stage, "found", log)
    const { handled, skipped, waiting, dead } = await stage.handleEvents()
    // emit one line per log in each bucket
  }
  ping()  // fire-and-forget GET to PROPMON_HEALTHCHECK_URL, if set
  await sleep(pollIntervalSeconds)
}
```

Since any stage error crashes the process, reaching the ping means the whole
iteration succeeded.

## Config

All config comes from env vars, read once at startup; missing required vars throw.

- `ETH_RPC_URL`, `ARB_RPC_URL`, `NOVA_RPC_URL` - the first two must support
  `debug_traceTransaction` with `callTracer` (used by TimelockStage op
  recovery; public endpoints generally don't serve debug methods)
- `PROPMON_PRIVATE_KEY` - one key, funded on all three chains
- addresses: `CORE_GOVERNOR`, `TREASURY_GOVERNOR`, `NOMINEE_ELECTION_GOVERNOR`,
  `MEMBER_ELECTION_GOVERNOR`, `L2_TIMELOCK`, `L1_TIMELOCK`, `L1_OUTBOX`,
  `L1_UPGRADE_EXECUTOR`, `ARB_BRIDGE`, `NOVA_BRIDGE` (ArbSys is the fixed
  precompile `0x...64`)
- `ARB_START_BLOCK`, `ETH_START_BLOCK`
- `PROPMON_HEALTHCHECK_URL` (optional) - pinged after each successful poll iteration
- tuning (defaulted): `POLL_INTERVAL_SECONDS`, `RPC_RETRY_COUNT`,
  `RPC_RETRY_INTERVAL_SECONDS`, `GETLOGS_WAIT_SECONDS`

## Errors

The only errors ever caught are transient RPC errors. All providers are
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

One JSON object per line on stdout. Logs are emitted raw (no decoding -
downstream tools render); stages only parse logs internally where needed to
function. `(transactionHash, logIndex)` identifies a log across lines.

```json
{"ts":"2026-07-09T12:00:00Z","kind":"found","type":"TimelockStage","address":"0x34d4...","log":{"address":"0x34d4...","topics":["0x4cf4...","0x8a71..."],"data":"0x...","blockNumber":362000000,"transactionHash":"0x...","logIndex":3}}
{"ts":"2026-07-09T12:00:05Z","kind":"waiting","type":"TimelockStage","address":"0x34d4...","log":{"transactionHash":"0x...","logIndex":3, ...}}
```

Kinds: `found | handled | skipped | waiting | dead`.
