import {
  Address,
  SimpleExchangeParam,
  AdapterExchangeParam,
  TxInfo,
  NumberAsString,
} from '../types';
import { SwapSide } from '../constants';

export interface IDex<ExchangeData, DirectParam = null> {
  getNetworkFee?(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: ExchangeData,
    side: SwapSide,
  ): NumberAsString;

  // Used for multiSwap, buy & megaSwap
  getAdapterParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString, // required for buy case
    data: ExchangeData,
    side: SwapSide,
    meta?: { network?: number }
  ): AdapterExchangeParam;
  // Used for simpleSwap & simpleBuy
  getSimpleParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: ExchangeData,
    side: SwapSide,
    meta?: { network?: number }
  ): SimpleExchangeParam;
  // Used if there is a possibility for direct swap (Eg. UniswapV2, 0xV2/V4, etc)
  getDirectParam?(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: ExchangeData,
    side: SwapSide,
    meta?: { network?: number }
  ): TxInfo<DirectParam>;
}

export type DexMap = { [identifier: string]: IDex<any, any> };
