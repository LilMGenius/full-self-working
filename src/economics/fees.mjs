// Seller net after platform fees, read from the descriptor's fee data. Seller tiers are marginal
// (16.4% of the first 700,000 KRW, 9.4% of the next 1,300,000, ...), the payment-network rate applies
// to the whole amount, and VAT applies to the sum of both fees. A descriptor whose fee field is prose
// ("unknown", a note) has no usable rate, so the call fails instead of treating it as zero.
import { EconomicsError } from './errors.mjs';

function missing(descriptor, path, value) {
  return new EconomicsError(
    'FSW_FEES_MISSING',
    `descriptor ${descriptor?.id ?? '?'} has no numeric fee data at ${path} (got ${JSON.stringify(value)})`,
    { platform: descriptor?.id, path },
  );
}

const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1;

function tierFee(amount, tiers, descriptor) {
  let fee = 0;
  let lower = 0;
  for (const [i, tier] of tiers.entries()) {
    const last = i === tiers.length - 1;
    if (!isRate(tier?.rate)) throw missing(descriptor, `fees.seller[${i}].rate`, tier?.rate);
    const upper = tier.uptoKRW;
    if (upper === null && !last) throw missing(descriptor, `fees.seller[${i}].uptoKRW`, upper);
    if (upper !== null && !(typeof upper === 'number' && upper > lower)) throw missing(descriptor, `fees.seller[${i}].uptoKRW`, upper);
    const top = upper === null ? amount : Math.min(amount, upper);
    if (top > lower) fee += (top - lower) * tier.rate;
    if (upper === null || amount <= upper) return fee;
    lower = upper;
  }
  // The last tier has a finite cap and the amount exceeds it: the descriptor does not say what applies.
  throw missing(descriptor, 'fees.seller (no open-ended last tier)', tiers.at(-1)?.uptoKRW);
}

export function sellerNet(amountKRW, descriptor) {
  if (typeof amountKRW !== 'number' || !Number.isFinite(amountKRW) || amountKRW < 0) {
    throw new TypeError(`sellerNet needs a non-negative amount, got ${amountKRW}`);
  }
  const fees = descriptor?.fees;
  if (fees == null || typeof fees !== 'object') throw missing(descriptor, 'fees', fees);
  let seller;
  if (isRate(fees.seller)) seller = amountKRW * fees.seller;
  else if (Array.isArray(fees.seller) && fees.seller.length) seller = tierFee(amountKRW, fees.seller, descriptor);
  else throw missing(descriptor, 'fees.seller', fees.seller);
  if (!isRate(fees.paymentNetworkRate)) throw missing(descriptor, 'fees.paymentNetworkRate', fees.paymentNetworkRate);
  if (!isRate(fees.vatOnFees)) throw missing(descriptor, 'fees.vatOnFees', fees.vatOnFees);
  const paymentNetwork = amountKRW * fees.paymentNetworkRate;
  const vat = (seller + paymentNetwork) * fees.vatOnFees;
  const total = Math.round(seller + paymentNetwork + vat);
  return {
    gross: amountKRW,
    fees: total,
    net: amountKRW - total,
    effectiveRate: amountKRW === 0 ? 0 : total / amountKRW,
    breakdown: { seller: Math.round(seller), paymentNetwork: Math.round(paymentNetwork), vat: Math.round(vat) },
  };
}
