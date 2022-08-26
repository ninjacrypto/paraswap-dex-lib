import _ from 'lodash';
import { ethers } from 'ethers';
import {
  Token,
  Address,
  ExchangePrices,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import { SwapSide, Network, NULL_ADDRESS } from '../../constants';
import { getBigIntPow, getDexKeysWithNetwork, _require } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { DexParams, SynthetixData } from './types';
import { SimpleExchange } from '../simple-exchange';
import { SynthetixConfig, Adapters } from './config';
import { Interface } from '@ethersproject/abi';
import { MultiWrapper } from '../../lib/multi-wrapper';
import {
  OPTIMISM_STATE_TTL_IN_S,
  SYNTHETIX_GAS_COST_WITHOUT_SUSD,
  SYNTHETIX_GAS_COST_WITH_SUSD,
} from './constants';
import { synthetixMath } from './contract-math/synthetix-math';
import { SynthetixState } from './synthetix-state';
// There are so many ABIs, where I need only one or two functions
// So, I decided to unite them into one combined interface
import CombinedSynthetixABI from '../../abi/synthetix/CombinedSynthetix.abi.json';

export class Synthetix extends SimpleExchange implements IDex<SynthetixData> {
  readonly hasConstantPriceLargeAmounts = false;
  readonly needWrapNative = true;

  readonly combinedIface: Interface;

  readonly multiWrapper: MultiWrapper;

  logger: Logger;

  synthetixState: SynthetixState;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(SynthetixConfig);

  constructor(
    readonly network: Network,
    protected dexKey: string,
    readonly dexHelper: IDexHelper,
    protected adapters = Adapters[network] || {},
    readonly config = SynthetixConfig[dexKey][network],
  ) {
    super(dexHelper.config.data.augustusAddress, dexHelper.web3Provider);
    this.config = this.normalizeConfig(this.config);
    this.logger = dexHelper.getLogger(dexKey);
    this.combinedIface = new Interface(CombinedSynthetixABI);
    this.multiWrapper = new MultiWrapper(
      this.dexHelper.multiContract,
      this.logger,
    );
    this.synthetixState = new SynthetixState(
      this.dexKey,
      this.dexHelper,
      this.multiWrapper,
      this.combinedIface,
      this.config,
    );
  }

  private normalizeConfig(config: DexParams): DexParams {
    return {
      readProxyAddressResolver: config.readProxyAddressResolver.toLowerCase(),
      flexibleStorage: config.flexibleStorage.toLowerCase(),
      synths: config.synths.map(s => {
        s.address = s.address.toLowerCase();
        return s;
      }),
      sUSDAddress: config.sUSDAddress.toLowerCase(),
      trackingCode: config.trackingCode.toLowerCase(),
    };
  }

  get onchainConfigValues() {
    return this.synthetixState.onchainConfigValues;
  }

  async initializePricing(blockNumber: number) {
    await this.synthetixState.updateOnchainConfigValues(blockNumber);
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side] ? this.adapters[side] : null;
  }

  getPoolIdentifier(src: Address, dest: Address) {
    return `${this.dexKey}_${src}_${dest}`.toLowerCase();
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    if (side === SwapSide.BUY) return [];

    const _srcAddress = this.dexHelper.config
      .wrapETH(srcToken)
      .address.toLowerCase();
    const _destAddress = this.dexHelper.config
      .wrapETH(destToken)
      .address.toLowerCase();

    if (_srcAddress === _destAddress) return [];

    if (
      this.onchainConfigValues.addressToKey[_srcAddress] !== undefined &&
      this.onchainConfigValues.addressToKey[_destAddress] !== undefined
    ) {
      return [this.getPoolIdentifier(_srcAddress, _destAddress)];
    }

    return [];
  }

  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<SynthetixData>> {
    try {
      const _srcToken = this.dexHelper.config.wrapETH(srcToken);
      const _destToken = this.dexHelper.config.wrapETH(destToken);

      const _srcAddress = _srcToken.address.toLowerCase();
      const _destAddress = _destToken.address.toLowerCase();

      if (_srcAddress === _destAddress) return null;

      if (
        this.onchainConfigValues.addressToKey[_srcAddress] === undefined ||
        this.onchainConfigValues.addressToKey[_destAddress] === undefined
      )
        return null;

      const currentIdentifier = this.getPoolIdentifier(
        _srcAddress,
        _destAddress,
      );

      // If we received limitPools, but there is not currentIdentifier, we should return null
      // because we don't have that pool to fulfill the request
      if (limitPools !== undefined && !limitPools.includes(currentIdentifier)) {
        return null;
      }

      const unitVolume = getBigIntPow(_srcToken.decimals);

      const _amounts = [unitVolume, ...amounts.slice(1)];

      const isOptimism = this.network === Network.OPTIMISM;

      let state = isOptimism
        ? this.synthetixState.getState(
            undefined,
            Math.floor(Date.now() / 1000) - OPTIMISM_STATE_TTL_IN_S,
          )
        : this.synthetixState.getState(blockNumber);

      if (!state) {
        this.logger.info(
          `${this.dexKey} onchain state update on network=${this.network}`,
        );
        state = await this.synthetixState.getOnchainState(blockNumber);
      }

      if (
        state.isSystemSuspended ||
        state.areSynthsSuspended[_srcAddress] ||
        state.areSynthsSuspended[_destAddress]
      ) {
        return null;
      }

      const prices = _amounts.map(amount =>
        // For there is different pricing logic
        isOptimism
          ? synthetixMath.getAmountsForExchange(
              state!,
              amount,
              this.onchainConfigValues!.addressToKey[_srcAddress],
              this.onchainConfigValues!.addressToKey[_destAddress],
            )
          : synthetixMath.getAmountsForAtomicExchange(
              state!,
              amount,
              this.onchainConfigValues!.addressToKey[_srcAddress],
              this.onchainConfigValues!.addressToKey[_destAddress],
            ),
      );

      const isSUSDInRoute =
        _srcAddress === this.config.sUSDAddress ||
        _destAddress === this.config.sUSDAddress;

      return [
        {
          unit: prices[0],
          prices: [0n, ...prices.slice(1)],
          data: {
            exchange: this.onchainConfigValues.synthetixAddress,
            srcKey: this.onchainConfigValues.addressToKey[_srcAddress],
            destKey: this.onchainConfigValues.addressToKey[_destAddress],
            exchangeType: isOptimism ? 1 : 0,
          },
          poolIdentifier: currentIdentifier,
          exchange: this.dexKey,
          gasCost: isSUSDInRoute
            ? SYNTHETIX_GAS_COST_WITH_SUSD
            : SYNTHETIX_GAS_COST_WITHOUT_SUSD,
          poolAddresses: [this.onchainConfigValues.synthetixAddress],
        },
      ];
    } catch (e) {
      this.logger.error(
        `${this.dexKey} error: getPricesVolume ${
          srcToken.symbol || srcToken.address
        }, ${destToken.symbol || destToken.address}, ${side}: `,
        e,
      );
      return null;
    }
  }

  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: SynthetixData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const { exchange, srcKey, destKey, exchangeType } = data;

    const payload = this.abiCoder.encodeParameter(
      'tuple(bytes32 trackingCode, bytes32 srcCurrencyKey, bytes32 destCurrencyKey, int8 exchangeType)',
      [this.config.trackingCode, srcKey, destKey, exchangeType],
    );

    return {
      targetExchange: exchange,
      payload,
      networkFee: '0',
    };
  }

  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: SynthetixData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    if (side === SwapSide.BUY) throw new Error(`Buy not supported`);

    const { exchange, srcKey, destKey } = data;

    const swapData =
      this.network === Network.OPTIMISM
        ? this.combinedIface.encodeFunctionData('exchange', [
            srcKey,
            srcAmount,
            destKey,
          ])
        : this.combinedIface.encodeFunctionData('exchangeAtomically', [
            srcKey,
            srcAmount,
            destKey,
            this.config.trackingCode,
            '1',
          ]);

    return this.buildSimpleParamWithoutWETHConversion(
      srcToken,
      srcAmount,
      destToken,
      destAmount,
      swapData,
      exchange,
    );
  }

  async updatePoolState(): Promise<void> {
    try {
      this.synthetixState.onchainConfigValues;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.endsWith('onchain config values are not initialized')
      ) {
        await this.initializePricing(
          await this.dexHelper.web3Provider.eth.getBlockNumber(),
        );
      }
    }
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const _tokenAddress = tokenAddress.toLowerCase();

    if (this.onchainConfigValues.addressToKey[_tokenAddress] === undefined) {
      return [];
    }

    return [
      {
        exchange: this.dexKey,
        address: this.onchainConfigValues.synthetixAddress,
        connectorTokens: this.config.synths.filter(
          s => s.address !== _tokenAddress,
        ),
        liquidityUSD: this.onchainConfigValues.liquidityEstimationInUSD,
      },
    ];
  }
}
