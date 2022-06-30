/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { blake3 } from '@napi-rs/blake-hash'
import LeastRecentlyUsed from 'blru'
import { Assert } from '../assert'
import { Config } from '../fileStores/config'
import { Logger } from '../logger'
import { Target } from '../primitives/target'
import { RpcSocketClient } from '../rpc/clients'
import { SerializedBlockTemplate } from '../serde/BlockTemplateSerde'
import { BigIntUtils } from '../utils/bigint'
import { ErrorUtils } from '../utils/error'
import { FileUtils } from '../utils/file'
import { SetIntervalToken, SetTimeoutToken } from '../utils/types'
import { MiningPoolShares } from './poolShares'
import { MiningStatusMessage } from './stratum/messages'
import { StratumServer } from './stratum/stratumServer'
import { StratumServerClient } from './stratum/stratumServerClient'
import { mineableHeaderString } from './utils'
import { WebhookNotifier } from './webhooks'

const RECALCULATE_TARGET_TIMEOUT = 10000

export class MiningPool {
  readonly stratum: StratumServer
  readonly rpc: RpcSocketClient
  readonly logger: Logger
  readonly shares: MiningPoolShares
  readonly config: Config
  readonly webhooks: WebhookNotifier[]

  private started: boolean
  private stopPromise: Promise<void> | null = null
  private stopResolve: (() => void) | null = null

  private connectWarned: boolean
  private connectTimeout: SetTimeoutToken | null

  name: string

  nextMiningRequestId: number
  miningRequestBlocks: LeastRecentlyUsed<number, SerializedBlockTemplate>
  recentSubmissions: Map<number, string[]>

  difficulty: bigint
  target: Buffer

  currentHeadTimestamp: number | null
  currentHeadDifficulty: bigint | null

  recalculateTargetInterval: SetIntervalToken | null

  private notifyStatusInterval: SetIntervalToken | null

  private constructor(options: {
    rpc: RpcSocketClient
    shares: MiningPoolShares
    config: Config
    logger: Logger
    webhooks?: WebhookNotifier[]
    host?: string
    port?: number
    banning?: boolean
  }) {
    this.rpc = options.rpc
    this.logger = options.logger
    this.webhooks = options.webhooks ?? []
    this.stratum = new StratumServer({
      pool: this,
      config: options.config,
      logger: this.logger,
      host: options.host,
      port: options.port,
      banning: options.banning,
    })
    this.config = options.config
    this.shares = options.shares
    this.nextMiningRequestId = 0
    this.miningRequestBlocks = new LeastRecentlyUsed(12)
    this.recentSubmissions = new Map()
    this.currentHeadTimestamp = null
    this.currentHeadDifficulty = null

    this.name = this.config.get('poolName')

    this.difficulty = BigInt(this.config.get('poolDifficulty'))
    const basePoolTarget = Target.fromDifficulty(this.difficulty).asBigInt()
    this.target = BigIntUtils.toBytesBE(basePoolTarget, 32)

    this.connectTimeout = null
    this.connectWarned = false
    this.started = false

    this.recalculateTargetInterval = null
    this.notifyStatusInterval = null
  }

