export const permissions = ['ticket:read','ticket:create','ticket:assign','billing:refund:request','numbers:read'] as const;
export type Permission = typeof permissions[number];
