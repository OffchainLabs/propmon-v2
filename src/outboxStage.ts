import { Signer, providers } from "ethers";
import { Log } from "@ethersproject/abstract-provider";
import { L2ToL1Message, L2ToL1MessageStatus } from "@arbitrum/sdk";
import { EventArgs } from "@arbitrum/sdk/dist/lib/dataEntities/event";
import { L2ToL1TxEvent } from "@arbitrum/sdk/dist/lib/abi/ArbSys";
import { ArbSys__factory } from "@arbitrum/sdk/dist/lib/abi/factories/ArbSys__factory";
import { Outbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Outbox__factory";
import { Outbox } from "@arbitrum/sdk/dist/lib/abi/Outbox";
import { Stage, Verdict } from "./stage";
import { debug, info } from "./log";

const arbSysInterface = ArbSys__factory.createInterface();

// finds L2ToL1Tx events on arbsys (destination-filtered by topic, caller-filtered
// client-side) and executes them on the L1 outbox once confirmed
export class OutboxStage extends Stage {
  private readonly outbox: Outbox;

  constructor(
    private readonly arbSys: string,
    private readonly l2Caller: string,
    private readonly l1Destination: string,
    findProvider: providers.Provider,
    outboxAddress: string,
    private readonly handleSigner: Signer,
    startBlock: number
  ) {
    super(outboxAddress, findProvider, startBlock);
    this.outbox = Outbox__factory.connect(outboxAddress, handleSigner);
  }

  protected findFilter() {
    return {
      address: this.arbSys,
      topics: arbSysInterface.encodeFilterTopics("L2ToL1Tx", [null, this.l1Destination]),
    };
  }

  protected async filterFound(logs: Log[]): Promise<Log[]> {
    return logs.filter(
      (log) =>
        arbSysInterface.parseLog(log).args.caller.toLowerCase() === this.l2Caller.toLowerCase()
    );
  }

  protected async handleLog(log: Log): Promise<Verdict> {
    const event = arbSysInterface.parseLog(log).args as unknown as EventArgs<L2ToL1TxEvent>;
    const position = event.position.toString();
    if (await this.outbox.isSpent(event.position)) return "skipped";
    const message = L2ToL1Message.fromEvent(this.handleSigner, event);
    const status = await message.status(this.findProvider);
    debug("l2->l1 message status", {
      address: this.address,
      position,
      status: L2ToL1MessageStatus[status],
    });
    if (status === L2ToL1MessageStatus.EXECUTED) return "skipped";
    if (status === L2ToL1MessageStatus.UNCONFIRMED) return "waiting";
    const tx = await message.execute(this.findProvider);
    await tx.wait();
    info("l2->l1 message executed", { address: this.address, position, tx: tx.hash });
    return "handled";
  }
}
