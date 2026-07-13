// ingestion/src/adapters/index.ts
//
// The frozen ADAPTERS registry (CONTRACT §1, §11): Record<VenueCode, VenueAdapter>.
// Every P1 consumer (the runtime factory, worker handlers) imports this map to resolve a
// venue's TaskSpecs. Do NOT rename — it is a frozen value on the contract import surface.
//
// One entry per active venue. BK (Kuwait) is is_active=false in public.venues and is not
// ingested, so it has no adapter and no key here (CONTRACT §0.2).

import type { VenueAdapter, VenueCode } from '../core/types.js';
import { tdwlAdapter } from './tdwl/index.js';
import { dfmAdapter } from './dfm/index.js';
import { adxAdapter } from './adx/index.js';
import { qeAdapter } from './qe/index.js';
import { msxAdapter } from './msx/index.js';
import { bhbAdapter } from './bhb/index.js';

export const ADAPTERS: Record<VenueCode, VenueAdapter> = {
  TDWL: tdwlAdapter,
  DFM: dfmAdapter,
  ADX: adxAdapter,
  QE: qeAdapter,
  MSX: msxAdapter,
  BHB: bhbAdapter,
};

export { tdwlAdapter, dfmAdapter, adxAdapter, qeAdapter, msxAdapter, bhbAdapter };