  static async init(options: {
    rpc: RpcSocketClient
    config: Config
    logger: Logger
    webhooks?: WebhookNotifier[]
    enablePayouts?: boolean
    host?: string
    port?: number
    balancePercentPayoutFlag?: number
    banning?: boolean
  }): Promise<MiningPool> {
    const shares = await MiningPoolShares.init({
      rpc: options.rpc,
      config: options.config,
      logger: options.logger,
      webhooks: options.webhooks,
      enablePayouts: options.enablePayouts,
      balancePercentPayoutFlag: options.balancePercentPayoutFlag,
    })

    return new MiningPool({
      rpc: options.rpc,
      logger: options.logger,
      config: options.config,
      webhooks: options.webhooks,
      host: options.host,
      port: options.port,
      shares,
      banning: options.banning,
    })
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.stopPromise = new Promise((r) => (this.stopResolve = r))
    this.started = true
    await this.shares.start()

    this.logger.info(
      `Starting stratum server v${String(this.stratum.version)} on ${this.stratum.host}:${
        this.stratum.port
      }`,
    )
    this.stratum.start()

    this.logger.info('Connecting to node...')
    this.rpc.onClose.on(this.onDisconnectRpc)

    const statusInterval = this.config.get('poolStatusNotificationInterval')
    if (statusInterval > 0) {
      this.notifyStatusInterval = setInterval(
        () => void this.notifyStatus(),
        statusInterval * 1000,
      )
    }

    void this.startConnectingRpc()
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.logger.debug('Stopping pool, goodbye')

    this.started = false
    this.rpc.onClose.off(this.onDisconnectRpc)
    this.rpc.close()
    this.stratum.stop()

    await this.shares.stop()

    if (this.stopResolve) {
      this.stopResolve()
    }

    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout)
    }

    if (this.recalculateTargetInterval) {
      clearInterval(this.recalculateTargetInterval)
    }

    if (this.notifyStatusInterval) {
      clearInterval(this.notifyStatusInterval)
    }
  }

  async waitForStop(): Promise<void> {
    await this.stopPromise
  }

  getTarget(): string {
    return this.target.toString('hex')
  }

  async submitWork(
    client: StratumServerClient,
    miningRequestId: number,
    randomness: string,
  ): Promise<void> {
    Assert.isNotNull(client.publicAddress)
    Assert.isNotNull(client.graffiti)
    if (miningRequestId !== this.nextMiningRequestId - 1) {
      this.logger.debug(
        `Client ${client.id} submitted work for stale mining request: ${miningRequestId}`,
      )
      return
    }

    const originalBlockTemplate = this.miningRequestBlocks.get(miningRequestId)

    if (!originalBlockTemplate) {
      this.logger.warn(
        `Client ${client.id} work for invalid mining request: ${miningRequestId}`,
      )
      return
    }

    const blockTemplate = Object.assign({}, originalBlockTemplate)
    blockTemplate.header = Object.assign({}, originalBlockTemplate.header)

    const isDuplicate = this.isDuplicateSubmission(client.id, randomness)

    if (isDuplicate) {
      this.logger.warn(
        `Client ${client.id} submitted a duplicate mining request: ${miningRequestId}, ${randomness}`,
      )
      return
    }

    this.addWorkSubmission(client.id, randomness)

    blockTemplate.header.graffiti = client.graffiti.toString('hex')
    blockTemplate.header.randomness = randomness

    let headerBytes
    try {
      headerBytes = mineableHeaderString(blockTemplate.header)
    } catch (error) {
      this.stratum.peers.punish(client, `${client.id} sent malformed work.`)
      return
    }

    const hashedHeader = blake3(headerBytes)

    if (hashedHeader.compare(Buffer.from(blockTemplate.header.target, 'hex')) !== 1) {
      this.logger.debug('Valid block, submitting to node')

      const result = await this.rpc.submitBlock(blockTemplate)

      if (result.content.added) {
        const hashRate = await this.estimateHashRate()
        const hashedHeaderHex = hashedHeader.toString('hex')

        this.logger.info(
          `Block ${hashedHeaderHex} submitted successfully! ${FileUtils.formatHashRate(
            hashRate,
          )}/s`,
        )
        this.webhooks.map((w) =>
          w.poolSubmittedBlock(hashedHeaderHex, hashRate, this.stratum.clients.size),
        )
      } else {
        this.logger.info(`Block was rejected: ${result.content.reason}`)
      }
    }

    if (hashedHeader.compare(this.target) !== 1) {
      this.logger.debug('Valid pool share submitted')
      await this.shares.submitShare(client.publicAddress)
    }
  }

  private async startConnectingRpc(): Promise<void> {
    const connected = await this.rpc.tryConnect()

    if (!this.started) {
      return
    }

    if (!connected) {
      if (!this.connectWarned) {
        this.logger.warn(
          `Failed to connect to node on ${String(this.rpc.connection.mode)}, retrying...`,
        )
        this.connectWarned = true
      }

      this.connectTimeout = setTimeout(() => void this.startConnectingRpc(), 5000)
      return
    }

    if (connected) {
      this.webhooks.map((w) => w.poolConnected())
    }

    this.connectWarned = false
    this.logger.info('Successfully connected to node')
    this.logger.info('Listening to node for new blocks')

    void this.processNewBlocks().catch(async (e: unknown) => {
      this.logger.error('Fatal error occured while processing blocks from node:')
      this.logger.error(ErrorUtils.renderError(e, true))
      await this.stop()
    })
  }

  private onDisconnectRpc = (): void => {
    this.stratum.waitForWork()

    this.logger.info('Disconnected from node unexpectedly. Reconnecting.')

    this.webhooks.map((w) => w.poolDisconnected())
    void this.startConnectingRpc()
  }

  private async processNewBlocks() {
    for await (const payload of this.rpc.blockTemplateStream().contentStream(true)) {
      Assert.isNotUndefined(payload.previousBlockInfo)
      this.restartCalculateTargetInterval()

      const currentHeadTarget = new Target(Buffer.from(payload.previousBlockInfo.target, 'hex'))
      this.currentHeadDifficulty = currentHeadTarget.toDifficulty()
      this.currentHeadTimestamp = payload.previousBlockInfo.timestamp

      this.distributeNewBlock(payload)
    }
  }

  private recalculateTarget() {
    this.logger.debug('recalculating target')

    Assert.isNotNull(this.currentHeadTimestamp)
    Assert.isNotNull(this.currentHeadDifficulty)

    const latestBlock = this.miningRequestBlocks.get(this.nextMiningRequestId - 1)
    Assert.isNotNull(latestBlock)

    const newTime = new Date()
    const newTarget = Target.fromDifficulty(
      Target.calculateDifficulty(
        newTime,
        new Date(this.currentHeadTimestamp),
        this.currentHeadDifficulty,
      ),
    )

    // Target might be the same if there is a slight timing issue or if the block is at max target.
    // In this case, it is detrimental to send out new work as it will needlessly reset miner's search
    // space, resulting in duplicated work.
    const existingTarget = BigIntUtils.fromBytes(Buffer.from(latestBlock.header.target, 'hex'))
    if (newTarget.asBigInt() === existingTarget) {
      this.logger.debug(
        `New target ${newTarget.asBigInt()} is the same as the existing target, no need to send out new work.`,
      )
      return
    }

    latestBlock.header.target = BigIntUtils.toBytesBE(newTarget.asBigInt(), 32).toString('hex')
    latestBlock.header.timestamp = newTime.getTime()
    this.distributeNewBlock(latestBlock)

    this.logger.debug('target recalculated', { prevHash: latestBlock.header.previousBlockHash })
  }

  private distributeNewBlock(newBlock: SerializedBlockTemplate) {
    Assert.isNotNull(this.currentHeadTimestamp)
    Assert.isNotNull(this.currentHeadDifficulty)

    const miningRequestId = this.nextMiningRequestId++
    this.miningRequestBlocks.set(miningRequestId, newBlock)
    this.recentSubmissions.clear()

    this.stratum.newWork(miningRequestId, newBlock)
  }

  private restartCalculateTargetInterval() {
    if (this.recalculateTargetInterval) {
      clearInterval(this.recalculateTargetInterval)
    }

    this.recalculateTargetInterval = setInterval(() => {
      this.recalculateTarget()
    }, RECALCULATE_TARGET_TIMEOUT)
  }

  private isDuplicateSubmission(clientId: number, randomness: string): boolean {
    const submissions = this.recentSubmissions.get(clientId)
    if (submissions == null) {
      return false
    }
    return submissions.includes(randomness)
  }

  private addWorkSubmission(clientId: number, randomness: string): void {
    const submissions = this.recentSubmissions.get(clientId)
    if (submissions == null) {
      this.recentSubmissions.set(clientId, [randomness])
    } else {
      submissions.push(randomness)
      this.recentSubmissions.set(clientId, submissions)
    }
  }

  async estimateHashRate(publicAddress?: string): Promise<number> {
    // BigInt can't contain decimals, so multiply then divide to give decimal precision
    const shareRate = await this.shares.shareRate(publicAddress)
    const decimalPrecision = 1000000
    return (
      Number(BigInt(Math.floor(shareRate * decimalPrecision)) * this.difficulty) /
      decimalPrecision
    )
  }

  async notifyStatus(): Promise<void> {
    const status = await this.getStatus()
    this.logger.debug(`Mining pool status: ${JSON.stringify(status)}`)
    this.webhooks.map((w) => w.poolStatus(status))
  }

  async getStatus(publicAddress?: string): Promise<MiningStatusMessage> {
    const [hashRate, sharesPending] = await Promise.all([
      this.estimateHashRate(),
      this.shares.sharesPendingPayout(),
    ])

    let minerCount = 0
    let addressMinerCount = 0
    for (const client of this.stratum.clients.values()) {
      if (client.subscribed) {
        minerCount++
        if (client.publicAddress === publicAddress) {
          addressMinerCount++
        }
      }
    }

    const status = {
      name: this.name,
      hashRate: hashRate,
      miners: minerCount,
      sharesPending: sharesPending,
      banCount: this.stratum.peers.banCount,
    }

    if (publicAddress) {
      const [addressHashRate, addressSharesPending] = await Promise.all([
        this.estimateHashRate(publicAddress),
        this.shares.sharesPendingPayout(publicAddress),
      ])
      return {
        ...status,
        addressStatus: {
          publicAddress: publicAddress,
          hashRate: addressHashRate,
          miners: addressMinerCount,
          sharesPending: addressSharesPending,
        },
      }
    }

    return status
  }
}
