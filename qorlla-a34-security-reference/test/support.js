export const classifyDestination = value => typeof value === 'string' && /^[0-9]{3,8}$/.test(value);
