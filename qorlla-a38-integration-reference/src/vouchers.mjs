import {createHash,randomBytes} from 'node:crypto';
import {VoiceError} from './policy.mjs';
export const newVoucherPin=()=>randomBytes(18).toString('base64url');
export const hashVoucher=(pin,pepper)=>createHash('sha256').update(`${pepper}:${pin}`).digest('hex');
export async function redeemVoucher({store,principal,pin,pepper,idempotencyKey}){
 if(!principal?.verified||principal.suspended)throw new VoiceError('account_ineligible');
 if(!pepper||pepper.length<32)throw new VoiceError('voucher_config_missing',503);
 if(typeof pin!=='string'||pin.length>128||typeof idempotencyKey!=='string'||idempotencyKey.length<16)throw new VoiceError('invalid_voucher_request',400);
 const digest=hashVoucher(pin,pepper);
 return store.transaction(async tx=>{
  const previous=await tx.findVoucherRedemption(principal.accountId,idempotencyKey);
  if(previous)return previous;
  const voucher=await tx.lockVoucher(digest);
  if(!voucher||voucher.status!=='active'||new Date(voucher.expiresAt)<=new Date())throw new VoiceError('voucher_invalid',400);
  await tx.creditWallet(principal.accountId,voucher.currency,voucher.amountMinor);
  await tx.markVoucherRedeemed(voucher.id,principal.accountId);
  await tx.insertVoucherRedemption(principal.accountId,idempotencyKey,voucher.id);
  await tx.insertOutbox({type:'voucher.redeemed',voucherId:voucher.id});
  return {creditedMinor:voucher.amountMinor,currency:voucher.currency};
 });
}
