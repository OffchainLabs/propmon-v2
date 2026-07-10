import { Signer, providers } from "ethers";
import { Log } from "@ethersproject/abstract-provider";
import { L1TransactionReceipt, L1ToL2MessageStatus } from "@arbitrum/sdk";
import { Address } from "@arbitrum/sdk/dist/lib/dataEntities/address";
import { Bridge__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Bridge__factory";
import { Stage, Verdict } from "./stage";

const bridgeInterface = Bridge__factory.createInterface();

// finds retryable tickets created by one of the configured senders (scanning
// the bridge's MessageDelivered for sender) and redeems them on the L2 via
// ArbRetryableTx
export class RetryableStage extends Stage {
  private readonly senders: string[];

  constructor(
    bridge: string,
    senders: string[],
    findProvider: providers.Provider,
    private readonly handleSigner: Signer,
    startBlock: number
  ) {
    super(bridge, findProvider, startBlock);
    // the inbox may record the sender aliased or not depending on its version
    this.senders = senders.flatMap((s) => [
      s.toLowerCase(),
      new Address(s).applyAlias().value.toLowerCase(),
    ]);
  }

  protected findFilter() {
    return { address: this.address, topics: [bridgeInterface.getEventTopic("MessageDelivered")] };
  }

  protected async filterFound(logs: Log[]): Promise<Log[]> {
    return logs.filter((log) =>
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
    if (status === L1ToL2MessageStatus.REDEEMED) return "skipped";
    if (status === L1ToL2MessageStatus.NOT_YET_CREATED) return "waiting";
    if (status === L1ToL2MessageStatus.CREATION_FAILED || status === L1ToL2MessageStatus.EXPIRED)
      return "dead";
    await (await message.redeem()).wait();
    return "handled";
  }
}
