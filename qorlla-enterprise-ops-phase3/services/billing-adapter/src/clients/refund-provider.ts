/** Provider contract: no network request until an approved, configured provider is injected. */
export interface RefundProvider { getPayment(paymentId:string):Promise<{customerId:string;currency:string;capturedMinor:number;refundedMinor:number}>; refund(args:{paymentId:string;amountMinor:number;currency:string;idempotencyKey:string}):Promise<{refundId:string;status:'pending'|'succeeded'}>; }
export function requireRefundProvider(provider?:RefundProvider):RefundProvider {if(!provider)throw new Error('BILLING_PROVIDER_UNAVAILABLE');return provider;}
