import { Signer, providers } from "ethers";
import { id } from "ethers/lib/utils";
import { Log } from "@ethersproject/abstract-provider";
import { L1TransactionReceipt, L1ToL2MessageStatus } from "@arbitrum/sdk";
import { Address } from "@arbitrum/sdk/dist/lib/dataEntities/address";
import { Bridge__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Bridge__factory";
import { ArbitrumTimelock__factory } from "../typechain-types";
import { getLogs } from "./rpc";
import { Stage, Verdict } from "./stage";
import { debug, info } from "./log";

const bridgeInterface = Bridge__factory.createInterface();
const messageDeliveredTopic = bridgeInterface.getEventTopic("MessageDelivered");
const callExecutedTopic = ArbitrumTimelock__factory.createInterface().getEventTopic("CallExecuted");
// UpgradeExecutor.execute (delegatecall) and executeCall (call)
const upgradeExecutorTopics = [
  id("UpgradeExecuted(address,uint256,bytes)"),
  id("TargetCallExecuted(address,uint256,bytes)"),
];

// governance retryables only come from L1 timelock / upgrade executor
// executions, and the bridge's MessageDelivered is far too noisy to scan
// directly: find execution events on those two contracts, then pick our
// MessageDelivered logs out of the same transactions. handleEvents redeems
// the tickets on the L2 via ArbRetryableTx
export class RetryableStage extends Stage {
  private readonly senders: string[];

  constructor(
    bridge: string,
    private readonly l1Timelock: string,
    private readonly l1UpgradeExecutor: string,
    findProvider: providers.Provider,
    private readonly handleSigner: Signer,
    startBlock: number
  ) {
    super(bridge, findProvider, startBlock);
    // the inbox may record the sender aliased or not depending on its version
    this.senders = [l1Timelock, l1UpgradeExecutor].flatMap((s) => [
      s.toLowerCase(),
      new Address(s).applyAlias().value.toLowerCase(),
    ]);
  }

  protected findFilter(): never {
    throw new Error("unreachable: findEvents is overridden");
  }

  async findEvents(): Promise<Log[]> {
    const latest = await this.findProvider.getBlockNumber();
    if (latest <= this.lastScanned) return [];
    debug("scanning", {
      type: this.stageType(),
      address: this.address,
      fromBlock: this.lastScanned + 1,
      toBlock: latest,
    });
    const executions = [
      ...(await getLogs(
        this.findProvider,
        { address: this.l1Timelock, topics: [callExecutedTopic] },
        this.lastScanned + 1,
        latest
      )),
      ...(await getLogs(
        this.findProvider,
        { address: this.l1UpgradeExecutor, topics: [upgradeExecutorTopics] },
        this.lastScanned + 1,
        latest
      )),
    ];
    const found: Log[] = [];
    for (const txHash of new Set(executions.map((l) => l.transactionHash))) {
      const receipt = await this.findProvider.getTransactionReceipt(txHash);
      found.push(...receipt.logs.filter((l) => this.isGovernanceTicket(l)));
    }
    this.lastScanned = latest;
    this.toHandle.push(...found);
    return found;
  }

  // one execution can create tickets on several bridges; the address check
  // keeps each stage instance on its own bridge
  private isGovernanceTicket(log: Log): boolean {
    return (
      log.address.toLowerCase() === this.address.toLowerCase() &&
      log.topics[0] === messageDeliveredTopic &&
      this.senders.includes(bridgeInterface.parseLog(log).args.sender.toLowerCase())
    );
  }

  // the sdk parses the creation tx's receipt into L1ToL2Messages for the
  // handleSigner's L2; ours is the one with this log's messageIndex
  protected async handleLog(log: Log): Promise<Verdict> {
    const receipt = await this.findProvider.getTransactionReceipt(log.transactionHash);
    const messages = await new L1TransactionReceipt(receipt).getL1ToL2Messages(this.handleSigner);
    const message = messages.find((m) => m.messageNumber.eq(log.topics[1]));
    if (!message) {
      throw new Error(
        `${this.stageType()}:${this.address}: no L1ToL2 message ${log.topics[1]} in ${
          log.transactionHash
        }`
      );
    }
    const status = await message.status();
    debug("retryable status", {
      address: this.address,
      messageNumber: message.messageNumber.toString(),
      status: L1ToL2MessageStatus[status],
    });
    if (status === L1ToL2MessageStatus.REDEEMED) return "skipped";
    if (status === L1ToL2MessageStatus.NOT_YET_CREATED) return "waiting";
    if (status === L1ToL2MessageStatus.CREATION_FAILED || status === L1ToL2MessageStatus.EXPIRED)
      return "dead";
    const tx = await message.redeem();
    await tx.wait();
    info("retryable redeemed", {
      address: this.address,
      messageNumber: message.messageNumber.toString(),
      tx: tx.hash,
    });
    return "handled";
  }
}
