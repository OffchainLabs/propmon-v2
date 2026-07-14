import { BigNumber, Signer } from "ethers";
import { defaultAbiCoder, keccak256, hexDataLength } from "ethers/lib/utils";
import { Log } from "@ethersproject/abstract-provider";
import { JsonRpcProvider } from "@ethersproject/providers";
import { ArbitrumTimelock, ArbitrumTimelock__factory } from "../typechain-types";
import { Inbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Inbox__factory";
import { Stage, Verdict } from "./stage";
import { debug, info } from "./log";

const timelockInterface = ArbitrumTimelock__factory.createInterface();

// L1ArbitrumTimelock.RETRYABLE_TICKET_MAGIC: ops with this target create a retryable
// ticket at execution time and need the executor to supply value for it
const RETRYABLE_TICKET_MAGIC = "0xa723c008e76e379c55599d2e4d93879beafda79c";

type ScheduledOp = {
  id: string;
  batch: boolean;
  targets: string[];
  values: BigNumber[];
  datas: string[];
  predecessor: string;
  salt: string;
};

export class TimelockStage extends Stage {
  private readonly timelock: ArbitrumTimelock;

  constructor(address: string, signer: Signer, startBlock: number) {
    super(address, signer.provider!, startBlock);
    this.timelock = ArbitrumTimelock__factory.connect(address, signer);
  }

  protected findFilter() {
    return this.timelock.filters.CallScheduled();
  }

  // scheduleBatch emits one CallScheduled per call, all sharing an op id; the
  // first ready log executes the whole op, its siblings then come back skipped
  protected async handleLog(log: Log): Promise<Verdict> {
    const opId = log.topics[1];
    if (!(await this.timelock.isOperation(opId))) return "dead"; // cancelled
    if (await this.timelock.isOperationDone(opId)) return "skipped";
    if (!(await this.timelock.isOperationReady(opId))) return "waiting";
    await this.execute(opId, log.transactionHash);
    return "handled";
  }

  private async execute(opId: string, scheduleTx: string) {
    const ops = await traceScheduledOps(
      this.findProvider as JsonRpcProvider,
      scheduleTx,
      this.timelock.address
    );
    const op = ops.find((o) => o.id === opId);
    if (!op)
      throw new Error(
        `${this.stageType()}:${
          this.address
        }: no scheduled op matches operation ${opId} (scheduled in ${scheduleTx})`
      );

    let value = BigNumber.from(0);
    for (let i = 0; i < op.targets.length; i++) {
      value = value.add(await this.executionValue(op.targets[i], op.values[i], op.datas[i]));
    }

    info("executing timelock op", {
      address: this.address,
      opId,
      targets: op.targets,
      value: value.toString(),
    });
    const tx = op.batch
      ? await this.timelock.executeBatch(op.targets, op.values, op.datas, op.predecessor, op.salt, {
          value,
        })
      : await this.timelock.execute(
          op.targets[0],
          op.values[0],
          op.datas[0],
          op.predecessor,
          op.salt,
          {
            value,
          }
        );
    await tx.wait();
    info("timelock op executed", { address: this.address, opId, tx: tx.hash });
  }

  // value the executor must supply for this call: retryable ticket funding for
  // magic targets, the call value otherwise
  private async executionValue(target: string, value: BigNumber, data: string): Promise<BigNumber> {
    if (target.toLowerCase() !== RETRYABLE_TICKET_MAGIC) return value;
    const [inbox, , l2Value, gasLimit, maxFeePerGas, l2Calldata] = defaultAbiCoder.decode(
      ["address", "address", "uint256", "uint256", "uint256", "bytes"],
      data
    );
    const submissionFee = await Inbox__factory.connect(
      inbox,
      this.findProvider
    ).calculateRetryableSubmissionFee(
      hexDataLength(l2Calldata),
      await this.findProvider.getGasPrice()
    );
    // double the submission fee to leave leeway for the base fee to increase
    const funding = submissionFee.mul(2).add(gasLimit.mul(maxFeePerGas)).add(l2Value);
    debug("retryable ticket funding", { inbox, funding: funding.toString() });
    return funding;
  }
}

// the deployed OZ timelock predates the CallSalt event, so execution args can't
// come from events alone: trace the scheduling tx and decode every
// schedule/scheduleBatch call to the timelock found in the call tree
async function traceScheduledOps(
  provider: JsonRpcProvider,
  txHash: string,
  timelock: string
): Promise<ScheduledOp[]> {
  const trace = await provider.send("debug_traceTransaction", [txHash, { tracer: "callTracer" }]);
  const scheduleSig = timelockInterface.getSighash("schedule");
  const batchSig = timelockInterface.getSighash("scheduleBatch");
  const ops: ScheduledOp[] = [];
  const walk = (frame: any) => {
    if (frame.to?.toLowerCase() === timelock.toLowerCase() && typeof frame.input === "string") {
      if (frame.input.startsWith(scheduleSig)) {
        const [target, value, data, predecessor, salt] = timelockInterface.decodeFunctionData(
          "schedule",
          frame.input
        );
        ops.push({
          id: hashOperation(target, value, data, predecessor, salt),
          batch: false,
          targets: [target],
          values: [value],
          datas: [data],
          predecessor,
          salt,
        });
      }
      if (frame.input.startsWith(batchSig)) {
        const [targets, values, payloads, predecessor, salt] = timelockInterface.decodeFunctionData(
          "scheduleBatch",
          frame.input
        );
        ops.push({
          id: hashOperationBatch(targets, values, payloads, predecessor, salt),
          batch: true,
          targets,
          values,
          datas: payloads,
          predecessor,
          salt,
        });
      }
    }
    (frame.calls || []).forEach(walk);
  };
  walk(trace);
  return ops;
}

const hashOperation = (
  target: string,
  value: BigNumber,
  data: string,
  predecessor: string,
  salt: string
) =>
  keccak256(
    defaultAbiCoder.encode(
      ["address", "uint256", "bytes", "bytes32", "bytes32"],
      [target, value, data, predecessor, salt]
    )
  );

const hashOperationBatch = (
  targets: string[],
  values: BigNumber[],
  datas: string[],
  predecessor: string,
  salt: string
) =>
  keccak256(
    defaultAbiCoder.encode(
      ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
      [targets, values, datas, predecessor, salt]
    )
  );
